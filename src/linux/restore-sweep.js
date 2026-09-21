'use strict';
// apply.js's restore hands its own restoreFiles in. Off Linux the hook calls
// it unchanged and returns what it returned (proton-install-core~31~6). On
// Linux it withholds an entry restoreFiles cannot safely touch, runs
// restoreFiles over the rest, then sweeps the executable folder: an unlisted
// entry moves into the swept directory, and a listed entry the sweep's own
// walk finds still of its recorded kind gets its recorded mode back through a
// descriptor the walk itself opened, per proton-install-core~22~6, ~23~5,
// ~24~3, ~35~5, ~36~2 and ~38~1, and Annex D's Restore row of
// proton-install-core-spec.md. Names are read as buffers from readdir
// through lstat, rename and the log, escaped by byte where they are not
// valid UTF-8, as entry-install.js's walk escapes them, per the wave-2
// review's finding that a decoded-then-relstat'd name aborts the restore.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_DIR = '_DLSS5_Backup';
const SEP = Buffer.from('/');

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

function bufJoin(dirBuf, nameBuf) {
  return dirBuf.length ? Buffer.concat([dirBuf, SEP, nameBuf]) : nameBuf;
}

// The last path component of a byte path, cut at the final '/', so a
// destination for a name that is not valid UTF-8 can still get a parent
// directory made for it without ever decoding the name.
function bufDirname(buf) {
  const idx = buf.lastIndexOf(0x2f);
  return idx < 0 ? Buffer.alloc(0) : buf.slice(0, idx);
}

// True where a symbolic link stands at the target path itself or at any
// directory between it and the executable folder, inclusive of neither the
// executable folder itself.
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
// worked around: the file is left exactly as found. A recorded mode outside
// 0..0o7777, or not an integer, is untrusted structure and is refused the
// same way rather than handed to fchmod.
function restoreMode(absPath, walkStat, recordedMode, exeRealPath) {
  if (!Number.isInteger(recordedMode) || recordedMode < 0 || recordedMode > 0o7777) {
    return { ok: false, reason: 'invalid-mode' };
  }
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

async function moveIntoSwept(gameDir, backupRootAbs, uuid, absSourceBuf, relInsideExeDirBuf) {
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
  const destBuf = bufJoin(Buffer.from(sweptUuidAbs), relInsideExeDirBuf);
  try {
    await fs.promises.mkdir(bufDirname(destBuf), { recursive: true });
  } catch (error) {
    return { ok: false, reason: error.code || String(error) };
  }
  try {
    await fs.promises.rename(absSourceBuf, destBuf);
    const relLeaf = isValidUtf8(relInsideExeDirBuf) ? relInsideExeDirBuf.toString('utf8') : escapeBytes(relInsideExeDirBuf);
    return { ok: true, to: path.relative(gameDir, sweptUuidAbs).split(path.sep).join('/') + '/' + relLeaf };
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

  const withheldRels = new Set();
  const blockedPaths = new Set();
  const absent = [];
  const kept = [];

  // One assessment for every rel the manifest says the install touched,
  // whatever list it came from: a placed file with a backup to keep, a
  // placed file, directory or ReShade file with none. Returns 'withhold'
  // where the walk must not let restoreFiles or the sweep touch the path.
  function assess(rel, { hasBackup, expectDir }) {
    const target = path.join(gameDir, rel);
    const stat = lstatOrNull(target);
    const blockingLink = findBlockingLink(gameDir, exeDirAbs, rel);
    if (blockingLink) blockedPaths.add(blockingLink);
    if (!stat && !hasBackup && !blockingLink) {
      absent.push({ rel, backup: null });
      return false;
    }
    // A placed or replaced file is blocked by finding a directory or a link
    // where a file belongs; an addedDirs entry is blocked the other way
    // round, by finding anything but the directory the install itself made.
    const wrongKind = stat && (expectDir ? !stat.isDirectory() : (stat.isDirectory() || stat.isSymbolicLink()));
    if (wrongKind || blockingLink) {
      withheldRels.add(rel);
      if (hasBackup) {
        const backupAbs = originalPath(rel);
        const backupExists = !!lstatOrNull(backupAbs);
        kept.push({ rel, backup: backupExists ? path.relative(gameDir, backupAbs).split(path.sep).join('/') : null });
      } else {
        kept.push({ rel, backup: null });
      }
      return true;
    }
    return false;
  }

  for (const item of manifest.replaced || []) assess(item.rel, { hasBackup: true });
  for (const rel of manifest.added || []) assess(rel, { hasBackup: false });
  for (const rel of manifest.addedDirs || []) assess(rel, { hasBackup: false, expectDir: true });
  for (const rel of (manifest.reshade && manifest.reshade.filesAdded) || []) assess(rel, { hasBackup: false });
  if (manifest.reshade && manifest.reshade.file) assess(manifest.reshade.file, { hasBackup: false });

  const filteredManifest = Object.assign({}, manifest, {
    replaced: (manifest.replaced || []).filter(item => !withheldRels.has(item.rel)),
    added: (manifest.added || []).filter(rel => !withheldRels.has(rel)),
    addedDirs: (manifest.addedDirs || []).filter(rel => !withheldRels.has(rel))
  });

  const result = await restoreFiles(gameDir, filteredManifest, onLog);

  if (absent.length || kept.length) log('linux-restore-incomplete', { absent, kept });

  if (!Array.isArray(manifest.linuxBefore)) {
    log('linux-restore-no-record', {});
    return result;
  }

  const record = manifest.linuxBefore;
  const recordByRel = new Map(record.map(entry => [entry.rel, entry]));
  const ownedRels = new Set([
    ...(manifest.added || []),
    ...(manifest.replaced || []).map(item => item.rel),
    ...(manifest.addedDirs || []),
    ...((manifest.reshade && manifest.reshade.filesAdded) || []),
    ...(manifest.reshade && manifest.reshade.file ? [manifest.reshade.file] : [])
  ]);
  const withheld = new Set([...withheldRels, ...blockedPaths]);
  const visited = new Set();
  const exeRealPath = fs.realpathSync(exeDirAbs);
  const uuid = crypto.randomUUID();
  const gameRelPrefixBuf = Buffer.from(toRel(gameDir, exeDirAbs), 'utf8');
  const backupRootAbsBuf = Buffer.from(backupRootAbs, 'utf8');

  // Walked and swept together, one directory at a time: an unlisted
  // directory moves whole, per Annex D, so its children are never separately
  // visited once the move has been attempted. Every name stays a buffer from
  // readdir to the eventual lstat, rename and log; only a name that decodes
  // and round-trips as UTF-8 is turned into the string a record entry can
  // match. A per-entry failure (readdir, lstat, a move) is caught, logged
  // and skipped rather than left to abort the sweep after restoreFiles has
  // already run.
  async function sweepDir(dirAbsBuf, dirRelToGameBuf, dirRelToExeBuf) {
    let names;
    try {
      names = fs.readdirSync(dirAbsBuf, { encoding: 'buffer' }).sort(Buffer.compare);
    } catch (error) {
      log('linux-restore-sweep', { rel: dirRelToGameBuf.toString('utf8'), outcome: 'unmatched', reason: error.code || String(error) });
      return;
    }
    for (const nameBuf of names) {
      const absBuf = bufJoin(dirAbsBuf, nameBuf);
      if (absBuf.equals(backupRootAbsBuf)) continue;
      const relToGameBuf = bufJoin(dirRelToGameBuf, nameBuf);
      const relToExeBuf = bufJoin(dirRelToExeBuf, nameBuf);
      const valid = isValidUtf8(relToGameBuf);
      const rel = valid ? relToGameBuf.toString('utf8') : escapeBytes(relToGameBuf);

      let stat;
      try {
        stat = fs.lstatSync(absBuf);
      } catch (error) {
        log('linux-restore-sweep', { rel, outcome: 'unmatched', reason: error.code || String(error) });
        continue;
      }

      if (valid && withheld.has(rel)) continue;
      // An invalid name can never be a record entry: the record's own walk
      // (entry-install.js) refuses to write one, so this rel never matches.
      const rec = valid ? recordByRel.get(rel) : undefined;

      if (!rec) {
        try {
          const outcome = await moveIntoSwept(gameDir, backupRootAbs, uuid, absBuf, relToExeBuf);
          if (outcome.ok) log('linux-restore-sweep', { rel, outcome: 'moved', to: outcome.to });
          else log('linux-restore-sweep', { rel, outcome: 'move-failed', reason: outcome.reason });
        } catch (error) {
          log('linux-restore-sweep', { rel, outcome: 'move-failed', reason: error.code || String(error) });
        }
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

      try {
        const outcome = restoreMode(absBuf, stat, rec.mode, exeRealPath);
        if (!outcome.ok) log('linux-restore-sweep', { rel, outcome: 'unmatched', reason: outcome.reason });
      } catch (error) {
        log('linux-restore-sweep', { rel, outcome: 'unmatched', reason: error.code || String(error) });
      }

      if (stat.isDirectory()) await sweepDir(absBuf, relToGameBuf, relToExeBuf);
    }
  }

  await sweepDir(Buffer.from(exeDirAbs), gameRelPrefixBuf, Buffer.alloc(0));

  for (const entry of record) {
    if (visited.has(entry.rel) || ownedRels.has(entry.rel)) continue;
    log('linux-restore-sweep', { rel: entry.rel, outcome: 'gone' });
  }

  return result;
}

module.exports = { restoreSweep };
