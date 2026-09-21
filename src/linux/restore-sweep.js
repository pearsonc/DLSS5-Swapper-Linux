'use strict';
// apply.js's restore hands its own restoreFiles in. Off Linux the hook calls
// it unchanged and returns what it returned (proton-install-core~31~6). On
// Linux it withholds an entry restoreFiles cannot safely touch, runs
// restoreFiles over the rest, then sweeps the executable folder: an unlisted
// entry moves into the swept directory, and a listed entry the sweep's own
// walk finds still of its recorded kind gets its recorded mode back through a
// descriptor the walk itself opened, per proton-install-core~22~6, ~23~5,
// ~24~3, ~35~5, ~36~2 and ~38~1, and Annex D's Restore row of
// proton-install-core-spec.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_DIR = '_DLSS5_Backup';

function toRel(gameDir, absPath) {
  return path.relative(gameDir, absPath).split(path.sep).join('/');
}

function lstatOrNull(absPath) {
  try {
    return fs.lstatSync(absPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function kindOf(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return 'link';
  return 'other';
}

// The rel, against gameDir, of the first symbolic link found at the target
// path itself or at any directory between it and the executable folder,
// exclusive of the executable folder itself; null where none stands.
function findBlockingLink(gameDir, exeDirAbs, rel) {
  const target = path.join(gameDir, rel);
  const exeResolved = path.resolve(exeDirAbs);
  let node = target;
  while (true) {
    const stat = lstatOrNull(node);
    if (stat && stat.isSymbolicLink()) return toRel(gameDir, node);
    if (path.resolve(node) === exeResolved) return null;
    const parent = path.dirname(node);
    if (parent === node) return null;
    node = parent;
  }
}

function isPlainDir(absPath) {
  const stat = lstatOrNull(absPath);
  return !!stat && stat.isDirectory();
}

// Opens the walk's own path with O_NOFOLLOW, matches the descriptor's fstat
// against the walk's own lstat by device, inode and kind, requires one link
// for a file, and requires the descriptor's own path to resolve under the
// canonical executable folder, before setting the recorded mode through that
// descriptor. Any failure along the way is reported, not retried and not
// worked around: the file is left exactly as found.
function restoreMode(absPath, walkStat, recordedMode, exeRealPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    return { ok: false, reason: error.code || String(error) };
  }
  try {
    const fstat = fs.fstatSync(fd);
    if (fstat.dev !== walkStat.dev || fstat.ino !== walkStat.ino || kindOf(fstat) !== kindOf(walkStat)) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    if (kindOf(fstat) === 'file' && fstat.nlink !== 1) {
      return { ok: false, reason: 'link-count' };
    }
    let resolved;
    try {
      resolved = fs.realpathSync(`/proc/self/fd/${fd}`);
    } catch (error) {
      return { ok: false, reason: error.code || String(error) };
    }
    if (resolved !== exeRealPath && !resolved.startsWith(exeRealPath + path.sep)) {
      return { ok: false, reason: 'outside-executable-folder' };
    }
    fs.fchmodSync(fd, recordedMode);
    return { ok: true };
  } finally {
    fs.closeSync(fd);
  }
}

async function moveIntoSwept(gameDir, backupRootAbs, uuid, absSource, relInsideExeDir) {
  if (!isPlainDir(backupRootAbs)) return { ok: false, reason: 'ENOTDIR' };
  const sweptRootAbs = path.join(backupRootAbs, 'swept');
  if (!isPlainDir(sweptRootAbs)) {
    try {
      await fs.promises.mkdir(sweptRootAbs);
    } catch (error) {
      if (error.code !== 'EEXIST') return { ok: false, reason: error.code || String(error) };
    }
  }
  if (!isPlainDir(sweptRootAbs)) return { ok: false, reason: 'ENOTDIR' };
  const sweptUuidAbs = path.join(sweptRootAbs, uuid);
  if (!isPlainDir(sweptUuidAbs)) {
    try {
      await fs.promises.mkdir(sweptUuidAbs);
    } catch (error) {
      if (error.code !== 'EEXIST') return { ok: false, reason: error.code || String(error) };
    }
  }
  if (!isPlainDir(sweptUuidAbs)) return { ok: false, reason: 'ENOTDIR' };
  const dest = path.join(sweptUuidAbs, relInsideExeDir);
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  } catch (error) {
    return { ok: false, reason: error.code || String(error) };
  }
  try {
    await fs.promises.rename(absSource, dest);
    return { ok: true, to: path.relative(gameDir, dest).split(path.sep).join('/') };
  } catch (error) {
    return { ok: false, reason: error.code || String(error) };
  }
}

async function restoreSweep(restoreFiles, gameDir, manifest, onLog) {
  const log = (code, params) => onLog && onLog({ code, params: params || {} });

  if (process.platform !== 'linux') return restoreFiles(gameDir, manifest, onLog);

  const exeDirAbs = path.dirname(path.join(gameDir, manifest.game.exe));
  const backupRootAbs = path.join(gameDir, BACKUP_DIR);
  const backupPrefix = manifest.backupPrefix || '';

  const originalPath = rel => path.join(backupRootAbs, backupPrefix, rel);

  const withheldReplaced = new Set();
  const withheldAdded = new Set();
  const blockedPaths = new Set();
  const absent = [];

  for (const item of manifest.replaced || []) {
    const target = path.join(gameDir, item.rel);
    const stat = lstatOrNull(target);
    const blockingLink = findBlockingLink(gameDir, exeDirAbs, item.rel);
    if (blockingLink) blockedPaths.add(blockingLink);
    if ((stat && (stat.isDirectory() || stat.isSymbolicLink())) || blockingLink) {
      withheldReplaced.add(item.rel);
      const backupAbs = originalPath(item.rel);
      const backupExists = !!lstatOrNull(backupAbs);
      absent.push({ rel: item.rel, backup: backupExists ? path.relative(gameDir, backupAbs).split(path.sep).join('/') : null });
    }
  }
  for (const rel of manifest.added || []) {
    const target = path.join(gameDir, rel);
    const stat = lstatOrNull(target);
    const blockingLink = findBlockingLink(gameDir, exeDirAbs, rel);
    if (blockingLink) blockedPaths.add(blockingLink);
    if (!stat) {
      absent.push({ rel, backup: null });
    } else if (stat.isDirectory() || stat.isSymbolicLink() || blockingLink) {
      withheldAdded.add(rel);
      absent.push({ rel, backup: null });
    }
  }

  const filteredManifest = Object.assign({}, manifest, {
    replaced: (manifest.replaced || []).filter(item => !withheldReplaced.has(item.rel)),
    added: (manifest.added || []).filter(rel => !withheldAdded.has(rel))
  });

  const result = await restoreFiles(gameDir, filteredManifest, onLog);

  if (!Array.isArray(manifest.linuxBefore)) {
    log('linux-restore-no-record', {});
    return result;
  }

  if (absent.length) log('linux-restore-incomplete', { absent, kept: [] });

  const record = manifest.linuxBefore;
  const recordByRel = new Map(record.map(entry => [entry.rel, entry]));
  const ownedRels = new Set([...(manifest.added || []), ...(manifest.replaced || []).map(item => item.rel)]);
  const withheld = new Set([...withheldReplaced, ...withheldAdded, ...blockedPaths]);
  const visited = new Set();
  const exeRealPath = fs.realpathSync(exeDirAbs);
  const uuid = crypto.randomUUID();

  // Walked and swept together, one directory at a time: an unlisted
  // directory moves whole, per Annex D, so its children are never separately
  // visited once the move has been attempted.
  async function sweepDir(dirAbs) {
    const names = fs.readdirSync(dirAbs, { encoding: 'buffer' })
      .map(b => b.toString('utf8'))
      .sort();
    for (const name of names) {
      const abs = path.join(dirAbs, name);
      if (path.resolve(abs) === path.resolve(backupRootAbs)) continue;
      const stat = fs.lstatSync(abs);
      const rel = toRel(gameDir, abs);
      if (withheld.has(rel)) continue;
      const rec = recordByRel.get(rel);

      if (!rec) {
        const relInsideExeDir = path.relative(exeDirAbs, abs).split(path.sep).join('/');
        const outcome = await moveIntoSwept(gameDir, backupRootAbs, uuid, abs, relInsideExeDir);
        if (outcome.ok) log('linux-restore-sweep', { rel, outcome: 'moved', to: outcome.to });
        else log('linux-restore-sweep', { rel, outcome: 'move-failed', reason: outcome.reason });
        continue; // moved whole, or left exactly as found; either way not visited further
      }

      visited.add(rel);
      const walkKind = kindOf(stat);
      if (walkKind !== rec.kind) {
        log('linux-restore-sweep', { rel, outcome: 'kind', found: walkKind });
        continue;
      }

      if (!ownedRels.has(rel) && walkKind === 'file') {
        if (stat.size !== rec.size || Math.floor(stat.mtimeMs) !== rec.mtimeMs) {
          log('linux-restore-sweep', { rel, outcome: 'changed' });
          continue;
        }
      }

      const outcome = restoreMode(abs, stat, rec.mode, exeRealPath);
      if (!outcome.ok) log('linux-restore-sweep', { rel, outcome: 'unmatched', reason: outcome.reason });

      if (stat.isDirectory()) await sweepDir(abs);
    }
  }

  await sweepDir(exeDirAbs);

  for (const entry of record) {
    if (visited.has(entry.rel) || ownedRels.has(entry.rel)) continue;
    log('linux-restore-sweep', { rel: entry.rel, outcome: 'gone' });
  }

  return result;
}

module.exports = { restoreSweep };
