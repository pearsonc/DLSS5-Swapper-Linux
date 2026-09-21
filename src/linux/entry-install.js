'use strict';
const fs = require('fs');
const path = require('path');
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
// buffers so an invalid one can be named by its bytes rather than opened.
// Refuses past `bound` entries, naming the count the walk stopped at, and
// refuses a name that is not valid UTF-8, naming its escaped bytes. Neither
// refusal writes anything: the record is only returned once the walk
// completes clean.
function walkBeforeRecord(exeDir, bound) {
  const record = [];
  let count = 0;

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
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);
      const lstat = fs.lstatSync(abs);
      const kind = kindOf(lstat);
      count += 1;
      if (count > bound) {
        throw fail('errLinuxRecordTooLarge', `The executable folder holds more than ${bound} entries; the walk stopped at ${count}.`, { count });
      }
      const item = { rel, kind, mode: lstat.mode & 0o7777 };
      if (kind === 'file') {
        item.size = lstat.size;
        item.mtimeMs = Math.floor(lstat.mtimeMs);
      }
      record.push(item);
      if (kind === 'dir') visit(abs, rel);
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

const relKey = (rel) => path.normalize(String(rel)).toLowerCase();

// A minimal tracked write, kept free of src/core/apply.js so this module
// requires nothing that requires the barrel back, per the acyclic graph
// running-game.js's delegate keeps: backs up an existing target once under
// the manifest's backupPrefix, records it as `replaced` or `added`, then
// copies the file in.
function placeTracked(manifest, gameDir, backupRoot, src, dest, newVersion) {
  const rel = path.relative(gameDir, dest);
  const key = relKey(rel);
  const existed = fs.existsSync(dest);
  if (existed) {
    const alreadyAdded = manifest.added.some((item) => relKey(item) === key);
    if (!alreadyAdded) {
      const backupPath = path.join(backupRoot, manifest.backupPrefix, rel);
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(dest, backupPath);
      }
      const previous = manifest.replaced.find((item) => relKey(item.rel) === key);
      if (previous) previous.newVersion = newVersion;
      else manifest.replaced.push({ rel, newVersion });
    }
  } else if (!manifest.added.some((item) => relKey(item) === key)) {
    manifest.added.push(rel);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// backend-manager.js's optiscaler branch lands here. Off Linux the hook is a
// passthrough to what upstream's call returned for the same arguments
// (proton-install-core~31~6). On Linux it re-reads the backup directory for a
// live manifest (ADR-014's safeguard for a manifest written between the route
// gate's read and here), records the before-install record before its first
// write (proton-install-core~34~4, ~39~3), re-runs the running-game check
// once the record is written and before the first write outside the backup
// directory (proton-install-core~37~1), places the entry's files inside the
// game folder and never into the Proton prefix (proton-install-core~6~1,
// ~16~2), and emits the launch-options job event once they are placed
// (proton-install-core~11~5).
async function installEntry(options) {
  const { log, ensuredRoot, ...config } = options;
  if (process.platform !== 'linux') return optiscaler.install(config, log);

  const { entry, gameDir, exePath, releaseDir, manifest, guard, bound = DEFAULT_BOUND } = options;
  const emit = typeof log === 'function' ? log : () => {};
  const backupRoot = path.join(gameDir, BACKUP_DIR);
  const manifestPath = path.join(backupRoot, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    throw fail('errBackendRecovery', `A manifest already exists under the backup directory: ${manifestPath}`, { path: manifestPath });
  }

  const exeDir = path.dirname(exePath);
  const started = Date.now();
  const record = walkBeforeRecord(exeDir, bound);
  const ms = Date.now() - started;
  manifest.linuxBefore = record;
  emit({ code: 'linux-record-written', params: { entries: record.length, ms } });

  if (typeof guard !== 'function') throw fail('errLinuxGuard', 'The running-game guard is not a function');
  await guard();

  for (const row of entry.placement) {
    const src = sourcePath(row, ensuredRoot, releaseDir);
    const dest = path.join(exeDir, row.placedAs);
    placeTracked(manifest, gameDir, backupRoot, src, dest, row.fileVersion);
  }

  emit({ code: 'linux-launch-options', params: { entry: entry.id, cell: entry.launchOptions } });

  return manifest;
}

module.exports = { installEntry };
