'use strict';
// Wave-2 code review, batch A, u7: proton-install-core~22~6, ~23~5, ~24~3,
// ~35~5, ~36~2, ~38~1, the remedy round over src/linux/restore-sweep.js.
// Findings addressed: security 1-2/1-5, architecture 2-4, testing 3-5,
// conformance 4-10/4-11, code-quality 5-5/5-8, reversibility 6-1/6-4.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { restoreSweep } = require('../src/linux/restore-sweep');

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swapper-restore-sweep-remedy-${name}-`));
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

// [test->proton-install-core~23~5] [test->proton-install-core~38~1]
test('a name that is not valid UTF-8, created after the install, is moved into the swept directory and named by its bytes', async (t) => {
  const gameDir = temp(t, 'invalid-utf8-name');
  baseGame(gameDir);
  fs.writeFileSync(Buffer.concat([Buffer.from(gameDir + '/'), Buffer.from([0x61, 0xff])]), 'y');

  const manifest = baseManifest();
  const events = [];
  const result = await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(result, 'restored', 'the restore completes rather than throwing on the decode');
  const moved = events.find(e => e.code === 'linux-restore-sweep' && e.params.rel === 'a\\xff');
  assert.ok(moved, 'the entry is named by its escaped bytes');
  assert.equal(moved.params.outcome, 'moved');
});

// [test->proton-install-core~24~3] [test->proton-install-core~38~1]
test('a per-entry readdir failure inside the executable folder is caught and logged, the sweep does not throw after restoreFiles has run', async (t) => {
  const gameDir = temp(t, 'readdir-fails');
  baseGame(gameDir);
  fs.mkdirSync(path.join(gameDir, 'unreadable'));
  fs.writeFileSync(path.join(gameDir, 'unreadable', 'inner.txt'), 'y');
  fs.chmodSync(path.join(gameDir, 'unreadable'), 0);

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'unreadable', kind: 'dir', mode: 0 }
    ]
  });
  const events = [];
  try {
    const result = await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));
    assert.equal(result, 'restored', 'the sweep never throws after restoreFiles has run');
  } finally {
    fs.chmodSync(path.join(gameDir, 'unreadable'), 0o755);
  }
});

// [test->proton-install-core~22~6] [test->proton-install-core~35~5]
test('an untrusted, non-integer recorded mode is refused rather than handed to fchmod', async (t) => {
  const gameDir = temp(t, 'bad-mode');
  baseGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'shim.dll'), 'yyyy');
  fs.chmodSync(path.join(gameDir, 'shim.dll'), 0o600);
  fs.utimesSync(path.join(gameDir, 'shim.dll'), new Date(1000), new Date(1000));

  const manifest = baseManifest({
    linuxBefore: [
      { rel: 'Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 },
      { rel: 'shim.dll', kind: 'file', mode: 'not-a-mode', size: 4, mtimeMs: 1000 }
    ]
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.statSync(path.join(gameDir, 'shim.dll')).mode & 0o777, 0o600, 'no chmod attempted on an untrusted mode');
  const unmatched = events.find(e => e.params && e.params.rel === 'shim.dll');
  assert.equal(unmatched.params.outcome, 'unmatched');
  assert.equal(unmatched.params.reason, 'invalid-mode', 'refused by the validation itself, not by a downstream throw');
});

// [test->proton-install-core~24~3]
test('addedDirs, reshade.filesAdded and reshade.file are read as added by the withholding pass', async (t) => {
  const gameDir = temp(t, 'reshade-owned');
  baseGame(gameDir);
  fs.symlinkSync('/tmp', path.join(gameDir, 'OptiScaler'));
  fs.symlinkSync('/tmp', path.join(gameDir, 'ReShade64.dll'));

  const manifest = baseManifest({
    addedDirs: ['OptiScaler'],
    reshade: { filesAdded: ['ReShade64.dll'], file: null }
  });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(fs.lstatSync(path.join(gameDir, 'OptiScaler')).isSymbolicLink(), true, 'left in place');
  assert.equal(fs.lstatSync(path.join(gameDir, 'ReShade64.dll')).isSymbolicLink(), true, 'left in place');
  const incomplete = events.find(e => e.code === 'linux-restore-incomplete');
  assert.ok(incomplete, 'linux-restore-incomplete was logged');
  const keptRels = incomplete.params.kept.map(k => k.rel).sort();
  assert.deepEqual(keptRels, ['OptiScaler', 'ReShade64.dll']);
});

// [test->proton-install-core~24~3]
test('linux-restore-incomplete is emitted even where the manifest carries no before-install record', async (t) => {
  const gameDir = temp(t, 'incomplete-no-record');
  baseGame(gameDir);
  const manifest = baseManifest({ added: ['extra.dll'], linuxBefore: undefined });
  const events = [];
  await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  const incomplete = events.find(e => e.code === 'linux-restore-incomplete');
  assert.ok(incomplete, 'linux-restore-incomplete was logged ahead of the no-record return');
  assert.deepEqual(incomplete.params.absent, [{ rel: 'extra.dll', backup: null }]);
  const noRecord = events.find(e => e.code === 'linux-restore-no-record');
  assert.ok(noRecord, 'linux-restore-no-record still follows');
});

// [test->proton-install-core~36~2]
test('the lookup reads rel relative to the game folder: an executable two directories down restores without sweeping the executable folder', async (t) => {
  const gameDir = temp(t, 'nested-exe');
  fs.mkdirSync(path.join(gameDir, 'sub', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'sub', 'dir', 'Game.exe'), 'x'.repeat(62));
  fs.chmodSync(path.join(gameDir, 'sub', 'dir', 'Game.exe'), 0o644);
  fs.utimesSync(path.join(gameDir, 'sub', 'dir', 'Game.exe'), new Date(1789862400000), new Date(1789862400000));
  fs.mkdirSync(path.join(gameDir, '_DLSS5_Backup'));

  const manifest = baseManifest({
    game: { exe: 'sub/dir/Game.exe' },
    linuxBefore: [
      { rel: 'sub/dir/Game.exe', kind: 'file', mode: 420, size: 62, mtimeMs: 1789862400000 }
    ]
  });
  const events = [];
  const result = await restoreSweep(noopRestoreFiles, gameDir, manifest, (e) => events.push(e));

  assert.equal(result, 'restored');
  assert.equal(fs.existsSync(path.join(gameDir, 'sub', 'dir', 'Game.exe')), true, 'not swept away as unlisted');
  const sweptAway = events.find(e => e.code === 'linux-restore-sweep' && e.params.outcome === 'moved');
  assert.equal(sweptAway, undefined, 'the executable folder is not itself swept as an unlisted entry of the game folder');
});
