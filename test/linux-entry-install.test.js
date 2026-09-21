'use strict';
// installEntry, src/core/backend-manager.js:130's optiscaler-branch hook. On
// Linux it records the before-install record before its first write
// (proton-install-core~34~4, ~39~3), re-runs the running-game guard before
// its first write outside the backup directory (proton-install-core~37~1),
// places the entry's files inside the game folder and never into a Proton
// prefix (proton-install-core~6~1, ~16~2), and emits the launch-options
// event once they are placed (proton-install-core~11~5). Review remedy A
// (step8-remedy-a.md): the copy step places every file through the
// caller's own injected placeTracked (upstream's journal-captured tracked
// copy), never fs.copyFileSync, refuses a link planted at a placement path
// or a mismatched release digest before any write, writes the record's
// `rel` relative to the game folder, and sets OptiScaler.ini's keys.
Object.defineProperty(process, 'platform', { value: 'linux' });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { installEntry } = require('../src/linux/entry-install');
const apply = require('../src/core/apply');

const temp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `entry-install-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeFixtureRelease(releaseDir, name, content) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const file = path.join(releaseDir, name);
  fs.writeFileSync(file, content);
  return { path: file, digest: sha256(content), bytes: content.length };
}

function baseManifest(gameDir, exePath) {
  return apply.beginManifest(gameDir, exePath, 'dxgi');
}

function fixtureEntry(placement, launchOptions = 'none', extra = {}) {
  return { id: 'FIX', route: 'optiscaler', placement, launchOptions, ...extra };
}

function noopGuard() { return async () => {}; }

// Upstream's own tracked copy, the injected placeTracked production would
// hand in: journal-captured, case-aware, mode-hooked, manifest-saving.
const realPlaceTracked = apply.copyTracked;

test('installEntry off Linux hands optiscaler.install what it was given, unchanged', async (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));
  const original = require('../src/core/optiscaler').install;
  const optiscaler = require('../src/core/optiscaler');
  let seen;
  optiscaler.install = async (config, log) => { seen = { config, logIsFunction: typeof log === 'function' }; return { ok: true }; };
  t.after(() => { optiscaler.install = original; });
  const log = () => {};
  const result = await installEntry({ gameDir: '/g', exePath: '/g/Game.exe', ensuredRoot: '/e', log });
  assert.deepEqual(seen.config, { gameDir: '/g', exePath: '/g/Game.exe' });
  assert.equal(seen.logIsFunction, true);
  assert.deepEqual(result, { ok: true });
});

// [test->proton-install-core~6~1]
test('installEntry writes nothing under a fixture prefix outside the game folder', async (t) => {
  const dir = temp(t, 'prefix');
  const gameDir = path.join(dir, 'game');
  const prefix = path.join(dir, 'compatdata', '990080', 'pfx');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('fixture-dll-bytes'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  const events = [];
  await installEntry({
    gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked,
    log: (e) => events.push(e)
  });
  assert.deepEqual(fs.readdirSync(prefix), []);
  assert.equal(fs.readFileSync(path.join(gameDir, 'd3dcompiler_47.dll'), 'utf8'), 'fixture-dll-bytes');
});

// [test->proton-install-core~11~5]
test('installEntry emits linux-launch-options once, with the entry and the cell, after the files are placed', async (t) => {
  const dir = temp(t, 'launch-options');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('bytes'));
  const entry = fixtureEntry(
    [{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }],
    'none'
  );
  const manifest = baseManifest(gameDir, exePath);
  const events = [];
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: (e) => events.push(e) });
  const launchEvents = events.filter((e) => e.code === 'linux-launch-options');
  assert.equal(launchEvents.length, 1);
  assert.deepEqual(launchEvents[0].params, { entry: 'FIX', cell: 'none' });
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), true, 'files are placed before the event fires');

  const overrideEntry = fixtureEntry(
    [{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }],
    'WINEDLLOVERRIDES="dxgi=n,b"'
  );
  const dir2 = temp(t, 'launch-options-override');
  const gameDir2 = path.join(dir2, 'game');
  fs.mkdirSync(gameDir2, { recursive: true });
  const exePath2 = path.join(gameDir2, 'Game.exe');
  fs.writeFileSync(exePath2, 'game');
  const manifest2 = baseManifest(gameDir2, exePath2);
  const events2 = [];
  await installEntry({ gameDir: gameDir2, exePath: exePath2, entry: overrideEntry, releaseDir, manifest: manifest2, guard: noopGuard(), placeTracked: realPlaceTracked, log: (e) => events2.push(e) });
  const launch2 = events2.filter((e) => e.code === 'linux-launch-options');
  assert.equal(launch2.length, 1);
  assert.deepEqual(launch2[0].params, { entry: 'FIX', cell: 'WINEDLLOVERRIDES="dxgi=n,b"' });
});

// [test->proton-install-core~16~2]
test('installEntry places d3dcompiler_47.dll from the fixture release directory at its entry-injected version and digest, and refuses before writing when the digest does not match', async (t) => {
  const dir = temp(t, 'compiler');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const content = Buffer.from('fixture-compiler-payload');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', content);
  const entry = fixtureEntry([{
    member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll',
    sha256: dll.digest, bytes: dll.bytes, source: 'release', fileVersion: '10.0.22621.2428'
  }]);
  const manifest = baseManifest(gameDir, exePath);
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} });
  const placed = fs.readFileSync(path.join(gameDir, 'd3dcompiler_47.dll'));
  assert.equal(sha256(placed), dll.digest);
  assert.equal(placed.length, dll.bytes);

  // [test->proton-install-core~16~2]
  const dir2 = temp(t, 'compiler-mismatch');
  const gameDir2 = path.join(dir2, 'game');
  fs.mkdirSync(gameDir2, { recursive: true });
  const exePath2 = path.join(gameDir2, 'Game.exe');
  fs.writeFileSync(exePath2, 'game');
  const mismatchEntry = fixtureEntry([{
    member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll',
    sha256: 'f'.repeat(64), bytes: dll.bytes, source: 'release'
  }]);
  const manifest2 = baseManifest(gameDir2, exePath2);
  let writeCalled = false;
  const spyPlaceTracked = async (...args) => { writeCalled = true; return realPlaceTracked(...args); };
  await assert.rejects(
    () => installEntry({ gameDir: gameDir2, exePath: exePath2, entry: mismatchEntry, releaseDir, manifest: manifest2, guard: noopGuard(), placeTracked: spyPlaceTracked, log: () => {} }),
    (error) => { assert.match(error.message, /SHA-256|sha256|digest/i); return true; }
  );
  assert.equal(writeCalled, false, 'the mismatch is caught before any write');
  assert.equal(fs.existsSync(path.join(gameDir2, 'd3dcompiler_47.dll')), false);
});

// [test->proton-install-core~34~4]
test('installEntry refuses past an injected bound, naming the count, and writes nothing outside the backup directory', async (t) => {
  const dir = temp(t, 'bound');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(gameDir, `extra-${i}.dat`), String(i));
  // Game.exe plus 9 extras = 10 entries outside the backup directory.
  assert.equal(fs.readdirSync(gameDir).length, 10);

  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  const events = [];
  await assert.rejects(
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, bound: 3, log: (e) => events.push(e) }),
    (error) => { assert.match(error.message, /4/); return true; }
  );
  assert.equal(events.some((e) => e.code === 'linux-record-written'), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), false);
  assert.deepEqual(fs.readdirSync(gameDir).filter((n) => n === '_DLSS5_Backup'), fs.existsSync(path.join(gameDir, '_DLSS5_Backup')) ? ['_DLSS5_Backup'] : []);
  for (let i = 0; i < 9; i++) assert.equal(fs.existsSync(path.join(gameDir, `extra-${i}.dat`)), true);
});

// [test->proton-install-core~37~1]
test('installEntry runs the guard again after the record is written, before the first write, and refuses when that call throws', async (t) => {
  const dir = temp(t, 'guard');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);

  // Pass 1: the guard admits, so the install proceeds and places the file.
  const manifest = baseManifest(gameDir, exePath);
  let calls = 0;
  const guard = async () => { calls += 1; };
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard, placeTracked: realPlaceTracked, log: () => {} });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), true);

  // Pass 2: a second call, simulating the check made before install started,
  // then the second call from installEntry itself throws, so the install
  // refuses and writes nothing.
  const dir2 = temp(t, 'guard-refuse');
  const gameDir2 = path.join(dir2, 'game');
  fs.mkdirSync(gameDir2, { recursive: true });
  const exePath2 = path.join(gameDir2, 'Game.exe');
  fs.writeFileSync(exePath2, 'game');
  const manifest2 = baseManifest(gameDir2, exePath2);
  let guardCalls = 0;
  const refusingGuard = async () => {
    guardCalls += 1;
    if (guardCalls === 2) throw Object.assign(new Error('Close the game first.'), { code: 'errGameRunning' });
  };
  await refusingGuard(); // the check the test stands in for, made before install started, call 1
  await assert.rejects(
    () => installEntry({ gameDir: gameDir2, exePath: exePath2, entry, releaseDir, manifest: manifest2, guard: refusingGuard, placeTracked: realPlaceTracked, log: () => {} }),
    { code: 'errGameRunning' }
  );
  assert.equal(guardCalls, 2);
  assert.equal(fs.existsSync(path.join(gameDir2, 'd3dcompiler_47.dll')), false);
});

test('installEntry defaults the guard to the barrel\'s assertGameClosed when none is handed in', async (t) => {
  const dir = temp(t, 'guard-default');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  const barrel = require('../src/linux');
  const original = barrel.assertGameClosed;
  let called = 0;
  barrel.assertGameClosed = async () => { called += 1; };
  t.after(() => { barrel.assertGameClosed = original; });
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, placeTracked: realPlaceTracked, log: () => {} });
  assert.equal(called, 1);
});

// [test->proton-install-core~39~3]
test('installEntry refuses an invalid-UTF-8 entry name, naming its escaped bytes, and writes nothing outside the backup directory', async (t) => {
  const dir = temp(t, 'invalid-name');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const badName = Buffer.concat([Buffer.from(gameDir + path.sep), Buffer.from([0x61, 0xff, 0x62])]);
  fs.writeFileSync(badName, 'bad-name-file');

  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  await assert.rejects(
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} }),
    (error) => { assert.match(error.message, /\\xff/); return true; }
  );
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), false);
});

// ADR-014's safeguard: a manifest already written under the backup directory
// refuses inside the transaction, before any write, naming it; not tied to a
// numbered criterion of this unit, ~40~3 being the route gate's own refusal
// before the transaction opens.
test('installEntry refuses inside the transaction, before any write, when a manifest already exists under the backup directory', async (t) => {
  const dir = temp(t, 'live-manifest');
  const gameDir = path.join(dir, 'game');
  const backupDir = path.join(gameDir, '_DLSS5_Backup');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ version: 1, route: 'optiscaler', date: '2026-09-20T00:00:00.000Z' }));
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  await assert.rejects(
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} }),
    (error) => { assert.match(error.message, /manifest/i); return true; }
  );
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), false);

  // With none present the install proceeds.
  const dir2 = temp(t, 'no-manifest');
  const gameDir2 = path.join(dir2, 'game');
  fs.mkdirSync(gameDir2, { recursive: true });
  const exePath2 = path.join(gameDir2, 'Game.exe');
  fs.writeFileSync(exePath2, 'game');
  const manifest2 = baseManifest(gameDir2, exePath2);
  await installEntry({ gameDir: gameDir2, exePath: exePath2, entry, releaseDir, manifest: manifest2, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} });
  assert.equal(fs.existsSync(path.join(gameDir2, 'd3dcompiler_47.dll')), true);
});

// Review remedy, security finding 1: a symbolic link planted at a placement
// path, or at an intermediate component of one, refuses before any write.
test('installEntry refuses a link planted at a placement path, before any write, naming the path', async (t) => {
  const dir = temp(t, 'link-placement');
  const gameDir = path.join(dir, 'game');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  // A dangling link at the placement path itself: existsSync is false, so a
  // check based on existence alone would miss it and copy through the link.
  fs.symlinkSync(path.join(outside, 'planted.dll'), path.join(gameDir, 'd3dcompiler_47.dll'));

  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  await assert.rejects(
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} }),
    (error) => { assert.match(error.message, /symbolic link/i); assert.match(error.message, /d3dcompiler_47\.dll/); return true; }
  );
  assert.equal(fs.existsSync(path.join(outside, 'planted.dll')), false, 'nothing was written through the link');

  // A link at an intermediate directory component also refuses.
  const dir2 = temp(t, 'link-component');
  const gameDir2 = path.join(dir2, 'game');
  const outsideDir2 = path.join(dir2, 'outside-dir');
  fs.mkdirSync(gameDir2, { recursive: true });
  fs.mkdirSync(outsideDir2, { recursive: true });
  const exePath2 = path.join(gameDir2, 'Game.exe');
  fs.writeFileSync(exePath2, 'game');
  fs.symlinkSync(outsideDir2, path.join(gameDir2, 'OptiScaler'));
  const nestedEntry = fixtureEntry([{ member: 'x.dll', placedAs: 'OptiScaler/x.dll', sha256: sha256(Buffer.from('x')), bytes: 1, source: 'release' }]);
  const releaseDir2 = path.join(dir2, 'release');
  writeFixtureRelease(releaseDir2, 'x.dll', Buffer.from('x'));
  const manifest2 = baseManifest(gameDir2, exePath2);
  await assert.rejects(
    () => installEntry({ gameDir: gameDir2, exePath: exePath2, entry: nestedEntry, releaseDir: releaseDir2, manifest: manifest2, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} }),
    (error) => { assert.match(error.message, /symbolic link/i); assert.match(error.message, /OptiScaler/); return true; }
  );
  assert.deepEqual(fs.readdirSync(outsideDir2), []);
});

// Review remedy, conformance finding 4-6: OptiScaler.ini's keys, read from
// entry.iniKeys, are set once the ini is placed, including the
// executable-name substitution for a value of null.
test('installEntry sets the placed ini\'s keys from entry.iniKeys, substituting the executable name', async (t) => {
  const dir = temp(t, 'ini-keys');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'HogwartsLegacy.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const iniContent = '[DlssNr]\nEnabled=false\nToggleKey=0x00\n[ProcessFilter]\nTargetProcessName=\n';
  writeFixtureRelease(releaseDir, 'OptiScaler.ini', Buffer.from(iniContent));
  const entry = fixtureEntry(
    [{ member: 'OptiScaler.ini', placedAs: 'OptiScaler.ini', sha256: sha256(Buffer.from(iniContent)), bytes: iniContent.length, source: 'release' }],
    'none',
    {
      iniKeys: [
        { section: 'DlssNr', key: 'Enabled', value: 'true' },
        { section: 'DlssNr', key: 'ToggleKey', value: '0x78' },
        { section: 'Log', key: 'LogToFile', value: 'true' },
        { section: 'Log', key: 'LogLevel', value: '2' },
        { section: 'Upscalers', key: 'Dx12Upscaler', value: 'dlss' },
        { section: 'Spoofing', key: 'Dxgi', value: 'false' },
        { section: 'Plugins', key: 'LoadAsiPlugins', value: 'false' },
        { section: 'ProcessFilter', key: 'TargetProcessName', value: null }
      ]
    }
  );
  const manifest = baseManifest(gameDir, exePath);
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} });
  const written = fs.readFileSync(path.join(gameDir, 'OptiScaler.ini'), 'utf8');
  assert.match(written, /\[DlssNr\][\s\S]*Enabled=true/);
  assert.match(written, /ToggleKey=0x78/);
  assert.match(written, /\[Log\][\s\S]*LogToFile=true/);
  assert.match(written, /LogLevel=2/);
  assert.match(written, /\[Upscalers\][\s\S]*Dx12Upscaler=dlss/);
  assert.match(written, /\[Spoofing\][\s\S]*Dxgi=false/);
  assert.match(written, /\[Plugins\][\s\S]*LoadAsiPlugins=false/);
  assert.match(written, /\[ProcessFilter\][\s\S]*TargetProcessName=HogwartsLegacy\.exe/);
});

// Review remedy, conformance/reversibility findings 4-4 and 6-1: the
// before-install record's rel is relative to the game folder, not the
// executable folder, so the record and the restore sweep (which reads rel
// against the game folder) agree for a game whose executable sits below
// the game root.
test('installEntry\'s before-install record writes rel relative to the game folder, for an executable folder two directories down', async (t) => {
  const dir = temp(t, 'nested-exe');
  const gameDir = path.join(dir, 'game');
  const exeDir = path.join(gameDir, 'sub', 'dir');
  const fixtureTree = path.resolve(__dirname, 'fixtures', 'linux-before-record', 'tree');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.cpSync(fixtureTree, exeDir, { recursive: true });
  const recorded = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'linux-before-record', 'record.json'), 'utf8'));
  for (const item of recorded) {
    const abs = path.join(exeDir, ...item.rel.split('/'));
    fs.chmodSync(abs, item.mode);
    if (item.mtimeMs !== undefined) fs.utimesSync(abs, new Date(item.mtimeMs), new Date(item.mtimeMs));
  }
  const expected = recorded.map((item) => ({ ...item, rel: `sub/dir/${item.rel}` }));

  const exePath = path.join(exeDir, 'Game.exe');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: realPlaceTracked, log: () => {} });
  const byRel = (a, b) => a.rel.localeCompare(b.rel);
  assert.deepEqual([...manifest.linuxBefore].sort(byRel), [...expected].sort(byRel));
});

// Review remedy, architecture/code-quality/reversibility findings (2-3,
// 5-2, 6-3): every placement goes through the caller's injected
// placeTracked, never fs.copyFileSync, so a spy sees one call per row.
test('installEntry places every file through the injected placeTracked, never copyFileSync directly', async (t) => {
  const dir = temp(t, 'place-tracked');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const nvngx = writeFixtureRelease(releaseDir, 'nvngx.dll_dlssnr.dll', Buffer.from('y'));
  const entry = fixtureEntry([
    { member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' },
    { member: 'nvngx.dll_dlssnr.dll', placedAs: 'nvngx.dll_dlssnr.dll', sha256: nvngx.digest, bytes: nvngx.bytes, source: 'release' }
  ]);
  const manifest = baseManifest(gameDir, exePath);
  const calls = [];
  const spyPlaceTracked = async (m, gd, src, dest, meta) => {
    calls.push({ src, dest, meta });
    return realPlaceTracked(m, gd, src, dest, meta);
  };
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), placeTracked: spyPlaceTracked, log: () => {} });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.dest).sort(), [
    path.join(gameDir, 'd3dcompiler_47.dll'),
    path.join(gameDir, 'nvngx.dll_dlssnr.dll')
  ].sort());
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), true);
  assert.equal(fs.existsSync(path.join(gameDir, 'nvngx.dll_dlssnr.dll')), true);
});

test('installEntry refuses when no placeTracked is handed in, before any write', async (t) => {
  const dir = temp(t, 'no-place-tracked');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'game');
  const releaseDir = path.join(dir, 'release');
  const dll = writeFixtureRelease(releaseDir, 'd3dcompiler_47.dll', Buffer.from('x'));
  const entry = fixtureEntry([{ member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: dll.digest, bytes: dll.bytes, source: 'release' }]);
  const manifest = baseManifest(gameDir, exePath);
  await assert.rejects(
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), log: () => {} }),
    (error) => { assert.match(error.message, /placeTracked/); return true; }
  );
  assert.equal(fs.existsSync(path.join(gameDir, 'd3dcompiler_47.dll')), false);
});
