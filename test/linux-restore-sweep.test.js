'use strict';
// proton-install-core~22~6, ~23~5, ~24~3, ~35~5, ~36~2, ~38~1: the restore
// sweep hook at src/core/apply.js:959, Annex D's Restore row and Annex C's
// Record rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { restoreSweep } = require('../src/linux/restore-sweep');

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swapper-restore-sweep-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseGame(gameDir) {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'Game.exe'), 'x'.repeat(62));
  fs.chmodSync(path.join(gameDir, 'Game.exe'), 0o644);
  fs.utimesSync(path.join(gameDir, 'Game.exe'), new Date(1789862400000), new Date(1789862400000));
  fs.mkdirSync(path.join(gameDir, '_DLSS5_Backup'), { recursive: true });
}

function baseManifest(overrides) {
  return Object.assign({
    version: 1,
    game: { exe: 'Game.exe' },
    replaced: [],
    added: [],
    addedDirs: [],
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 }
    ]
  }, overrides);
}

const noopRestoreFiles = async () => 'restored';

// [test->proton-install-core~36~2]
test('the sweep opens no path taken from the record: a phantom entry naming a path outside the tree is never touched', async (t) => {
  const gameDir = temp(t, 'phantom-outside');
  baseGame(gameDir);
  const outsideDir = path.join(gameDir, '..', 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'f'), 'y');
  fs.chmodSync(path.join(outsideDir, 'f'), 0o600);
  const openSpy = [];
  const originalOpenSync = fs.openSync;
  fs.openSync = (p, ...rest) => { openSpy.push(Buffer.isBuffer(p) ? p.toString('utf8') : p); return originalOpenSync(p, ...rest); };
  t.after(() => { fs.openSync = originalOpenSync; fs.rmSync(outsideDir, { recursive: true, force: true }); });

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: '../outside/f', kind: 'file', mode: 420 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal((fs.statSync(path.join(outsideDir, 'f')).mode & 0o777), 0o600, 'the phantom record entry was never opened or chmoded');
  assert.ok(!openSpy.some(p => path.resolve(p) === path.resolve(path.join(outsideDir, 'f'))));
  const gone = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === '../outside/f');
  assert.equal(gone.params.outcome, 'gone');
});

// [test->proton-install-core~23~5]
test('an unlisted file under the executable folder moves into the swept directory, keeping its path', async (t) => {
  const gameDir = temp(t, 'unlisted');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'shader.cache'), 'cache-bytes');

  const manifest = baseManifest();
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.existsSync(path.join(gameDir, 'shader.cache')), false);
  const moved = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === 'shader.cache');
  assert.equal(moved.params.outcome, 'moved');
  assert.match(moved.params.to, /^_DLSS5_Backup\/swept\/[0-9a-f-]+\/shader\.cache$/);
  assert.equal(fs.existsSync(path.join(gameDir, moved.params.to)), true);
});

// [test->proton-install-core~23~5]
test('an unlisted directory moves whole into the swept directory, its children not visited separately', async (t) => {
  const gameDir = temp(t, 'unlisted-dir');
  baseGame(gameDir);
  fs.mkdirSync(path.join(gameDir, 'data'));
  fs.writeFileSync(path.join(gameDir, 'data', 'shader.cache'), 'cache-bytes');

  const manifest = baseManifest();
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.existsSync(path.join(gameDir, 'data')), false);
  const moved = events.filter(e => e.code === 'linux-restore-sweep');
  assert.equal(moved.length, 1, 'the directory moves whole; its child is never visited on its own');
  assert.equal(moved[0].params.rel, 'data');
  assert.equal(moved[0].params.outcome, 'moved');
  assert.equal(fs.existsSync(path.join(gameDir, moved[0].params.to, 'shader.cache')), true);
});

// [test->proton-install-core~23~5]
test('a planted link at swept refuses every move it would otherwise make and names the reason', async (t) => {
  const gameDir = temp(t, 'swept-link');
  baseGame(gameDir);
  fs.symlinkSync('/tmp', path.join(gameDir, '_DLSS5_Backup', 'swept'));
  fs.writeFileSync(path.join(gameDir, 'stray.txt'), 'y');

  const manifest = baseManifest();
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.existsSync(path.join(gameDir, 'stray.txt')), true, 'left in place');
  const failed = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === 'stray.txt');
  assert.equal(failed.params.outcome, 'move-failed');
  assert.equal(failed.params.reason, 'ENOTDIR');
});

// [test->proton-install-core~24~3]
test('a file the install placed that is absent when the restore reaches it reports the restore incomplete', async (t) => {
  const gameDir = temp(t, 'placed-absent');
  baseGame(gameDir);
  const manifest = baseManifest({ added: ['extra.dll'] });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  const incomplete = events.find(e => e.code === 'linux-restore-incomplete');
  assert.ok(incomplete, 'linux-restore-incomplete was logged');
  assert.deepEqual(incomplete.params.absent, [{ rel: 'extra.dll', backup: null }]);
});

// [test->proton-install-core~24~3]
test('a directory standing at a replaced path keeps the backup and reports incomplete, naming the backup path', async (t) => {
  const gameDir = temp(t, 'dir-at-replaced');
  baseGame(gameDir);
  fs.mkdirSync(path.join(gameDir, '_DLSS5_Backup', 'originals', 'dxgi.dll'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, '_DLSS5_Backup', 'originals', 'dxgi.dll', 'placeholder'), 'x');
  fs.mkdirSync(path.join(gameDir, 'dxgi.dll'));

  const manifest = baseManifest({
    backupPrefix: 'originals',
    replaced: [{ rel: 'dxgi.dll' }]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.statSync(path.join(gameDir, 'dxgi.dll')).isDirectory(), true, 'the directory is left where it is');
  const incomplete = events.find(e => e.code === 'linux-restore-incomplete');
  assert.deepEqual(incomplete.params.kept, [{ rel: 'dxgi.dll', backup: '_DLSS5_Backup/originals/dxgi.dll' }]);
  assert.deepEqual(incomplete.params.absent, []);
});

// [test->proton-install-core~24~3]
test('a symbolic link above a placed path inside the executable folder keeps the link and reports incomplete', async (t) => {
  const gameDir = temp(t, 'link-above');
  baseGame(gameDir);
  const realSub = path.join(gameDir, 'real-sub');
  fs.mkdirSync(realSub);
  fs.symlinkSync(realSub, path.join(gameDir, 'sub'));

  const manifest = baseManifest({ added: ['sub/extra.dll'] });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.lstatSync(path.join(gameDir, 'sub')).isSymbolicLink(), true);
  const incomplete = events.find(e => e.code === 'linux-restore-incomplete');
  assert.deepEqual(incomplete.params.kept, [{ rel: 'sub/extra.dll', backup: null }]);
  assert.deepEqual(incomplete.params.absent, []);
});

// [test->proton-install-core~35~5]
test('a listed file that has gone missing is named gone and left', async (t) => {
  const gameDir = temp(t, 'listed-gone');
  baseGame(gameDir);
  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'data.bin', kind: 'file', mode: 420, size: 5, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  const gone = events.find(e => e.params && e.params.rel === 'data.bin');
  assert.equal(gone.params.outcome, 'gone');
});

// [test->proton-install-core~35~5]
test('a listed file changed by size is named changed and left, mode untouched', async (t) => {
  const gameDir = temp(t, 'changed-size');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'shader.cache'), 'abc');
  fs.chmodSync(path.join(gameDir, 'shader.cache'), 0o600);
  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'shader.cache', kind: 'file', mode: 420, size: 999, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  const changed = events.find(e => e.params && e.params.rel === 'shader.cache');
  assert.equal(changed.params.outcome, 'changed');
  assert.equal(fs.statSync(path.join(gameDir, 'shader.cache')).mode & 0o777, 0o600, 'no chmod attempted');
});

// [test->proton-install-core~35~5]
test('a listed file changed by modification time is named changed and left', async (t) => {
  const gameDir = temp(t, 'changed-time');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'shader.cache'), 'abcde');
  fs.utimesSync(path.join(gameDir, 'shader.cache'), new Date(5000), new Date(5000));
  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'shader.cache', kind: 'file', mode: 420, size: 5, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  const changed = events.find(e => e.params && e.params.rel === 'shader.cache');
  assert.equal(changed.params.outcome, 'changed');
});

// [test->proton-install-core~35~5]
test('a recorded directory found as a link is named kind, left, no chmod', async (t) => {
  const gameDir = temp(t, 'dir-as-link');
  baseGame(gameDir);
  fs.mkdirSync(path.join(gameDir, 'elsewhere'));
  fs.symlinkSync(path.join(gameDir, 'elsewhere'), path.join(gameDir, 'data'));
  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'data', kind: 'dir', mode: 493 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  const kind = events.find(e => e.params && e.params.rel === 'data');
  assert.equal(kind.params.outcome, 'kind');
  assert.equal(kind.params.found, 'link');
});

// [test->proton-install-core~35~5]
test('a directory found where a recorded file was is named kind with the kind the walk met', async (t) => {
  const gameDir = temp(t, 'file-as-dir');
  baseGame(gameDir);
  fs.mkdirSync(path.join(gameDir, 'shim.dll'));
  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'shim.dll', kind: 'file', mode: 420, size: 4, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  const kind = events.find(e => e.params && e.params.rel === 'shim.dll');
  assert.equal(kind.params.outcome, 'kind');
  assert.equal(kind.params.found, 'dir');
});

// [test->proton-install-core~22~6] [test->proton-install-core~35~5]
test('a recorded file hard-linked to a file outside the executable folder is left with no mode change, named', async (t) => {
  const gameDir = temp(t, 'hard-link');
  baseGame(gameDir);
  const outside = temp(t, 'hard-link-outside');
  fs.writeFileSync(path.join(outside, 'shared'), 'zzzz');
  fs.chmodSync(path.join(outside, 'shared'), 0o600);
  fs.linkSync(path.join(outside, 'shared'), path.join(gameDir, 'shared.dll'));
  fs.utimesSync(path.join(gameDir, 'shared.dll'), new Date(1000), new Date(1000));

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'shared.dll', kind: 'file', mode: 420, size: 4, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.statSync(path.join(gameDir, 'shared.dll')).mode & 0o777, 0o600, 'mode unchanged on the hard-linked file');
  assert.equal(fs.statSync(path.join(outside, 'shared')).mode & 0o777, 0o600, 'the file outside the tree is untouched');
  const unmatched = events.find(e => e.params && e.params.rel === 'shared.dll');
  assert.equal(unmatched.params.outcome, 'unmatched');
  assert.ok(unmatched.params.reason, 'a reason is carried');
});

// [test->proton-install-core~22~6] [test->proton-install-core~35~5]
test('a recorded file swapped for a link before the open is left with no mode change, named unmatched', async (t) => {
  const gameDir = temp(t, 'swap-for-link');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'swap.dll'), 'zzzz');
  fs.chmodSync(path.join(gameDir, 'swap.dll'), 0o600);
  fs.utimesSync(path.join(gameDir, 'swap.dll'), new Date(1000), new Date(1000));

  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = (p, ...rest) => {
    const stat = originalLstatSync(p, ...rest);
    const pStr = Buffer.isBuffer(p) ? p.toString('utf8') : p;
    if (!swapped && typeof pStr === 'string' && path.resolve(pStr) === path.resolve(path.join(gameDir, 'swap.dll')) && stat.isFile()) {
      swapped = true;
      fs.unlinkSync(pStr);
      fs.symlinkSync('/nonexistent-target', pStr);
    }
    return stat;
  };
  t.after(() => { fs.lstatSync = originalLstatSync; });

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'swap.dll', kind: 'file', mode: 420, size: 4, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  const unmatched = events.find(e => e.params && e.params.rel === 'swap.dll');
  assert.equal(unmatched.params.outcome, 'unmatched');
  assert.ok(unmatched.params.reason, 'a reason is carried');
});

// [test->proton-install-core~22~6]
test('a recorded subdirectory at mode 0700 is restored to 0755 and named in the log', async (t) => {
  const gameDir = temp(t, 'dir-mode');
  baseGame(gameDir);
  fs.mkdirSync(path.join(gameDir, 'data'));
  fs.chmodSync(path.join(gameDir, 'data'), 0o700);

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'data', kind: 'dir', mode: 493 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.statSync(path.join(gameDir, 'data')).mode & 0o777, 0o755);
  assert.equal(events.some(e => e.code === 'linux-restore-sweep' && e.params.rel === 'data'), false, 'no event where nothing to report; the mode change alone is not named');
});

// [test->proton-install-core~38~1]
test('a move rejected with EXDEV is named with that reason and left in place', async (t) => {
  const gameDir = temp(t, 'exdev');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'stray.txt'), 'y');

  const originalRename = fs.promises.rename;
  fs.promises.rename = async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
  t.after(() => { fs.promises.rename = originalRename; });

  const manifest = baseManifest();
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.existsSync(path.join(gameDir, 'stray.txt')), true);
  const failed = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === 'stray.txt');
  assert.equal(failed.params.outcome, 'move-failed');
  assert.equal(failed.params.reason, 'EXDEV');
});

// [test->proton-install-core~38~1]
test('a move rejected with ENOTEMPTY is named with that reason and left in place', async (t) => {
  const gameDir = temp(t, 'enotempty');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'stray.txt'), 'y');

  const originalRename = fs.promises.rename;
  fs.promises.rename = async () => { throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }); };
  t.after(() => { fs.promises.rename = originalRename; });

  const manifest = baseManifest();
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.existsSync(path.join(gameDir, 'stray.txt')), true);
  const failed = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === 'stray.txt');
  assert.equal(failed.params.outcome, 'move-failed');
  assert.equal(failed.params.reason, 'ENOTEMPTY');
});

// [test->proton-install-core~38~1]
test('a plain file at swept fails every move under it with ENOTDIR, named, and the restore completes otherwise', async (t) => {
  const gameDir = temp(t, 'swept-plain-file');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, '_DLSS5_Backup', 'swept'), 'not a directory');
  fs.writeFileSync(path.join(gameDir, 'stray.txt'), 'y');
  fs.writeFileSync(path.join(gameDir, 'another.txt'), 'z');

  const manifest = baseManifest();
  const events = [];
  const result = await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(result, 'restored', 'the restore completes otherwise');
  for (const rel of ['stray.txt', 'another.txt']) {
    const failed = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === rel);
    assert.equal(failed.params.outcome, 'move-failed');
    assert.equal(failed.params.reason, 'ENOTDIR');
    assert.equal(fs.existsSync(path.join(gameDir, rel)), true);
  }
});

// [test->proton-install-core~38~1]
test('a fixture file named Game.exe:4 restores without incident', async (t) => {
  const gameDir = temp(t, 'colon-name');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'Game.exe:4'), 'colon-stream');

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'Game.exe:4', kind: 'file', mode: 420, size: 12, mtimeMs: Math.floor(fs.statSync(path.join(gameDir, 'Game.exe:4')).mtimeMs) }
    ]
  });
  const events = [];
  const result = await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
  assert.equal(result, 'restored');
  assert.equal(fs.existsSync(path.join(gameDir, 'Game.exe:4')), true);
});

