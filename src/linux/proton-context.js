'use strict';

// main.js, in place of contextForSteamGame(protonGame). main.js passes its own
// contextForSteamGame in as the first argument, so this module requires
// nothing from src/core/ and the barrel's require graph stays acyclic. Off
// Linux the passthrough hands the game straight to upstream's resolver.
//
// On Linux (proton-install-core~1~1, ~2~4, ~3~1, ~4~3, ~8~2) the prefix is
// not built under the Steam root the way upstream's src/library.js:123 does:
// it is taken from whichever Steam library actually lists the game in its
// own libraryfolders.vdf, since a game and its prefix can sit in a library
// the Steam root does not hold. The creating build is read from the second
// line of that prefix's config_info, canonicalised, and accepted only where
// it sits inside a directory that holds a toolmanifest.vdf and is either a
// child of an enumerated directory (a library's steamapps/common or a tool
// root) or the directory a compatibilitytool.vdf in a tool root names as its
// install_path. Where Steam's CompatToolMapping names an identifiable tool
// for the game, its directory is cross-checked against the creating build.
const fs = require('fs');
const path = require('path');

function canonical(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

// True where `child` is strictly inside `parent` (not equal to it), per
// Annex B: a directory without a toolmanifest.vdf, the game folder included,
// is never a creating build, and the build is the directory itself, never a
// parent whose child is sought.
function isStrictlyInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '.' && rel !== '..' &&
    !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function vdfPaths(text) {
  const out = [];
  for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

function toolRootsOf(roots) {
  const dirs = [];
  for (const root of roots) dirs.push(path.join(root, 'compatibilitytools.d'));
  if (process.env.STEAM_EXTRA_COMPAT_TOOLS_PATHS) {
    for (const p of process.env.STEAM_EXTRA_COMPAT_TOOLS_PATHS.split(':')) if (p) dirs.push(p);
  }
  dirs.push('/usr/share/steam/compatibilitytools.d', '/usr/local/share/steam/compatibilitytools.d');
  return dirs;
}

// Every library across every root: the root itself, plus what its own
// libraryfolders.vdf names, per Annex B's "the enumerated directories".
// Returns null and the file it could not read where libraryfolders.vdf
// exists but cannot be read, for proton-install-core~3~1.
function librariesOf(roots) {
  const libs = [];
  for (const root of roots) {
    if (!libs.includes(root)) libs.push(root);
    const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdfPath)) continue;
    let text;
    try { text = fs.readFileSync(vdfPath, 'utf8'); }
    catch { return { error: vdfPath }; }
    for (const p of vdfPaths(text)) if (!libs.includes(p)) libs.push(p);
  }
  return { libs };
}

// The library whose own steamapps/appmanifest_<id>.acf lists the appid, per
// proton-install-core~1~1: the prefix comes from this library, not from the
// root the game was enumerated under.
function listingLibraryOf(libs, appid) {
  for (const lib of libs) {
    if (fs.existsSync(path.join(lib, 'steamapps', `appmanifest_${appid}.acf`))) return lib;
  }
  return null;
}

// A child of `dir` holding toolmanifest.vdf, whose canonical path strictly
// contains `canonicalTarget`.
function manifestChildContaining(dir, canonicalTarget) {
  let children;
  try { children = fs.readdirSync(dir); } catch { return null; }
  for (const name of children) {
    const child = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(child); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (!fs.existsSync(path.join(child, 'toolmanifest.vdf'))) continue;
    const canonicalChild = canonical(child);
    if (canonicalChild && isStrictlyInside(canonicalTarget, canonicalChild)) return canonicalChild;
  }
  return null;
}

// The directory a compatibilitytool.vdf under a tool root names as its
// install_path, where that directory itself holds toolmanifest.vdf and
// strictly contains canonicalTarget.
function installPathChildContaining(toolRoot, canonicalTarget) {
  let children;
  try { children = fs.readdirSync(toolRoot); } catch { return null; }
  for (const name of children) {
    const child = path.join(toolRoot, name);
    let stat;
    try { stat = fs.statSync(child); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const installDir = installPathOf(child);
    if (!installDir) continue;
    if (!fs.existsSync(path.join(installDir, 'toolmanifest.vdf'))) continue;
    const canonicalInstall = canonical(installDir);
    if (canonicalInstall && isStrictlyInside(canonicalTarget, canonicalInstall)) return canonicalInstall;
  }
  return null;
}

// Reads a tool root child's compatibilitytool.vdf and resolves its
// install_path, relative to that manifest's own directory unless absolute.
function installPathOf(toolDir) {
  const manifestFile = path.join(toolDir, 'compatibilitytool.vdf');
  if (!fs.existsSync(manifestFile)) return null;
  let text;
  try { text = fs.readFileSync(manifestFile, 'utf8'); } catch { return null; }
  const m = text.match(/"install_path"\s+"([^"]+)"/);
  if (!m) return null;
  return path.isAbsolute(m[1]) ? m[1] : path.join(toolDir, m[1]);
}

// The identifiable tool's own directory, where CompatToolMapping names one
// for this appid and a compatibilitytool.vdf in a tool root declares it.
// A Valve internal name with no such declaration is not identifiable and is
// not cross-checked, per Annex B.
function identifiableToolDirFor(roots, toolRoots, appid) {
  for (const root of roots) {
    const configVdf = path.join(root, 'config', 'config.vdf');
    if (!fs.existsSync(configVdf)) continue;
    let text;
    try { text = fs.readFileSync(configVdf, 'utf8'); } catch { continue; }
    const idx = text.indexOf(`"${appid}"`);
    if (idx === -1) continue;
    const nameMatch = text.slice(idx).match(/"name"\s+"([^"]*)"/);
    const toolName = nameMatch ? nameMatch[1] : null;
    if (!toolName) continue;
    for (const toolRoot of toolRoots) {
      const toolDir = path.join(toolRoot, toolName);
      const installDir = installPathOf(toolDir);
      if (!installDir) continue;
      const canonicalInstall = canonical(installDir);
      if (canonicalInstall) return canonicalInstall;
    }
  }
  return null;
}

function protonContext(contextForSteamGame, game, steamRoots) {
  if (process.platform !== 'linux') return contextForSteamGame(game);

  // Annex B: "a game Steam does not list"; its context is unresolved.
  if (!game) return { prefix: null, build: null, reason: { code: 'not-listed' } };

  const roots = (steamRoots && steamRoots.length) ? steamRoots
    : (game.steamRoot ? [game.steamRoot] : []);

  const enumerated = librariesOf(roots);
  if (enumerated.error) return { prefix: null, build: null, reason: { code: '~3~1', file: enumerated.error } };
  const libs = enumerated.libs;

  const appid = game.id;
  const listingLibrary = listingLibraryOf(libs, appid);
  if (!listingLibrary) return { prefix: null, build: null, reason: { code: 'not-listed' } };

  const prefix = path.join(listingLibrary, 'steamapps', 'compatdata', String(appid), 'pfx');
  const compatdataDir = path.join(listingLibrary, 'steamapps', 'compatdata', String(appid));
  const configInfo = path.join(compatdataDir, 'config_info');

  // Annex B: "unlaunched Windows game", the prefix does not exist, named as
  // compatdata/<appid>.
  if (!fs.existsSync(compatdataDir) || !fs.existsSync(configInfo)) {
    return { prefix, build: null, reason: { code: '~3~1', file: compatdataDir } };
  }

  let configText;
  try { configText = fs.readFileSync(configInfo, 'utf8'); }
  catch { return { prefix, build: null, reason: { code: '~3~1', file: configInfo } }; }

  const line2 = (configText.split('\n')[1] || '').trim();
  const canonicalLine2 = line2 ? canonical(line2) : null;
  if (!canonicalLine2) return { prefix, build: null, reason: { code: '~2~4', path: line2 } };

  const toolRoots = toolRootsOf(roots);
  const enumeratedDirs = libs.map((lib) => path.join(lib, 'steamapps', 'common')).concat(toolRoots);

  let build = null;
  for (const dir of enumeratedDirs) {
    build = manifestChildContaining(dir, canonicalLine2);
    if (build) break;
  }
  if (!build) {
    for (const toolRoot of toolRoots) {
      build = installPathChildContaining(toolRoot, canonicalLine2);
      if (build) break;
    }
  }
  if (!build) return { prefix, build: null, reason: { code: '~2~4', path: line2 } };

  const toolDir = identifiableToolDirFor(roots, toolRoots, appid);
  if (toolDir && toolDir !== build) {
    return { prefix, build, reason: { code: '~4~3', toolDir, buildDir: build } };
  }

  return { prefix, build, reason: null };
}

// proton-install-core~5~5: the job event a context's own unresolved reason
// names, whether that reason is `~3~1`, `~2~4`, `~4~3` or the folder is one
// Steam does not list; null for a resolved context, which emits nothing.
function unresolvedJobEvent(context) {
  if (!context || !context.reason) return null;
  const { code, ...rest } = context.reason;
  return { code: 'linux-proton-unresolved', params: { reason: code, ...rest } };
}

module.exports = { protonContext, unresolvedJobEvent };
