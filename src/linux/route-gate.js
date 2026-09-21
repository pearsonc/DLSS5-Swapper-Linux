'use strict';

const fs = require('fs');
const path = require('path');
const { entries: annexAEntries, refusedPairs: annexARefusedPairs } = require('./entries');
const { unresolvedJobEvent } = require('./proton-context');

// Annex B's launch-options cell: the literal `none`, or one
// `WINEDLLOVERRIDES=` assignment matching this pattern; anything else,
// an empty cell included, leaves the pair unlisted.
const LAUNCH_OPTIONS_PATTERN = /^WINEDLLOVERRIDES="[a-z0-9_]+=[nb](,[nb])?(;[a-z0-9_]+=[nb](,[nb])?)*"$/;

function isValidLaunchOptionsCell(cell) {
  return cell === 'none' || LAUNCH_OPTIONS_PATTERN.test(cell || '');
}

// The pair Annex A lists as allowed for this entry, matched on every
// dimension Annex C records for the route surface: route name, API label
// (the label in force after any per-executable override, per ADR-006),
// bitness, emulator profile and native-DLSS presence.
function findAllowedEntry(table, { route, apiLabel, bitness, emulator, nativeDlss }) {
  return table.find((entry) =>
    entry.route === route &&
    entry.apiLabel === apiLabel &&
    entry.bitness === bitness &&
    (entry.emulator || 'none') === (emulator || 'none') &&
    Boolean(entry.nativeDlss) === Boolean(nativeDlss));
}

// Annex B, "files from an earlier install": for an entry, a config file the
// archive writes beside the executable (OptiScaler.ini for A1), found alone,
// or the entry's proxy together with the archive-sourced forwarder that
// shares its name with the release-sourced kept model (nvngx_dlssnr.dll,
// which does not count on its own). Each file is looked for beside the
// executable, whatever kind it is.
function filesFromEarlierInstall(exeDir, entry) {
  const iniRow = (entry.placement || []).find((row) =>
    row.source === 'archive' && /\.ini$/i.test(row.placedAs || ''));
  if (iniRow && fs.existsSync(path.join(exeDir, iniRow.placedAs))) return true;

  const forwarderRow = (entry.placement || []).find((row) =>
    row.source === 'archive' && /nvngx/i.test(row.member || '') && /dlssnr/i.test(row.member || ''));
  if (entry.proxy && forwarderRow &&
    fs.existsSync(path.join(exeDir, entry.proxy)) &&
    fs.existsSync(path.join(exeDir, forwarderRow.placedAs))) {
    return true;
  }
  return false;
}

function earlierInstallRoute(exeDir, table) {
  for (const entry of table) {
    if (filesFromEarlierInstall(exeDir, entry)) return entry.route;
  }
  return null;
}

// A file beside the game's own top level whose first four bytes are the
// ELF magic number and whose mode carries an execute bit: "the folder's
// executables" a native Linux game carries, that a Windows .exe carries
// none of. The first match is enough; which one is not this gate's to name.
function findElfExecutable(gameDir) {
  let names;
  try { names = fs.readdirSync(gameDir, { withFileTypes: true }); } catch { return null; }
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const full = path.join(gameDir, entry.name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!(stat.mode & 0o111)) continue;
    let fd;
    try {
      fd = fs.openSync(full, 'r');
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      if (header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return full;
    } catch {
      // Unreadable: not a match.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return null;
}

// Annex B, "native Linux game": a Steam game that is not a Proton game and
// whose scan finds no Windows executable. Derived here rather than trusted
// from a caller, since no call site computes it, from the game folder's own
// executables and, where the scan carries one, the Steam manifest's own
// launch executable: a scan finding no Windows candidate, together with an
// ELF main binary the folder itself carries or a non-.exe launch executable
// the manifest names that exists, is native. Absent either corroborating
// signal, a folder with no Windows executable is left unjudged (null), not
// refused, so the caller falls through to its own message.
function deriveNativeLinuxGame(gameDir, scan) {
  if (!gameDir || !scan) return false;
  const hasWindowsExe = Boolean(scan.chosen) || (Array.isArray(scan.exeCandidates) && scan.exeCandidates.length > 0);
  if (hasWindowsExe) return false;
  if (findElfExecutable(gameDir)) return true;
  const manifestLaunch = scan.manifestLaunchExecutable;
  if (manifestLaunch && !/\.exe$/i.test(manifestLaunch) && fs.existsSync(path.join(gameDir, manifestLaunch))) return true;
  return false;
}

// Annex A's fourth table: the evidence recorded for a specific refused
// route/label/bitness triple, or the wildcard row naming none of them for
// every other pair, which Annex A always carries, so there is no case of
// this gate's own invention left to fall back to.
function evidenceFor(table, { route, apiLabel, bitness }) {
  const specific = table.find((row) =>
    row.route === route && row.apiLabel === apiLabel && (row.bitness == null || row.bitness === bitness));
  if (specific) return specific.evidence;
  const wildcard = table.find((row) => row.route === null);
  return wildcard.evidence;
}

// Annex B, "a live manifest": manifest.json under the install's backup
// directory, whatever it holds, read by existence. Its route and date are
// read only to name the refusal; a manifest that fails to parse, or carries
// neither field, is named as carrying neither.
function liveManifestInfo(gameDir) {
  const manifestPath = path.join(gameDir, '_DLSS5_Backup', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  let route = null;
  let date = null;
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (data && typeof data === 'object') {
      route = data.route || null;
      date = data.date || null;
    }
  } catch {
    // Carries neither: a manifest this hook cannot read still refuses.
  }
  return { route, date };
}

// main.js:1658-1663, in place of the two inline refusals and the
// earlier-install refusal. Reads Annex A on every dimension Annex C records
// for the route surface, the launch-options cell included, per
// proton-install-core~9~4; refuses a native Linux game per ~7~1, derived
// from `gameDir` and `scan` when the call passes no explicit
// `nativeLinuxGame`; emits `~5~5`'s job event through `log` for an
// unresolved Proton context, which does not itself refuse; refuses, before
// the install transaction opens, where the game folder already holds files
// from an earlier install of any Annex A route (~18~1) and then where the
// backup directory holds a live manifest (~40~3), in that order, per
// ADR-014. `entries` and `refusedPairs` are injectable for a test's own
// fixture tables and default to Annex A's own.
function routeGate(options = {}) {
  if (process.platform !== 'linux') return null;

  const {
    route, api, apiLabel, bitness, emulator, nativeDlss,
    gameDir, exePath, proton, scan, log,
    entries: table = annexAEntries,
    refusedPairs: refusedTable = annexARefusedPairs
  } = options;

  const nativeLinuxGame = options.nativeLinuxGame !== undefined
    ? options.nativeLinuxGame
    : deriveNativeLinuxGame(gameDir, scan);

  if (nativeLinuxGame) {
    return {
      ok: false,
      code: 'errLinuxNativeGame',
      message: 'This is a native Linux game; the Proton install routes this app offers do not apply to it.'
    };
  }

  // main.js:1633's own probe, asked before any route is chosen and where
  // the scan chose no executable: only the native-game verdict applies at
  // that site. Every other case, including a game whose executable the
  // scan simply has not resolved yet, falls through to upstream's own
  // message rather than reaching the dimension checks below with no route
  // to judge them against.
  if (route === undefined) return null;

  // ~5~5: an unresolved context is named in a job event, and the install
  // carries on placing files; it is never a refusal.
  if (proton && proton.reason && typeof log === 'function') {
    const event = unresolvedJobEvent(proton);
    if (event) log(event);
  }

  if (api === 'vulkan') {
    return { ok: false, code: 'errLinuxVulkanUnsupported', message: 'The Vulkan Feeder route needs a host Vulkan layer and is not supported on Linux yet. Select a DirectX renderer in the game.' };
  }

  const allowed = findAllowedEntry(table, { route, apiLabel, bitness, emulator, nativeDlss });
  if (!allowed) {
    const evidence = evidenceFor(refusedTable, { route, apiLabel, bitness });
    return {
      ok: false,
      code: 'errLinuxRouteNotAllowed',
      message: `Route ${route || 'unknown'} with ${apiLabel || api || 'an unknown API'} at ${bitness || 'unknown'}-bit is not offered on Linux. ${evidence}`
    };
  }
  if (!isValidLaunchOptionsCell(allowed.launchOptions)) {
    return {
      ok: false,
      code: 'errLinuxLaunchOptionsCell',
      message: `This entry's launch-options cell, ${JSON.stringify(allowed.launchOptions)}, is not "none" or a WINEDLLOVERRIDES= assignment matching ${LAUNCH_OPTIONS_PATTERN}.`
    };
  }

  if (gameDir && exePath) {
    const exeDir = path.dirname(exePath);
    const foundRoute = earlierInstallRoute(exeDir, table);
    if (foundRoute) {
      return {
        ok: false,
        code: 'errLinuxAlreadyInstalled',
        message: `The game folder already holds files from an earlier install of the ${foundRoute} route. Restore it before installing again.`
      };
    }
  }

  if (gameDir) {
    const live = liveManifestInfo(gameDir);
    if (live) {
      const named = live.route || live.date
        ? `route ${live.route || 'unknown'}, date ${live.date || 'unknown'}`
        : 'neither a route nor a date';
      return {
        ok: false,
        code: 'errLinuxLiveManifest',
        message: `The game folder's backup directory already holds a manifest naming ${named}. Restore it before installing again.`
      };
    }
  }

  return null;
}

module.exports = { routeGate };
