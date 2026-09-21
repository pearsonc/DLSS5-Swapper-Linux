'use strict';
// proton-install-core~12~3, ~13~1, ~14~6, ~15~2: the running-game check on
// Linux, per ADR-003 (superseded) and ADR-011. Every fixture is a fake
// process root under os.tmpdir(), of the shape Annex B allows a test to
// hand the check instead of /proc, never a real running process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertGameClosed } = require('../src/linux/running-game');

Object.defineProperty(process, 'platform', { value: 'linux' });

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Same packing glibc's gnu_dev_major/gnu_dev_minor use, matched against the
// production decode in src/linux/running-game.js, for building a real
// /proc/<pid>/maps line from a real file's own stat.dev.
const MASK32 = 0xffffffffn;
function majorMinorHex(dev) {
  const d = BigInt(dev);
  const minor = (d & 0xffn) | ((d >> 12n) & (~0xffn & MASK32));
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & (~0xfffn & MASK32));
  return `${major.toString(16)}:${minor.toString(16)}`;
}

function makeProcess(root, pid, { status = 'Uid:\t1000\t1000\t1000\t1000\n', exeTarget, mapsLines, cmdlineArgs } = {}) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status'), status);
  if (exeTarget !== undefined) fs.symlinkSync(exeTarget, path.join(dir, 'exe'));
  if (mapsLines !== undefined) fs.writeFileSync(path.join(dir, 'maps'), mapsLines.join('\n') + '\n');
  if (cmdlineArgs !== undefined) fs.writeFileSync(path.join(dir, 'cmdline'), cmdlineArgs.join('\0') + '\0');
  return dir;
}

async function outcome(work) {
  try { await work(); return { admitted: true }; }
  catch (error) { return { admitted: false, code: error.code, path: error.path, pid: error.pid }; }
}

// ---------------------------------------------------------------------------
// proton-install-core~12~3: a readable process is judged by device and
// inode identity, never by path.

// [test->proton-install-core~12~3]
test('a readable process running the game executable, spike-shaped, python3 renamed to it, refuses', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const exe = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exe, '#!/usr/bin/env python3\n');
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 4242, { exeTarget: exe, mapsLines: ['00400000-00401000 r-xp 00000000 00:00 0'] });
  const result = await outcome(() => assertGameClosed(null, gameDir, exe, null, null, null, root));
  assert.equal(result.admitted, false);
  assert.equal(result.code, 'errGameRunning');
  assert.equal(result.path, exe);
});

// [test->proton-install-core~12~3]
test('a readable process reached through a symlinked game folder still refuses by identity', async (t) => {
  const realGameDir = tempDir(t, 'swapper-u2-real-');
  const exe = path.join(realGameDir, 'Game.exe');
  fs.writeFileSync(exe, 'binary');
  const linkedGameDir = path.join(os.tmpdir(), `swapper-u2-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(realGameDir, linkedGameDir);
  t.after(() => fs.rmSync(linkedGameDir, { force: true }));
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 4243, { exeTarget: exe, mapsLines: ['00400000-00401000 r-xp 00000000 00:00 0'] });
  const result = await outcome(() => assertGameClosed(null, linkedGameDir, path.join(linkedGameDir, 'Game.exe'), null, null, null, root));
  assert.equal(result.admitted, false);
  assert.equal(result.code, 'errGameRunning');
});

// [test->proton-install-core~12~3]
test('a readable process mapping the proxy from inside the game folder refuses, and a clean readable process admits', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const proxy = path.join(gameDir, 'dxgi.dll');
  fs.writeFileSync(proxy, 'proxy bytes');
  const st = fs.lstatSync(proxy);
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 5000, {
    exeTarget: '/usr/bin/wine',
    mapsLines: [`7f0000000000-7f0000010000 r--p 00000000 ${majorMinorHex(st.dev)} ${st.ino}`]
  });
  const refused = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, null, root));
  assert.equal(refused.admitted, false);
  assert.equal(refused.code, 'errGameRunning');

  const cleanRoot = tempDir(t, 'swapper-u2-proc-');
  makeProcess(cleanRoot, 5001, { exeTarget: '/usr/bin/bash', mapsLines: ['00400000-00401000 r-xp 00000000 00:00 0'] });
  const admitted = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, null, cleanRoot));
  assert.equal(admitted.admitted, true);
});

// [test->proton-install-core~12~3]
test('a process of another user is never read as the game', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const exe = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exe, 'binary');
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 6000, { status: 'Uid:\t0\t0\t0\t0\n', exeTarget: exe, mapsLines: ['00400000-00401000 r-xp 00000000 00:00 0'] });
  const result = await outcome(() => assertGameClosed(null, gameDir, exe, null, null, null, root));
  assert.equal(result.admitted, true, 'a foreign-uid process matching the executable is not read as the game');
});

// ---------------------------------------------------------------------------
// proton-install-core~13~1: no element of a process's command line other
// than argv[0] is read.

// [test->proton-install-core~13~1]
test('a hidden process naming the game only past argv[0] is admitted, since only argv[0] is read', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 7000, { cmdlineArgs: ['sh', '-c', gameDir] });
  const events = [];
  const result = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, (e) => events.push(e), root));
  assert.equal(result.admitted, true);
  assert.equal(events[0].params.path, 'sh');
});

// ---------------------------------------------------------------------------
// proton-install-core~14~6: Annex B's hidden-process table, one fixture per
// row, each verdict asserted on the linux-hidden-process event.

// [test->proton-install-core~14~6]
test('a drive letter a dosdevices link translates under the game folder refuses, naming the identifier and the path', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  fs.mkdirSync(path.join(gameDir, 'Sub'), { recursive: true });
  const prefix = tempDir(t, 'swapper-u2-prefix-');
  fs.mkdirSync(path.join(prefix, 'dosdevices'), { recursive: true });
  fs.symlinkSync(gameDir, path.join(prefix, 'dosdevices', 's:'));
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 8001, { cmdlineArgs: ['S:\\Sub\\Game.exe'] });
  const events = [];
  const result = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, (e) => events.push(e), root, () => prefix));
  assert.equal(result.admitted, false);
  assert.equal(result.code, 'errGameRunning');
  assert.equal(result.pid, 8001);
  assert.equal(events[0].params.verdict, 'refused');
});

// [test->proton-install-core~14~6]
test('a drive letter with no translating prefix refuses', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 8002, { cmdlineArgs: ['D:\\x.exe'] });
  const events = [];
  const result = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, (e) => events.push(e), root, () => null));
  assert.equal(result.admitted, false);
  assert.equal(events[0].params.verdict, 'refused');
});

// [test->proton-install-core~14~6]
test('a rooted Unix path under the game folder that canonicalises refuses; elsewhere it admits', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  fs.mkdirSync(path.join(gameDir, 'inside'), { recursive: true });
  const outsideDir = tempDir(t, 'swapper-u2-outside-');
  const root = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root, 8003, { cmdlineArgs: [path.join(gameDir, 'inside')] });
  const events = [];
  const inside = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, (e) => events.push(e), root));
  assert.equal(inside.admitted, false);
  assert.equal(events[0].params.verdict, 'refused');

  const root2 = tempDir(t, 'swapper-u2-proc-');
  makeProcess(root2, 8004, { cmdlineArgs: [outsideDir] });
  const events2 = [];
  const elsewhere = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, (e) => events2.push(e), root2));
  assert.equal(elsewhere.admitted, true);
  assert.equal(events2[0].params.verdict, 'admitted');
});

// [test->proton-install-core~14~6]
test('a bare name, an empty argv[0], a relative path and an uncanonicalisable rooted path are all logged unjudged and admitted', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const cases = [['nvtop'], [''], ['./steamwebhelper'], [path.join(gameDir, 'gone.exe')]];
  for (const [i, argv] of cases.entries()) {
    const root = tempDir(t, 'swapper-u2-proc-');
    makeProcess(root, 9000 + i, { cmdlineArgs: argv });
    const events = [];
    const result = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, (e) => events.push(e), root));
    assert.equal(result.admitted, true, `case ${i}: ${JSON.stringify(argv)}`);
    assert.equal(events[0].params.verdict, 'unjudged', `case ${i}`);
  }
});

// ---------------------------------------------------------------------------
// proton-install-core~15~2: the process root cannot be read.

// [test->proton-install-core~15~2]
test('a process root that does not exist refuses the guarded operation', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const missingRoot = path.join(os.tmpdir(), `swapper-u2-missing-${process.pid}-${Date.now()}`);
  const result = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, null, missingRoot));
  assert.equal(result.admitted, false);
  assert.equal(result.code, 'errGameRunning');
});

// [test->proton-install-core~15~2]
test('an empty process root, existing but listing no readable digit entry, refuses', async (t) => {
  const gameDir = tempDir(t, 'swapper-u2-game-');
  const emptyRoot = tempDir(t, 'swapper-u2-empty-');
  const result = await outcome(() => assertGameClosed(null, gameDir, path.join(gameDir, 'Game.exe'), null, null, null, emptyRoot));
  assert.equal(result.admitted, false);
  assert.equal(result.code, 'errGameRunning');
});

// The bind-mount case is the carried limit the hazard table names: a
// process whose maps names a path under the game folder with a device and
// inode of no file there, or a game bind-mounted at another path entirely,
// so a path-string guard would misjudge it in both directions. This check's
// identity comparison closes the mapped-file half; no fixture here can
// construct a second mount namespace, so the hazard table carries it rather
// than a test.
