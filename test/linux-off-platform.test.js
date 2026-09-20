'use strict';
// proton-install-core~31~5: off Linux, every hook Annex D marks as replacing
// upstream code returns what the replaced code returned at 24bd2ac for the
// same arguments. The oracle is `git show 24bd2ac:<file>`, loaded beside the
// hooked file so its relative requires resolve the same way, and both are
// driven with identical arguments on identical fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// Redefined before any application module loads, so the hooks, the upstream
// files and the oracle all read the same platform.
Object.defineProperty(process, 'platform', { value: 'win32' });

const root = path.resolve(__dirname, '..');
const ORACLE = '24bd2ac';

function oracle(rel) {
  const source = execFileSync('git', ['-C', root, 'show', `${ORACLE}:${rel}`], { encoding: 'utf8' });
  const filename = path.join(root, path.dirname(rel), `oracle-${ORACLE}-${path.basename(rel)}`);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(source, filename);
  return m.exports;
}

const temp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swapper-off-platform-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A relative listing of a tree with each file's mode and bytes, for
// comparing what two runs left behind.
function tree(dir) {
  const rows = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) { rows.push([child, 'dir']); walk(child); }
      else rows.push([child, (fs.statSync(path.join(dir, child)).mode & 0o777).toString(8), fs.readFileSync(path.join(dir, child), 'utf8')]);
    }
  };
  walk('');
  return rows;
}

// The manifest carries a random backup prefix and the moment it was begun;
// neither is the hook's to keep equal.
const normalise = (value, dir) => JSON.parse(JSON.stringify(value)
  .split(dir).join('<game>')
  .replace(/originals\/[a-f0-9-]+/g, 'originals/<uuid>')
  .replace(/(\\?")date(\\?"):\s*(\\?")[^"\\]+(\\?")/g, '$1date$2:$3<date>$4'));

const hooked = {
  guards: require('../src/core/install-guards'),
  apply: require('../src/core/apply'),
  scan: require('../src/core/scan'),
  compatibility: require('../src/core/compatibility'),
  backends: require('../src/core/backend-manager'),
  linux: require('../src/linux')
};
const optiscaler = require('../src/core/optiscaler');
const upstream = {
  guards: oracle('src/core/install-guards.js'),
  apply: oracle('src/core/apply.js'),
  scan: oracle('src/core/scan.js'),
  compatibility: oracle('src/core/compatibility.js'),
  backends: oracle('src/core/backend-manager.js')
};

async function outcome(work) {
  try { return { value: await work() }; }
  catch (error) { return { threw: { code: error.code, message: error.message } }; }
}

// install-guards.js:39, the running-game check, through its injectable runner
// and lock probe.
// [test->proton-install-core~31~5]
test('assertGameClosed off Linux returns what upstream returned for the same runner and lock answers', async () => {
  const gameDir = path.join(os.tmpdir(), 'off-platform-game');
  const exe = path.join(gameDir, 'Game.exe');
  const inside = JSON.stringify([{ ProcessId: 4242, Name: 'Game.exe', ExecutablePath: exe }]);
  const outside = JSON.stringify([{ ProcessId: 4243, Name: 'other.exe', ExecutablePath: '/elsewhere/other.exe' }]);
  const cases = [
    { runner: async () => inside, locked: () => false },
    { runner: async () => outside, locked: () => false },
    { runner: async () => { throw new Error('no powershell'); }, locked: () => true },
    { runner: async () => { throw new Error('no powershell'); }, locked: () => false }
  ];
  const seen = [];
  for (const [i, c] of cases.entries()) {
    const calls = { upstream: [], hooked: [] };
    const record = (side) => (...args) => { calls[side].push(args); return c.runner(); };
    const a = await outcome(() => upstream.guards.assertGameClosed(gameDir, exe, record('upstream'), c.locked));
    const b = await outcome(() => hooked.guards.assertGameClosed(gameDir, exe, record('hooked'), c.locked));
    assert.deepEqual(b, a, `case ${i}`);
    assert.deepEqual(calls.hooked, calls.upstream, `case ${i} runner arguments`);
    seen.push(a);
  }
  assert.equal(seen[0].threw.code, 'errGameRunning', 'the matching process refuses');
  assert.equal(seen[2].threw.code, 'errGameRunning', 'the locked executable refuses');
  assert.equal('value' in seen[1] && 'value' in seen[3], true, 'the other two admit');
});

// install-guards.js:91, the GPU query, through its injectable runner.
// [test->proton-install-core~31~5]
test('gpuInfo off Linux returns what upstream returned for the same runner', async () => {
  const csv = 'NVIDIA GeForce RTX 5090, 616.56\nNVIDIA GeForce RTX 4090, 616.92\n';
  for (const runner of [async () => csv, async () => { throw new Error('ENOENT'); }]) {
    const calls = { upstream: [], hooked: [] };
    const record = (side) => (...args) => { calls[side].push(args); return runner(); };
    const a = await upstream.guards.gpuInfo(record('upstream'));
    const b = await hooked.guards.gpuInfo(record('hooked'));
    assert.deepEqual(b, a);
    assert.deepEqual(calls.hooked, calls.upstream);
  }
  assert.deepEqual(await hooked.guards.gpuInfo(async () => csv), [
    { name: 'NVIDIA GeForce RTX 5090', driver: '616.56' }, { name: 'NVIDIA GeForce RTX 4090', driver: '616.92' }]);
  assert.equal(await hooked.guards.gpuInfo(async () => { throw new Error('ENOENT'); }), null);
});

function plantGame(dir) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'exe');
  fs.writeFileSync(path.join(dir, 'existing.dll'), 'old bytes');
  fs.chmodSync(path.join(dir, 'existing.dll'), 0o600);
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), 'old ini');
  fs.chmodSync(path.join(dir, 'ReShade.ini'), 0o600);
  fs.writeFileSync(path.join(dir, 'payload.dll'), 'new bytes');
}

// apply.js:150 and :257, the file modes, and :221-260, the case-aware
// targets, through copyTracked, writeTracked and trackBeforeWrite.
// [test->proton-install-core~31~5]
test('copyTracked, writeTracked and trackBeforeWrite off Linux leave what upstream left', async (t) => {
  const run = async (mod, name) => {
    const dir = temp(t, name);
    plantGame(dir);
    const manifest = mod.beginManifest(dir, path.join(dir, 'Game.exe'), 'dxgi');
    const rels = [];
    rels.push(await mod.copyTracked(manifest, dir, path.join(dir, 'payload.dll'), path.join(dir, 'existing.dll'), { kind: 'proxy', oldVersion: '1', newVersion: '2' }));
    rels.push(await mod.copyTracked(manifest, dir, path.join(dir, 'payload.dll'), path.join(dir, 'sub', 'new.dll'), { kind: 'proxy', oldVersion: null, newVersion: '2' }));
    rels.push(await mod.writeTracked(manifest, dir, path.join(dir, 'ReShade.ini'), 'new ini', { kind: 'config', oldVersion: null }));
    rels.push(await mod.writeTracked(manifest, dir, path.join(dir, 'sub', 'deeper', 'fresh.ini'), 'fresh', { kind: 'config', oldVersion: null }));
    rels.push(await mod.trackBeforeWrite(manifest, dir, path.join(dir, 'tracked-only.txt'), { kind: 'config', oldVersion: null }));
    const modes = ['existing.dll', 'sub/new.dll', 'ReShade.ini', 'sub/deeper/fresh.ini'].map(rel => (fs.statSync(path.join(dir, rel)).mode & 0o777).toString(8));
    return { rels, modes, manifest: normalise(manifest, dir), tree: normalise(tree(dir), dir) };
  };
  const a = await run(upstream.apply, 'upstream-apply');
  const b = await run(hooked.apply, 'hooked-apply');
  assert.deepEqual(b, a);
  assert.deepEqual(a.modes, ['666', '666', '666', '664'], 'upstream sets 0o666 on what existed and leaves a fresh write at the umask');
  assert.equal(a.manifest.replaced.length, 2);
  assert.equal(a.manifest.added.length, 3);
});

// apply.js:959, the restore, through restore() over a planted manifest.
// [test->proton-install-core~31~5]
test('restore off Linux returns and leaves what upstream did', async (t) => {
  const run = async (mod, name) => {
    const dir = temp(t, name);
    plantGame(dir);
    const manifest = mod.beginManifest(dir, path.join(dir, 'Game.exe'), 'dxgi');
    await mod.copyTracked(manifest, dir, path.join(dir, 'payload.dll'), path.join(dir, 'existing.dll'), { kind: 'proxy', oldVersion: '1', newVersion: '2' });
    await mod.writeTracked(manifest, dir, path.join(dir, 'sub', 'deeper', 'fresh.ini'), 'fresh', { kind: 'config', oldVersion: null });
    await mod.saveActiveManifest(dir, manifest);
    const events = [];
    const result = await mod.restore(dir, e => events.push(e));
    const rows = tree(dir).map(([rel, ...rest]) => [rel.replace(/manifest\.json\.done-\d+/, 'manifest.json.done-<time>'), ...rest]);
    return { result, events: normalise(events, dir), tree: normalise(rows, dir) };
  };
  const a = await run(upstream.apply, 'upstream-restore');
  const b = await run(hooked.apply, 'hooked-restore');
  assert.deepEqual(b, a);
  assert.equal(a.result, true);
  assert.equal(a.events.some(e => e.code === 'restoreDone'), true);
});

// The Restore row passes restoreFiles in, and off Linux the hook calls it
// unchanged: proven with a spy standing in for the argument.
// [test->proton-install-core~31~5]
test('restoreSweep off Linux calls the restoreFiles it is handed, once, with its own arguments', async () => {
  const calls = [];
  const restoreFiles = async (...args) => { calls.push(args); return 'what restoreFiles returned'; };
  const manifest = { replaced: [], added: [] };
  const onLog = () => {};
  assert.equal(await hooked.linux.restoreSweep(restoreFiles, '/game', manifest, onLog), 'what restoreFiles returned');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/game');
  assert.equal(calls[0][1], manifest);
  assert.equal(calls[0][2], onLog);
});

// scan.js:85-87, compatibility.js:45 and apply.js:345-346 share the
// case-aware target; the first two are reachable through exported functions.
// [test->proton-install-core~31~5]
test('inspectReShade and oldShaderCompiler off Linux return what upstream returned', (t) => {
  const dir = temp(t, 'scan');
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'not a portable executable');
  fs.writeFileSync(path.join(dir, 'loader.asi'), 'not one either');
  fs.writeFileSync(path.join(dir, 'D3DCompiler_47.dll'), 'nor this');
  const readVersion = (file) => `6.3.9600.17415 ${path.basename(file)}`;
  for (const exeDir of [dir, path.join(dir, 'absent')]) {
    assert.deepEqual(hooked.scan.inspectReShade(exeDir), upstream.scan.inspectReShade(exeDir));
    assert.deepEqual(hooked.compatibility.oldShaderCompiler(exeDir, readVersion), upstream.compatibility.oldShaderCompiler(exeDir, readVersion));
  }
  assert.notEqual(upstream.compatibility.oldShaderCompiler(dir, readVersion), null, 'the planted compiler is read');
  assert.equal(upstream.compatibility.oldShaderCompiler(path.join(dir, 'absent'), readVersion), null);
});

// The two inline helpers, at every site's inputs.
// [test->proton-install-core~31~5]
test('caseAwareTarget and fileMode off Linux return upstream\'s inline values', (t) => {
  const dir = temp(t, 'case');
  fs.writeFileSync(path.join(dir, 'DXGI.dll'), 'x');
  for (const name of ['dxgi.dll', 'd3d9.dll', 'opengl32.dll', 'D3DCompiler_47.dll', 'ReShade.ini', 'sub/new.dll']) {
    assert.equal(hooked.linux.caseAwareTarget(dir, name), name);
  }
  for (const mode of [undefined, 0o600, 0o644, 0o755]) assert.equal(hooked.linux.fileMode(mode), 0o666);
});

// backend-manager.js:130, the copy step, through install() on the optiscaler
// route with optiscaler.install recording what it was handed.
// [test->proton-install-core~31~5]
test('backend install on the optiscaler route off Linux hands optiscaler.install what upstream handed it', async (t) => {
  const original = optiscaler.install;
  t.after(() => { optiscaler.install = original; });
  const run = async (mod, name) => {
    const dir = temp(t, name);
    plantGame(dir);
    const calls = [];
    optiscaler.install = async (config, log) => {
      calls.push({ config: normalise({ ...config, source: '<source>' }, dir), logIsFunction: typeof log === 'function' });
      const manifest = hooked.apply.beginManifest(config.gameDir, config.exePath, config.api);
      manifest.route = 'optiscaler';
      return manifest;
    };
    const config = { gameDir: dir, exePath: path.join(dir, 'Game.exe'), api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64,
      route: 'optiscaler', antiCheatAcknowledged: false, emulator: null, source: { payload: [] }, optiRoot: path.join(dir, 'release'), companions: [] };
    const events = [];
    const result = await outcome(() => mod.install(config, e => events.push(e)));
    return { result: normalise(result, dir), events: normalise(events, dir), calls, tree: normalise(tree(dir), dir) };
  };
  const a = await run(upstream.backends, 'upstream-backend');
  const b = await run(hooked.backends, 'hooked-backend');
  assert.deepEqual(b, a);
  assert.equal(a.calls.length, 1, 'the copy step ran once');
  assert.equal(a.result.value.route, 'optiscaler');
});

// main.js:1657, :1658-1663 and :1718-1719, through the vm harness
// test/history-ipc.test.js uses, against the oracle main.js.
function loadMain(source, userData, options) {
  const main = path.join(root, 'main.js');
  const realRequire = Module.createRequire(main);
  const handlers = new Map();
  const dialogs = [];
  const stubs = {
    electron: { app: { setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => userData },
      BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getContentSize: () => [1280, 860] }) },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showMessageBox: async (_window, o) => { dialogs.push(o.title); return { response: 0 }; } },
      clipboard: { writeText() {} } },
    './src/core/scan.js': { scanGame: async () => ({ chosen: options.target, exeCandidates: [options.target], hasNativeDlss: true }) },
    './src/core/compatibility': { assertSafeTarget() {}, hasAntiCheat: () => false },
    './src/core/install-guards': { assertGameClosed: async () => {}, antiCheatPresent: () => false, gpuInfo: async () => [{ name: 'NVIDIA GeForce RTX 5090', driver: '616.56' }],
      gpuSupported: () => true, gpuModelSupported: () => true, driverSupported: () => true, driverNeuralFault: () => false, driverNames: () => '' },
    './src/shared/install-routes': { nativeDlssPresent: () => true, routesFor: () => ['native', 'feeder', 'optiscaler'], recommendedRoute: () => 'native' },
    './src/core/runtime-components.js': { missingVCRuntime: () => [], ensureLumenite: async () => null },
    './src/core/backend-manager': { readManifest: () => null, install: async config => ({ version: 1, route: config.route, api: config.api, game: { exe: 'Game.exe' }, replaced: [], added: [] }) }
  };
  const context = vm.createContext({ require: name => stubs[name] || realRequire(name), __dirname: root, process, Buffer, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: main });
  vm.runInContext('payload = () => ({ source: { feeder: { ok32: true, ok64: true } } }); companionAddons = () => [];', context);
  return { handlers, dialogs };
}

// [test->proton-install-core~31~5]
test('the install handler off Linux returns and emits what upstream did at every replaced site', async (t) => {
  const sources = { upstream: execFileSync('git', ['-C', root, 'show', `${ORACLE}:main.js`], { encoding: 'utf8' }), hooked: fs.readFileSync(path.join(root, 'main.js'), 'utf8') };
  const originals = { ensureOptiScaler: optiscaler.ensureOptiScaler, checkConflicts: optiscaler.checkConflicts };
  t.after(() => Object.assign(optiscaler, originals));
  const pinned = optiscaler.RELEASES[1].version;
  const scenarios = [
    { route: 'native', api: 'dxgi' },
    { route: 'feeder', api: 'dxgi' },
    { route: 'native', api: 'vulkan' },
    { route: 'optiscaler', api: 'dxgi' },
    { route: 'optiscaler', api: 'dxgi', wanted: pinned },
    { route: 'optiscaler', api: 'dxgi', download: 'fails' }
  ];
  for (const [i, s] of scenarios.entries()) {
    const run = async (side) => {
      const userData = temp(t, `${side}-main-${i}`);
      const game = path.join(userData, 'game');
      fs.mkdirSync(game);
      fs.writeFileSync(path.join(game, 'Game.exe'), 'exe');
      if (s.wanted) fs.writeFileSync(path.join(userData, 'library.json'), JSON.stringify({ optiscalerVersion: { [path.resolve(game).toLowerCase()]: s.wanted } }));
      const target = { path: path.join(game, 'Game.exe'), rel: 'Game.exe', bitness: 64, api: s.api, apiLabel: 'DirectX 12' };
      const ensured = [];
      optiscaler.checkConflicts = () => {};
      optiscaler.ensureOptiScaler = async (cacheRoot, version) => {
        ensured.push([cacheRoot, version]);
        if (s.download === 'fails') throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' });
        return path.join(cacheRoot, 'components', `OptiScaler-${version}`);
      };
      const { handlers, dialogs } = loadMain(sources[side], userData, { target });
      const events = [];
      const result = await handlers.get('install')({ sender: { send: (_channel, e) => events.push(e) } }, game, target.path, s.route, s.api);
      return normalise({ result, events, dialogs, ensured }, userData);
    };
    const a = await run('upstream');
    const b = await run('hooked');
    assert.deepEqual(b, a, `scenario ${i}: ${JSON.stringify(s)}`);
    if (s.download === 'fails') assert.equal(a.result.code, 'errOptiDownload', `scenario ${i} reached the ensure step and failed there`);
    else assert.equal(a.result.ok, true, `scenario ${i} installed`);
    if (s.wanted) {
      assert.deepEqual(a.ensured, [['<game>', pinned]], `scenario ${i} ensured the pinned build`);
      assert.equal(a.events.find(e => e.code === 'optiVerified').params.version, pinned, `scenario ${i} reported it`);
    }
  }
});
