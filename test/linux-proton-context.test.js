'use strict';
// proton-install-core~1~1, ~2~4, ~3~1, ~4~3, ~5~5, ~8~2: the Proton context
// resolver. Every fixture lives under os.tmpdir() and is removed after each
// test; no real Steam file is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { protonContext, unresolvedJobEvent } = require('../src/linux/proton-context');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-proton-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeToolManifest(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'toolmanifest.vdf'), '"manifest"\n{\n  "version" "2"\n}\n');
}

// A Steam root whose own libraryfolders.vdf names a second library, per the
// spike's real layout: no Steam root on Thor holds the 18 real prefixes.
function baseFixture(root) {
  const rootApps = path.join(root, 'steamapps');
  fs.mkdirSync(rootApps, { recursive: true });
  const library = path.join(root, 'library');
  const libraryApps = path.join(library, 'steamapps');
  fs.mkdirSync(libraryApps, { recursive: true });
  fs.writeFileSync(path.join(rootApps, 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n  "1"\n  {\n    "path"  "${library.replace(/\\/g, '\\\\')}"\n  }\n}\n`);
  return { rootApps, library, libraryApps };
}

// [test->proton-install-core~1~1]
test('the prefix is taken from the library that lists the game, not from a decoy under the Steam root', () => {
  const root = tmp(test);
  const { rootApps, library, libraryApps } = baseFixture(root);
  const appid = 990080;

  // A decoy, empty compatdata/<appid> under the Steam root, as upstream's own
  // library.js:123 would have built it, and Steam's own '0'.
  fs.mkdirSync(path.join(rootApps, 'compatdata', String(appid)), { recursive: true });
  fs.mkdirSync(path.join(rootApps, 'compatdata', '0'), { recursive: true });

  // The listing library: an appmanifest naming the game, and the real prefix
  // with a config_info whose line 2 resolves inside a toolmanifest.vdf child.
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const commonDir = path.join(libraryApps, 'common');
  const buildDir = path.join(commonDir, 'Proton Hotfix');
  writeToolManifest(buildDir);
  const fontsDir = path.join(buildDir, 'files', 'share', 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `11.0-100\n${fontsDir}\nrest\n`);

  const game = { id: appid, steamRoot: root, dir: path.join(commonDir, 'Hogwarts Legacy') };
  const result = protonContext(() => { throw new Error('must not be called on Linux'); }, game, [root]);

  assert.equal(result.prefix, path.join(prefixDir, 'pfx'));
  assert.equal(fs.realpathSync(result.build), fs.realpathSync(buildDir));
  assert.equal(result.reason, null);
});

// [test->proton-install-core~8~2]
test('the resolver is one function returning the prefix, the build and a reason', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 12345;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const commonDir = path.join(libraryApps, 'common');
  const buildDir = path.join(commonDir, 'GE-Proton10-20');
  writeToolManifest(buildDir);
  const insideBuild = path.join(buildDir, 'files', 'bin');
  fs.mkdirSync(insideBuild, { recursive: true });
  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `10-20\n${insideBuild}\n`);

  const game = { id: appid, steamRoot: root, dir: path.join(commonDir, 'Some Game') };
  const result = protonContext(() => null, game, [root]);

  assert.deepEqual(Object.keys(result).sort(), ['build', 'prefix', 'reason']);
  assert.equal(result.prefix, path.join(prefixDir, 'pfx'));
  assert.equal(fs.realpathSync(result.build), fs.realpathSync(buildDir));
  assert.equal(result.reason, null);
});

// [test->proton-install-core~2~4]
test('a creating build resolves through a compatibilitytool.vdf install_path, inside a child holding its own toolmanifest.vdf', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 22200;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');

  const toolRoot = path.join(root, 'compatibilitytools.d');
  const toolDir = path.join(toolRoot, 'GE-Proton10-20');
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, 'compatibilitytool.vdf'),
    '"compatibilitytools"\n{\n  "compat_tools"\n  {\n    "GE-Proton10-20"\n    {\n      "install_path" "t/dist"\n' +
    '      "display_name" "GE-Proton10-20"\n    }\n  }\n}\n');
  const distDir = path.join(toolDir, 't', 'dist');
  writeToolManifest(distDir);
  const insideDist = path.join(distDir, 'files', 'share', 'fonts');
  fs.mkdirSync(insideDist, { recursive: true });

  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `10-20\n${insideDist}\n`);

  const game = { id: appid, steamRoot: root, dir: path.join(libraryApps, 'common', 'Some Game') };
  const result = protonContext(() => null, game, [root]);

  assert.equal(fs.realpathSync(result.build), fs.realpathSync(distDir));
  assert.equal(result.reason, null);
});

// [test->proton-install-core~2~4]
test('config_info line 2 inside a child with no toolmanifest.vdf leaves the context unresolved', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 33300;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const commonDir = path.join(libraryApps, 'common');
  const unmanifested = path.join(commonDir, 'Steam Linux Runtime');
  const inside = path.join(unmanifested, 'files');
  fs.mkdirSync(inside, { recursive: true });

  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `10-20\n${inside}\n`);

  const game = { id: appid, steamRoot: root, dir: path.join(commonDir, 'Some Game') };
  const result = protonContext(() => null, game, [root]);

  assert.equal(result.build, null);
  assert.equal(result.reason.code, '~2~4');
  assert.equal(result.reason.path, inside);
});

// [test->proton-install-core~2~4]
test('config_info line 2 naming the game\'s own folder leaves the context unresolved', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 44400;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const commonDir = path.join(libraryApps, 'common');
  const gameDir = path.join(commonDir, 'Some Game');
  fs.mkdirSync(gameDir, { recursive: true });

  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `10-20\n${gameDir}\n`);

  const game = { id: appid, steamRoot: root, dir: gameDir };
  const result = protonContext(() => null, game, [root]);

  assert.equal(result.build, null);
  assert.equal(result.reason.code, '~2~4');
});

// [test->proton-install-core~3~1]
test('an unreadable Steam file leaves the context unresolved and names the file', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 55500;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  // config_info is a directory, not a file: unreadable as a text file.
  fs.mkdirSync(path.join(prefixDir, 'config_info'), { recursive: true });

  const game = { id: appid, steamRoot: root, dir: path.join(libraryApps, 'common', 'Some Game') };
  const result = protonContext(() => null, game, [root]);

  assert.equal(result.reason.code, '~3~1');
  assert.equal(result.reason.file, path.join(prefixDir, 'config_info'));
  assert.equal(result.prefix, path.join(prefixDir, 'pfx'), 'the game keeps listing, the prefix already found');
});

// [test->proton-install-core~4~3]
test('an identifiable tool whose directory differs from the creating build leaves the context unresolved, naming both', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 66600;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const commonDir = path.join(libraryApps, 'common');
  const buildDir = path.join(commonDir, 'Proton Hotfix');
  writeToolManifest(buildDir);
  const inside = path.join(buildDir, 'files', 'share', 'fonts');
  fs.mkdirSync(inside, { recursive: true });
  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `10-20\n${inside}\n`);

  // CompatToolMapping names a different, identifiable tool.
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'config.vdf'),
    `"InstallConfigStore"\n{\n  "Software"\n  {\n    "Valve"\n    {\n      "Steam"\n      {\n        "CompatToolMapping"\n        {\n          "${appid}"\n          {\n            "name" "GE-Proton10-20"\n          }\n        }\n      }\n    }\n  }\n}\n`);
  const toolRoot = path.join(root, 'compatibilitytools.d');
  const toolDir = path.join(toolRoot, 'GE-Proton10-20');
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, 'compatibilitytool.vdf'),
    '"compatibilitytools"\n{\n  "compat_tools"\n  {\n    "GE-Proton10-20"\n    {\n      "install_path" "."\n    }\n  }\n}\n');

  const game = { id: appid, steamRoot: root, dir: path.join(commonDir, 'Some Game') };
  const result = protonContext(() => null, game, [root]);

  assert.equal(fs.realpathSync(result.build), fs.realpathSync(buildDir));
  assert.equal(result.reason.code, '~4~3');
  assert.equal(fs.realpathSync(result.reason.toolDir), fs.realpathSync(toolDir));
  assert.equal(result.reason.buildDir, result.build);
});

// [test->proton-install-core~4~3]
test('config_info line 2 naming a directory that holds its own toolmanifest.vdf, exactly, not a path inside it, leaves the context unresolved', () => {
  const root = tmp(test);
  const { library, libraryApps } = baseFixture(root);
  const appid = 77700;
  fs.writeFileSync(path.join(libraryApps, `appmanifest_${appid}.acf`), '"AppState"\n{\n}\n');
  const commonDir = path.join(libraryApps, 'common');
  // The game's own folder, which also happens to hold a toolmanifest.vdf:
  // Steam requires the file of every compatibility tool it runs, but this
  // directory is the game folder itself, never a creating build (Annex B,
  // Annex C's Resolver row: "a same-user writer that also plants a
  // toolmanifest.vdf"). Line 2 names this directory exactly, not a path
  // inside it, so it is never "the first path inside the creating build".
  const gameDir = path.join(commonDir, 'Some Game');
  writeToolManifest(gameDir);

  const prefixDir = path.join(libraryApps, 'compatdata', String(appid));
  fs.mkdirSync(path.join(prefixDir, 'pfx'), { recursive: true });
  fs.writeFileSync(path.join(prefixDir, 'config_info'), `10-20\n${gameDir}\n`);

  const game = { id: appid, steamRoot: root, dir: gameDir };
  const result = protonContext(() => null, game, [root]);

  assert.equal(result.build, null);
  assert.equal(result.reason.code, '~2~4');
});

// [test->proton-install-core~5~5]
test('the resolver names a folder Steam does not list, and placement is not refused by the resolver', () => {
  const result = protonContext(() => null, null, ['/nonexistent-steam-root']);
  assert.equal(result.prefix, null);
  assert.equal(result.build, null);
  assert.equal(result.reason.code, 'not-listed');

  const event = unresolvedJobEvent(result);
  assert.equal(event.code, 'linux-proton-unresolved');
  assert.equal(event.params.reason, 'not-listed');
});

// [test->proton-install-core~5~5]
test('the job event names each unresolved reason: ~3~1, ~2~4, ~4~3', () => {
  assert.deepEqual(unresolvedJobEvent({ prefix: null, build: null, reason: { code: '~3~1', file: '/x/config_info' } }),
    { code: 'linux-proton-unresolved', params: { reason: '~3~1', file: '/x/config_info' } });
  assert.deepEqual(unresolvedJobEvent({ prefix: '/p', build: null, reason: { code: '~2~4', path: '/x/y' } }),
    { code: 'linux-proton-unresolved', params: { reason: '~2~4', path: '/x/y' } });
  assert.deepEqual(unresolvedJobEvent({ prefix: '/p', build: '/b', reason: { code: '~4~3', toolDir: '/t', buildDir: '/b' } }),
    { code: 'linux-proton-unresolved', params: { reason: '~4~3', toolDir: '/t', buildDir: '/b' } });
  assert.equal(unresolvedJobEvent({ prefix: '/p', build: '/b', reason: null }), null, 'a resolved context carries no unresolved event');
});

test('off Linux the resolver calls the injected function unchanged (regression only; ~31~6 is u0-barrel-and-hooks\')', () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    let called = null;
    const game = { id: 1 };
    const stub = (g) => { called = g; return { stub: true }; };
    const result = protonContext(stub, game, ['/should-not-be-touched']);
    assert.equal(called, game);
    assert.deepEqual(result, { stub: true });
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
});
