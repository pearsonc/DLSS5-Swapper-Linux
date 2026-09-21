'use strict';

const fs = require('fs');
const path = require('path');
const { entries: annexAEntries } = require('./entries');

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
// proton-install-core~9~4; refuses a native Linux game per ~7~1; refuses,
// before the install transaction opens, where the game folder already holds
// files from an earlier install of any Annex A route (~18~1) and then where
// the backup directory holds a live manifest (~40~3), in that order, per
// ADR-014. `entries` is injectable for a test's own fixture table and
// defaults to Annex A's own entries.
function routeGate(options = {}) {
  if (process.platform !== 'linux') return null;

  const {
    route, api, apiLabel, bitness, emulator, nativeDlss,
    gameDir, exePath, proton, nativeLinuxGame,
    entries: table = annexAEntries
  } = options;

  if (nativeLinuxGame) {
    return {
      ok: false,
      code: 'errLinuxNativeGame',
      message: 'This is a native Linux game; the Proton install routes this app offers do not apply to it.'
    };
  }

  if (!proton) {
    return { ok: false, code: 'errProtonRequired', message: 'This installer supports Windows games launched through Steam Proton. Launch the game once with Proton, then try again.' };
  }
  if (api === 'vulkan') {
    return { ok: false, code: 'errLinuxVulkanUnsupported', message: 'The Vulkan Feeder route needs a host Vulkan layer and is not supported on Linux yet. Select a DirectX renderer in the game.' };
  }

  const allowed = findAllowedEntry(table, { route, apiLabel, bitness, emulator, nativeDlss });
  if (!allowed) {
    return {
      ok: false,
      code: 'errLinuxRouteNotAllowed',
      message: `Route ${route || 'unknown'} with ${apiLabel || api || 'an unknown API'} at ${bitness || 'unknown'}-bit is not offered on Linux. No evidence gathered on Thor.`
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
