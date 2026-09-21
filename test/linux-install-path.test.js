'use strict';
// proton-install-core~28~9, the property the wave-2 code review found
// unreached: with process.platform 'linux' and a fixture Steam layout, a
// fixture entry archive and a fixture Windows release directory, one install
// through the install handler reaches the route gate with the job channel,
// the ensure step by route, the compiler check with the release directory,
// and the copy step with the entry, a manifest begun by upstream's
// beginManifest, the barrel's guard bound with the log, the release
// directory and upstream's tracked copy from apply.js, so that the placed
// set, `_DLSS5_Backup/manifest.json` with `linuxBefore`, the
// `linux-record-written` and `linux-launch-options` events, and the modes
// and case of the placed files are what Annex A and the criteria say.
//
// The harness copies the shape of test/linux-off-platform.test.js's
// loadMain (:261 and after), not its win32: one side only, platform linux,
// and the copy step's own module (backend-manager.js) left real rather than
// stubbed, so the wiring this unit closes is what actually runs.
Object.defineProperty(process, 'platform', { value: 'linux' });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');

// The fixture entry table: install-guards installed under require.cache
// before route-gate.js, ensure-entry.js or entry-install.js first resolve
// './entries', so every one of the three Annex D hooks that reads Annex A's
// table reads this fixture instead, per the file-mode test's own precedent
// of substituting a barrel export for the duration of a test.
const entriesPath = require.resolve(path.join(root, 'src', 'linux', 'entries.js'));

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const ARCHIVE = path.join(__dirname, 'fixtures', 'linux-ensure-entry', 'archive-control.7z');
const ARCHIVE_SHA256 = '11f267f2f3957b71c2c71664ce6841bcf2ddb6e19d30fc14b8b0ddcbbec919bb';
const ARCHIVE_BYTES = fs.statSync(ARCHIVE).size;
const ARCHIVE_URL = 'https://example.invalid/fixtures/archive-control.7z';

function installFixtureEntries(releaseDigest, releaseBytes) {
  const entry = {
    id: 'U9FIX', route: 'optiscaler', api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64,
    emulator: 'none', nativeDlss: true, proxy: 'dxgi.dll',
    // The recorded byte count is an upper bound the ensure step draws no
    // more than, plus one chunk (proton-install-core~33~3): a margin above
    // the real size, exactly as Annex A's own recorded sizes are the
    // remote's, never a promise that the last chunk lands exactly on it.
    archive: 'archive-control.7z', build: 'fixture', sha256: ARCHIVE_SHA256, bytes: ARCHIVE_BYTES + 4096, url: ARCHIVE_URL,
    launchOptions: 'none',
    iniKeys: [{ section: 'DlssNr', key: 'Enabled', value: 'true' }],
    placement: [
      { member: 'OptiScaler.dll', placedAs: 'dxgi.dll', sha256: 'bf210e6fa7e4bd461162e09554a515c4baeac5f3753a0c6960999fc7a3622151', bytes: 35, source: 'archive' },
      { member: 'nvngx.dll_dlssnr.dll', placedAs: 'nvngx.dll_dlssnr.dll', sha256: 'ab5a372ad4d6510f8cd0bb7097d346391d0ed4dca6f9009763b3f3e933411012', bytes: 41, source: 'archive' },
      { member: 'OptiScaler.ini', placedAs: 'OptiScaler.ini', sha256: '95f7abdceac265043ec9a7c2c7e0cdd1a176dabac5ac13428f43f7c6c6e9ddb7', bytes: 35, source: 'archive' },
      { member: 'd3dcompiler_47.dll', placedAs: 'd3dcompiler_47.dll', sha256: releaseDigest, bytes: releaseBytes, source: 'release' }
    ]
  };
  const entries = [entry];
  const fake = {
    entries, refusedPairs: [],
    entryFor: (route) => entries.find((e) => e.route === route),
    archiveMembers: entries.flatMap((e) => e.placement.filter((r) => r.source === 'archive').map((r) => r.member))
  };
  require.cache[entriesPath] = { id: entriesPath, filename: entriesPath, loaded: true, exports: fake };
  return entry;
}

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `install-path-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Copies loadMain's shape from test/linux-off-platform.test.js:261 on,
// minus the win32/oracle machinery: one platform, real backend-manager.js.
function loadMain(userData, options) {
  const main = path.join(root, 'main.js');
  const source = fs.readFileSync(main, 'utf8');
  const realRequire = Module.createRequire(main);
  const handlers = new Map();
  const dialogs = [];
  const stubs = {
    electron: {
      app: { setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => userData },
      BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getContentSize: () => [1280, 860] }) },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showMessageBox: async (_window, o) => { dialogs.push(o.title); return { response: 0 }; } },
      clipboard: { writeText() {} }
    },
    './src/core/scan.js': { scanGame: async () => ({ chosen: options.target, exeCandidates: [options.target], hasNativeDlss: true }) },
    './src/core/compatibility': { assertSafeTarget() {}, hasAntiCheat: () => false },
    // The verifier's remaining install-path case leaves assertGameClosed's
    // own matching logic real (never stubbed to a no-op): the fixture hands
    // it a processRoot standing in for /proc, the same shape
    // test/linux-running-game.test.js uses, so the game-running refusal is
    // the genuine check, not a mock of it. gpuInfo, never nvidia-smi
    // itself, stays a fixture on both paths.
    './src/core/install-guards': {
      assertGameClosed: options.fixtureProcessRoot
        ? (gameDir, exePath, runner, locked, log) => require('../src/core/install-guards').assertGameClosed(gameDir, exePath, runner, locked, log, options.fixtureProcessRoot)
        : async () => {},
      antiCheatPresent: () => false,
      gpuInfo: async () => [{ name: 'NVIDIA GeForce RTX 5090', driver: '616.56' }],
      gpuSupported: () => true, gpuModelSupported: () => true, driverSupported: () => true,
      driverNeuralFault: () => false, driverNames: () => ''
    },
    './src/shared/install-routes': { nativeDlssPresent: () => true, routesFor: () => ['native', 'feeder', 'optiscaler'], recommendedRoute: () => 'native' },
    './src/core/runtime-components.js': { missingVCRuntime: () => [], ensureLumenite: async () => null },
    './src/core/proton': { contextForSteamGame: (game) => (game ? { proton: '/fixture/proton', prefix: game.protonPrefix, steamRoot: game.steamRoot, appid: game.id } : null), createSetupRunner: () => async () => {} },
    './src/library': { discover: () => [], folder: () => null, dedupe: (v) => v, isInside: () => false, steam: () => options.steamGames || [] }
  };
  const context = vm.createContext({ require: (name) => (name in stubs ? stubs[name] : realRequire(name)), __dirname: root, process, Buffer, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: main });
  vm.runInContext(
    `payload = () => (${JSON.stringify({ source: { dir: options.releaseDir, payload: [], feeder: { ok32: true, ok64: true } }, reshadeSetup: null })}); companionAddons = () => [];`,
    context
  );
  return { handlers, dialogs };
}

function writeRelease(releaseDir) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const content = Buffer.from('fixture-d3dcompiler-bytes');
  fs.writeFileSync(path.join(releaseDir, 'd3dcompiler_47.dll'), content);
  return { digest: sha256(content), bytes: content.length };
}

// Global fetch is the seam ensure-entry.js's defaultFetcher reads; a test
// hands it a stubbed archive by intercepting the one URL the fixture entry
// names and serving the committed fixture .7z from disk, never the network.
function stubFetch(t) {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (url !== ARCHIVE_URL) throw new Error(`unexpected fetch of ${url}`);
    const bytes = fs.readFileSync(ARCHIVE);
    return {
      ok: true,
      body: (async function* () {
        for (let i = 0; i < bytes.length; i += 4096) yield bytes.subarray(i, Math.min(i + 4096, bytes.length));
      })()
    };
  };
  t.after(() => { global.fetch = original; });
}

// [test->proton-install-core~28~9]
test('the install handler on Linux reaches the route gate, the ensure step, the compiler check and the copy step, and places what Annex A records', async (t) => {
  stubFetch(t);
  const userData = temp(t, 'main');
  const gameDir = path.join(userData, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'exe');
  const releaseDir = path.join(userData, 'release');
  const release = writeRelease(releaseDir);
  installFixtureEntries(release.digest, release.bytes);
  t.after(() => { delete require.cache[entriesPath]; });

  const target = { path: exePath, rel: 'Game.exe', bitness: 64, api: 'dxgi', apiLabel: 'DirectX 12' };
  const steamGames = [{ id: 990080, dir: gameDir, steamRoot: '/fixture/steam', protonPrefix: '/fixture/steam/steamapps/compatdata/990080/pfx' }];
  const { handlers } = loadMain(userData, { target, releaseDir, steamGames });

  const events = [];
  const result = await handlers.get('install')({ sender: { send: (_channel, e) => events.push(e) } }, gameDir, exePath, 'optiscaler', 'dxgi');

  assert.equal(result.ok, true, `install failed: ${JSON.stringify(result)}`);

  // The route gate, the ensure step and the compiler check were all
  // reached: none of them refused, and the record-written and
  // launch-options events, which only the copy step downstream of them
  // emits, are present.
  const recordEvent = events.find((e) => e.code === 'linux-record-written');
  const launchEvent = events.find((e) => e.code === 'linux-launch-options');
  assert.ok(recordEvent, 'linux-record-written was emitted');
  assert.ok(launchEvent, 'linux-launch-options was emitted');
  assert.deepEqual(launchEvent.params, { entry: 'U9FIX', cell: 'none' });

  // proton-install-core~5~5: the fixture's Steam game names a steamRoot
  // that carries no library file, so the context is unresolved and the
  // route gate's second call site (main.js:1663) emits the one job event
  // that names it, never more than once.
  const unresolvedEvents = events.filter((e) => e.code === 'linux-proton-unresolved');
  assert.equal(unresolvedEvents.length, 1, 'linux-proton-unresolved was emitted exactly once');
  assert.equal(unresolvedEvents[0].params.reason, 'not-listed');

  // The before-install record, Annex B: the copy step's manifest carries
  // linuxBefore from the walk taken before any write.
  const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json was written under the backup directory');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.linuxBefore), 'the manifest carries linuxBefore');
  assert.equal(manifest.route, 'optiscaler');

  // The placed set: every placement row's placedAs exists in the game
  // folder, at the mode proton-install-core~20~1 fixes for a new file on
  // Linux through linux.fileMode(undefined) rather than upstream's 0o666.
  for (const rel of ['dxgi.dll', 'nvngx.dll_dlssnr.dll', 'OptiScaler.ini', 'd3dcompiler_47.dll']) {
    const full = path.join(gameDir, rel);
    assert.ok(fs.existsSync(full), `${rel} was placed`);
    assert.equal(fs.statSync(full).mode & 0o777, 0o644, `${rel} carries the new-file Linux mode`);
  }
  // Case: placedAs is asserted byte for byte against the placement table,
  // which is itself the case the file was written under (no case folding
  // anywhere in the copy step).
  assert.deepEqual(fs.readdirSync(gameDir).filter((n) => n !== '_DLSS5_Backup' && n !== 'Game.exe').sort(),
    ['OptiScaler.ini', 'd3dcompiler_47.dll', 'dxgi.dll', 'nvngx.dll_dlssnr.dll']);

  // OptiScaler.ini's key was applied once placed (review finding
  // conformance 4-6).
  assert.match(fs.readFileSync(path.join(gameDir, 'OptiScaler.ini'), 'utf8'), /Enabled=true/);
});

// A fixture process root of the shape test/linux-running-game.test.js
// uses: a hidden process (no readable exe or maps) whose argv[0] is the
// game's own executable, judged by path per proton-install-core~14~6.
function plantMatchingProcess(root, exePath) {
  const pidDir = path.join(root, '4321');
  fs.mkdirSync(pidDir, { recursive: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  fs.writeFileSync(path.join(pidDir, 'status'), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  fs.writeFileSync(path.join(pidDir, 'cmdline'), `${exePath}\0`);
}

// [test->proton-install-core~28~9]
test('the install handler on Linux refuses with errGameRunning, through the real assertGameClosed, before any file is placed', async (t) => {
  stubFetch(t);
  const userData = temp(t, 'guard-real');
  const gameDir = path.join(userData, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'exe');
  const releaseDir = path.join(userData, 'release');
  const release = writeRelease(releaseDir);
  installFixtureEntries(release.digest, release.bytes);
  t.after(() => { delete require.cache[entriesPath]; });

  const fixtureProcessRoot = temp(t, 'proc');
  plantMatchingProcess(fixtureProcessRoot, exePath);

  const target = { path: exePath, rel: 'Game.exe', bitness: 64, api: 'dxgi', apiLabel: 'DirectX 12' };
  const steamGames = [{ id: 990080, dir: gameDir, steamRoot: '/fixture/steam', protonPrefix: '/fixture/steam/steamapps/compatdata/990080/pfx' }];
  const { handlers } = loadMain(userData, { target, releaseDir, steamGames, fixtureProcessRoot });

  const events = [];
  const result = await handlers.get('install')({ sender: { send: (_channel, e) => events.push(e) } }, gameDir, exePath, 'optiscaler', 'dxgi');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'errGameRunning');

  // Before any file is placed: nothing besides the executable itself sits
  // in the game folder, and no backup directory was ever created.
  assert.deepEqual(fs.readdirSync(gameDir), ['Game.exe']);
});
