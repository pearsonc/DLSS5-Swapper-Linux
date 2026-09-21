'use strict';
// proton-install-core~7~1, ~9~4, ~18~1, ~40~3: the Linux route gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { routeGate } = require('../src/linux/route-gate');
const { entries } = require('../src/linux/entries');

const root = path.resolve(__dirname, '..');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-route-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gameFixture(t) {
  const dir = temp(t);
  const exePath = path.join(dir, 'Game.exe');
  fs.writeFileSync(exePath, 'exe');
  return { gameDir: dir, exePath };
}

const PROTON = { prefix: '/pfx', build: '/build' };
const A1_PAIR = { route: 'optiscaler', api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64, emulator: null, nativeDlss: true };

// Annex C: the route surface's dimensions are derived from the same files
// its commands enumerate, so the allowlist read reaches a verdict for every
// member of each set rather than only for the one pair Annex A lists.
// [test->proton-install-core~9~4]
test('every route backend-manager.js validates, and every API scan.js can return, reaches a verdict from the gate', (t) => {
  const routeList = JSON.parse(
    execFileSync('grep', ['-n', "includes(route)", path.join(root, 'src/core/backend-manager.js')], { encoding: 'utf8' })
      .match(/\[([^\]]+)\]/)[1]
      .replace(/'/g, '"')
      .replace(/^/, '[').replace(/$/, ']')
  );
  const apiList = execFileSync('bash', ['-c', `grep -ohE "api: '[a-z0-9]+'" ${path.join(root, 'src/core/scan.js')} | sort -u`], { encoding: 'utf8' })
    .trim().split('\n').map((l) => l.match(/'([a-z0-9]+)'/)[1]);
  assert.deepEqual(routeList, ['native', 'feeder', 'optiscaler', 'renodx']);
  assert.deepEqual(apiList, ['d3d10', 'd3d8', 'd3d9', 'ddraw', 'dxgi', 'opengl', 'vulkan']);
  const { gameDir, exePath } = gameFixture(t);
  for (const route of routeList) {
    for (const api of apiList) {
      const result = routeGate({ route, api, apiLabel: 'DirectX 12', bitness: 64, emulator: null, nativeDlss: true, proton: PROTON, gameDir, exePath });
      assert.ok(result === null || (result && result.ok === false), `route ${route}, api ${api} must reach a verdict`);
    }
  }
});

// A new API string is refused, not admitted by default: a denylist would let
// it through, an allowlist against Annex A cannot.
// [test->proton-install-core~9~4]
test('an API string absent from Annex A is refused, not admitted by default', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, api: 'someFutureApi', apiLabel: 'Some Future API', proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
});

// The exact pair Annex A lists is admitted.
// [test->proton-install-core~9~4]
test('the exact pair Annex A lists as allowed is admitted', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  assert.equal(routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath }), null);
});

// ADR-006: the gate reads the label in force after any per-executable
// override, not the detected label alone, so an ambiguous or overridden
// label is judged by what it resolves to.
// [test->proton-install-core~9~4]
test('a game overridden to the label Annex A lists installs; the ambiguous detected label alone does not', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  assert.equal(routeGate({ ...A1_PAIR, apiLabel: 'DirectX 12', proton: PROTON, gameDir, exePath }), null);
  const refusal = routeGate({ ...A1_PAIR, apiLabel: 'DirectX 11/12', proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
});

// [test->proton-install-core~9~4]
test('a 32-bit pair otherwise matching Annex A is refused', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, bitness: 32, proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /32/);
});

// [test->proton-install-core~9~4]
test('an emulator target otherwise matching Annex A is refused, whatever its API', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, emulator: 'RPCS3', proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
});

// [test->proton-install-core~9~4]
test('a game with no native DLSS present, matching Annex A on every other dimension, is refused', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, nativeDlss: false, proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
});

// Annex B's launch-options cell: the fixture entry table carries an empty
// cell and a malformed one, so the gate's own regexp is exercised directly
// rather than only through the one cell Annex A records today.
// [test->proton-install-core~9~4]
test('an entry whose launch-options cell is empty or malformed is refused, naming the cell and the pattern', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const base = entries[0];
  for (const launchOptions of ['', 'WINEDLLOVERRIDES=dxgi=n,b', 'not this at all']) {
    const fixtureEntries = [{ ...base, launchOptions }];
    const refusal = routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath, entries: fixtureEntries });
    assert.equal(refusal.ok, false, `cell ${JSON.stringify(launchOptions)} must refuse`);
    assert.match(refusal.message, /WINEDLLOVERRIDES/, `cell ${JSON.stringify(launchOptions)} names the pattern`);
  }
  // A cell of `none` and a syntactically valid override both pass the cell
  // check, so the fixture entry with a valid override still installs.
  const validOverride = 'WINEDLLOVERRIDES="dxgi=n,b;d3dcompiler_47=n"';
  const fixtureEntries = [{ ...base, launchOptions: validOverride }];
  assert.equal(routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath, entries: fixtureEntries }), null);
});

// [test->proton-install-core~7~1]
test('a native Linux game is refused as such', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath, nativeLinuxGame: true });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /native Linux/i);
});

// [test->proton-install-core~18~1]
test('OptiScaler.ini alone in the game folder refuses, naming the route it found, before any write', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  fs.writeFileSync(path.join(gameDir, 'OptiScaler.ini'), 'old');
  const before = fs.readdirSync(gameDir).sort();
  const refusal = routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /optiscaler/);
  assert.deepEqual(fs.readdirSync(gameDir).sort(), before);
});

// [test->proton-install-core~18~1]
test('dxgi.dll together with nvngx.dll_dlssnr.dll refuses, naming the route it found', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'old');
  fs.writeFileSync(path.join(gameDir, 'nvngx.dll_dlssnr.dll'), 'old');
  const refusal = routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /optiscaler/);
});

// nvngx_dlssnr.dll alone is upstream's kept model, per Annex B, and does not
// count as a file from an earlier install.
// [test->proton-install-core~18~1]
test('nvngx_dlssnr.dll alone, upstream\'s kept model, proceeds', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  fs.writeFileSync(path.join(gameDir, 'nvngx_dlssnr.dll'), 'kept');
  assert.equal(routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath }), null);
});

// [test->proton-install-core~40~3]
test('a manifest.json under the backup directory refuses before the transaction opens, naming its route and date', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const backupDir = path.join(gameDir, '_DLSS5_Backup');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ route: 'optiscaler', date: '2026-09-01T00:00:00.000Z' }));
  let transactionCalled = false;
  const journal = { transaction: () => { transactionCalled = true; } };
  const refusal = routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath, journal });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /optiscaler/);
  assert.match(refusal.message, /2026-09-01/);
  assert.equal(transactionCalled, false, 'journal.transaction is never called');
});

// A manifest that carries neither a route nor a date is named as such.
// [test->proton-install-core~40~3]
test('a manifest.json carrying neither a route nor a date refuses, naming that it carries neither', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const backupDir = path.join(gameDir, '_DLSS5_Backup');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), '{}');
  const refusal = routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /neither/);
});

// A .done-<timestamp> file alone, with no manifest.json present, is a
// retired manifest per Annex B: it proceeds.
// [test->proton-install-core~40~3]
test('a .done-* file alone under the backup directory, no manifest.json present, proceeds', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const backupDir = path.join(gameDir, '_DLSS5_Backup');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'manifest.json.done-1758000000000'), JSON.stringify({ route: 'optiscaler', date: '2026-09-01T00:00:00.000Z' }));
  assert.equal(routeGate({ ...A1_PAIR, proton: PROTON, gameDir, exePath }), null);
});

// Existing wave-1 behaviour, kept: off Linux the gate always admits, and on
// Linux a game with no resolved Proton context, or the Vulkan API, still
// refuses as before.
// [test->proton-install-core~31~6]
test('off Linux the gate always admits', (t) => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const { gameDir, exePath } = gameFixture(t);
    assert.equal(routeGate({ ...A1_PAIR, proton: null, gameDir, exePath }), null);
  } finally {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  }
});

test('a game with no resolved Proton context refuses on Linux, unrelated to any Annex A pair', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, proton: null, gameDir, exePath });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'errProtonRequired');
});

test('the Vulkan Feeder route is refused on Linux, unrelated to any Annex A pair', (t) => {
  const { gameDir, exePath } = gameFixture(t);
  const refusal = routeGate({ ...A1_PAIR, api: 'vulkan', proton: PROTON, gameDir, exePath });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'errLinuxVulkanUnsupported');
});
