'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const optiscaler = require('../core/optiscaler');

const BACKUP_DIR = '_DLSS5_Backup';
const DEFAULT_BOUND = 100000;

function fail(code, message, params) {
  return Object.assign(new Error(message), { code, params: params || {} });
}

function escapeBytes(buf) {
  let out = '';
  for (const byte of buf) {
    out += (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : '\\x' + byte.toString(16).padStart(2, '0');
  }
  return out;
}

function isValidUtf8(buf) {
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

function kindOf(lstat) {
  if (lstat.isFile()) return 'file';
  if (lstat.isDirectory()) return 'dir';
  if (lstat.isSymbolicLink()) return 'link';
  return 'other';
}

// The before-install record's walk, Annex B: one entry per file, directory,
// symbolic link or other entry under the executable folder, the install's
// backup directory excluded, following no symbolic link, names read as
// buffers so an invalid one can be named by its bytes rather than opened,
// `rel` relative to the game folder (review finding conformance 4-4,
// reversibility 6-1: the sweep reads `rel` against the game folder too).
// Refuses past `bound` entries, naming the count the walk stopped at, and
// refuses a name that is not valid UTF-8, naming its escaped bytes. Neither
// refusal writes anything: the record is only returned once the walk
// completes clean.
function walkBeforeRecord(exeDir, gameDir, bound) {
  const record = [];
  let count = 0;
  const exeDirRel = path.relative(gameDir, exeDir).split(path.sep).join('/');
  const toGameRel = (localRel) => (exeDirRel ? `${exeDirRel}/${localRel}` : localRel);

  function visit(absDir, relDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true, encoding: 'buffer' })
      .sort((a, b) => Buffer.compare(a.name, b.name));
    for (const dirent of entries) {
      const nameBuf = dirent.name;
      if (relDir === '' && nameBuf.toString('latin1') === BACKUP_DIR) continue;
      if (!isValidUtf8(nameBuf)) {
        throw fail('errLinuxInvalidName', `An entry name is not valid UTF-8: ${escapeBytes(nameBuf)}`, { bytes: escapeBytes(nameBuf) });
      }
      const name = nameBuf.toString('utf8');
      const localRel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);
      const lstat = fs.lstatSync(abs);
      const kind = kindOf(lstat);
      count += 1;
      if (count > bound) {
        throw fail('errLinuxRecordTooLarge', `The executable folder holds more than ${bound} entries; the walk stopped at ${count}.`, { count });
      }
      const item = { rel: toGameRel(localRel), kind, mode: lstat.mode & 0o7777 };
      if (kind === 'file') {
        item.size = lstat.size;
        item.mtimeMs = Math.floor(lstat.mtimeMs);
      }
      record.push(item);
      if (kind === 'dir') visit(abs, localRel);
    }
  }

  visit(exeDir, '');
  return record;
}

function sourcePath(row, ensuredRoot, releaseDir) {
  if (row.source === 'archive') return path.join(ensuredRoot, row.member);
  if (row.source === 'release') return path.join(releaseDir, row.member);
  return path.join(ensuredRoot, row.member);
}

// Security finding 1: before any write, every path component of every
// placement target under the executable folder is checked by lstat, never
// followed, so a link planted at an intermediate component or at the
// placement path itself refuses rather than writing through it. Review
// remedy C: the final component is resolved through the barrel's
// caseAwareTarget first, as placeTracked's own write will resolve it, so a
// link at `DXGI.dll` refuses a placement of `dxgi.dll` rather than reading
// past it under a name the write never actually lands on.
function assertNoLinkComponent(exeDir, placedAs) {
  const parts = String(placedAs).split(/[\\/]+/).filter(Boolean);
  let current = exeDir;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const name = isLast ? require('../linux').caseAwareTarget(current, parts[i]) : parts[i];
    current = path.join(current, name);
    let lstat;
    try { lstat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (lstat.isSymbolicLink()) {
      throw fail('errLinuxLinkComponent', `A placement path component is a symbolic link: ${current}`, { path: current });
    }
  }
}

// Conformance finding 4-5: a release-sourced file is verified against its
// placement row's SHA-256 before any write, since it comes from the user's
// own release rather than the checksum-verified archive extraction. Review
// remedy C, ~17~2: the refusal names the release directory it looked in.
function assertReleaseChecksum(row, ensuredRoot, releaseDir) {
  if (row.source !== 'release') return;
  const src = sourcePath(row, ensuredRoot, releaseDir);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  if (digest !== row.sha256) {
    throw fail('errLinuxReleaseChecksum',
      `A release file's SHA-256 does not match its placement row: ${row.member}, looked in ${releaseDir}`,
      { path: src, directory: releaseDir, expected: row.sha256, actual: digest });
  }
}

// Conformance finding 4-6: OptiScaler.ini's eight keys, read from
// entry.iniKeys ({ section, key, value }, value null meaning the
// executable's own name), are set after the ini is placed, one key set or
// replaced under its section, a missing section appended.
function applyIniKeys(iniPath, iniKeys, exeName) {
  const text = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
  const lines = text.length ? text.split(/\r?\n/) : [];
  for (const { section, key, value: rawValue } of iniKeys) {
    const value = (rawValue === null || rawValue === undefined) ? exeName : String(rawValue);
    let sectionStart = lines.findIndex((line) => line.trim() === `[${section}]`);
    if (sectionStart === -1) {
      lines.push(`[${section}]`);
      sectionStart = lines.length - 1;
    }
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) { sectionEnd = i; break; }
    }
    let keyLine = -1;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      const match = /^\s*([^=;#\s][^=]*?)\s*=/.exec(lines[i]);
      if (match && match[1] === key) { keyLine = i; break; }
    }
    const line = `${key}=${value}`;
    if (keyLine !== -1) lines[keyLine] = line;
    else lines.splice(sectionEnd, 0, line);
  }
  fs.writeFileSync(iniPath, lines.join('\n'));
}

// backend-manager.js's optiscaler branch lands here. Off Linux the hook is a
// passthrough to what upstream's call returned for the same arguments
// (proton-install-core~31~6). On Linux it re-reads the backup directory for a
// live manifest (ADR-014's safeguard for a manifest written between the route
// gate's read and here), refuses before any write on a link planted at a
// placement path or a release file whose digest does not match (review
// findings security 1, conformance 4-5), records the before-install record
// before its first write (proton-install-core~34~4, ~39~3), re-runs the
// running-game check once the record is written and before the first write
// outside the backup directory (proton-install-core~37~1), places the
// entry's files inside the game folder through the caller's own tracked
// write, never into the Proton prefix (proton-install-core~6~1, ~16~2),
// writes OptiScaler.ini's keys once it is placed (review finding
// conformance 4-6), and emits the launch-options job event once the files
// are placed (proton-install-core~11~5).
async function installEntry(options) {
  const { log, ensuredRoot, ...config } = options;
  if (process.platform !== 'linux') return optiscaler.install(config, log);

  const { entry, gameDir, exePath, releaseDir, manifest, guard, placeTracked, bound = DEFAULT_BOUND } = options;
  const emit = typeof log === 'function' ? log : () => {};
  const backupRoot = path.join(gameDir, BACKUP_DIR);
  const manifestPath = path.join(backupRoot, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    throw fail('errBackendRecovery', `A manifest already exists under the backup directory: ${manifestPath}`, { path: manifestPath });
  }

  const exeDir = path.dirname(exePath);
  for (const row of entry.placement) assertNoLinkComponent(exeDir, row.placedAs);
  for (const row of entry.placement) assertReleaseChecksum(row, ensuredRoot, releaseDir);

  const started = Date.now();
  const record = walkBeforeRecord(exeDir, gameDir, bound);
  const ms = Date.now() - started;
  manifest.linuxBefore = record;
  emit({ code: 'linux-record-written', params: { entries: record.length, ms } });

  // Annex D's copy-step row: guard defaults to the barrel's assertGameClosed,
  // bound to gameDir, exePath and log, when the caller hands none. Required
  // lazily so loading this module, itself one of the barrel's own exports,
  // never reads the barrel's exports object before it is fully built.
  // options.processRoot, absent in production, is a test-only fixture root
  // for the default path: assertGameClosed's own default is the real /proc.
  const guardFn = typeof guard === 'function' ? guard
    : () => require('../linux').assertGameClosed(undefined, gameDir, exePath, undefined, undefined, emit, options.processRoot);
  if (typeof guardFn !== 'function') throw fail('errLinuxGuard', 'The running-game guard is not a function');
  await guardFn();

  if (typeof placeTracked !== 'function') throw fail('errLinuxPlaceTracked', 'placeTracked is not a function');

  let iniDest = null;
  for (const row of entry.placement) {
    const src = sourcePath(row, ensuredRoot, releaseDir);
    const dest = path.join(exeDir, row.placedAs);
    await placeTracked(manifest, gameDir, src, dest, { kind: 'optiscaler', newVersion: row.fileVersion });
    if (/\.ini$/i.test(row.placedAs)) iniDest = dest;
  }

  if (iniDest && Array.isArray(entry.iniKeys) && entry.iniKeys.length) {
    applyIniKeys(iniDest, entry.iniKeys, path.basename(exePath));
  }

  emit({ code: 'linux-launch-options', params: { entry: entry.id, cell: entry.launchOptions } });

  return manifest;
}

module.exports = { installEntry };
