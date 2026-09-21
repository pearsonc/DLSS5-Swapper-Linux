'use strict';
// installEntry, src/core/backend-manager.js:130's optiscaler-branch hook. On
// Linux it records the before-install record before its first write
// (proton-install-core~34~4, ~39~3), re-runs the running-game guard before
// its first write outside the backup directory (proton-install-core~37~1),
// places the entry's files inside the game folder and never into a Proton
// prefix (proton-install-core~6~1, ~16~2), and emits the launch-options
// event once they are placed (proton-install-core~11~5).
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

function fixtureEntry(placement, launchOptions = 'none') {
  return { id: 'FIX', route: 'optiscaler', placement, launchOptions };
}

function noopGuard() { return async () => {}; }

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
    gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(),
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
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), log: (e) => events.push(e) });
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
  await installEntry({ gameDir: gameDir2, exePath: exePath2, entry: overrideEntry, releaseDir, manifest: manifest2, guard: noopGuard(), log: (e) => events2.push(e) });
  const launch2 = events2.filter((e) => e.code === 'linux-launch-options');
  assert.equal(launch2.length, 1);
  assert.deepEqual(launch2[0].params, { entry: 'FIX', cell: 'WINEDLLOVERRIDES="dxgi=n,b"' });
});

// [test->proton-install-core~16~2]
test('installEntry places d3dcompiler_47.dll from the fixture release directory at its entry-injected version and digest', async (t) => {
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
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), log: () => {} });
  const placed = fs.readFileSync(path.join(gameDir, 'd3dcompiler_47.dll'));
  assert.equal(sha256(placed), dll.digest);
  assert.equal(placed.length, dll.bytes);
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
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), bound: 3, log: (e) => events.push(e) }),
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
  await installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard, log: () => {} });
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
    () => installEntry({ gameDir: gameDir2, exePath: exePath2, entry, releaseDir, manifest: manifest2, guard: refusingGuard, log: () => {} }),
    { code: 'errGameRunning' }
  );
  assert.equal(guardCalls, 2);
  assert.equal(fs.existsSync(path.join(gameDir2, 'd3dcompiler_47.dll')), false);
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
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), log: () => {} }),
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
    () => installEntry({ gameDir, exePath, entry, releaseDir, manifest, guard: noopGuard(), log: () => {} }),
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
  await installEntry({ gameDir: gameDir2, exePath: exePath2, entry, releaseDir, manifest: manifest2, guard: noopGuard(), log: () => {} });
  assert.equal(fs.existsSync(path.join(gameDir2, 'd3dcompiler_47.dll')), true);
});
