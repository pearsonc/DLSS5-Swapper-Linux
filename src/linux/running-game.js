'use strict';
const fs = require('fs');
const path = require('path');

// install-guards.js's one-line delegate lands here: upstream's PowerShell
// process list through the injected runner, then the lock probe when the
// list is unavailable. log and processRoot are proton-install-core~12~3 to
// ~15~2's running-game check's own inputs, on Linux. Off Linux this function
// returns exactly what upstream's own check returned at 24bd2ac for the same
// arguments, per proton-install-core~31~6.
async function upstreamAssertGameClosed(matchingProcesses, gameDir, exePath, runner, locked) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let data;
  try {
    const output = await runner(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress"]);
    data = JSON.parse(output || '[]');
  } catch {
    // The process list is unavailable: PowerShell restricted by policy, a cold
    // WMI call past its timeout, or a machine where it simply fails. Refusing
    // outright turned a diagnostic into a wall, so ask the executable itself.
    if (exePath && locked(exePath)) {
      throw Object.assign(new Error('Close the game first: its executable is in use.'), { code: 'errGameRunning' });
    }
    return;
  }
  const matches = matchingProcesses(Array.isArray(data) ? data : [data], gameDir, exePath);
  if (matches.length) throw Object.assign(new Error(`Close the game and helper first: ${matches.map(p => p.Name).join(', ')}`), { code: 'errGameRunning' });
}

function refuse(detail, pid, matchedPath) {
  return Object.assign(new Error(`Close the game first: ${detail}.`), { code: 'errGameRunning', pid, path: matchedPath });
}

function canonical(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

// Annex B's "identity of a file": device and inode, decoded from Node's
// packed dev number into the major:minor pair /proc/<pid>/maps prints in
// hex, minor in bits 0 to 7 and 20 to 31 of the packed number, the rest
// major, glibc's gnu_dev_major/gnu_dev_minor packing.
const MASK32 = 0xffffffffn;
function majorMinor(dev) {
  const d = BigInt(dev);
  const minor = Number((d & 0xffn) | ((d >> 12n) & (~0xffn & MASK32)));
  const major = Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & (~0xfffn & MASK32)));
  return { major, minor };
}

// Review remedy 1-4, 5-6: the game folder's files, indexed once rather than
// searched per process per maps line, bounded as proton-install-core~34~4
// bounds the record walk, since an unbounded walk of Forza's 22,141 files
// times hundreds of maps lines times about 180 user processes is the
// quadratic BigInt cost the review measured. `byExe` is keyed `dev:ino`,
// Node's own encoding on both sides; `byMap` is keyed `major:minor:ino`, the
// decoded form /proc/<pid>/maps prints directly, both listed without
// following a symbolic link, per Annex B's identity of a file.
const WALK_BOUND = 100000;
function buildFileIndex(gameDir, bound = WALK_BOUND) {
  const byExe = new Map();
  const byMap = new Map();
  let count = 0;
  let truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= bound) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); if (truncated) return; continue; }
      count += 1;
      byExe.set(`${st.dev}:${st.ino}`, full);
      const { major, minor } = majorMinor(st.dev);
      byMap.set(`${major}:${minor}:${st.ino}`, full);
    }
  };
  walk(gameDir);
  return { byExe, byMap, truncated, count };
}

// One line of /proc/<pid>/maps: "address perms offset dev inode pathname".
function mapMatch(mapsText, byMap) {
  for (const line of mapsText.split('\n')) {
    const m = /^\S+\s+\S+\s+\S+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const inode = Number(m[3]);
    if (inode === 0) continue;
    const found = byMap.get(`${parseInt(m[1], 16)}:${parseInt(m[2], 16)}:${inode}`);
    if (found) return found;
  }
  return null;
}

// Review remedy 3-3, 4-7, 7-2: no call site hands this delegate a resolved
// Proton prefix, so where none is injected the delegate resolves it itself
// from the game folder, the same lookup main.js:1657 already makes
// (`steam().find(...)`) before calling the barrel's protonContext, reused
// here through injectable dependencies so no test touches a real Steam
// library. deps default to the real steam() (src/library.js, a plain
// filesystem scan with no side effect, not src/core), protonContext and
// upstream's contextForSteamGame (src/core/proton.js), required lazily so
// module load order never cycles.
function resolvePrefixFromGameFolder(gameDir, deps = {}) {
  const listGames = deps.steam || require('../library').steam;
  const resolveContext = deps.protonContext || require('./proton-context').protonContext;
  const upstreamContext = deps.contextForSteamGame || require('../core/proton').contextForSteamGame;
  let games;
  try { games = listGames(); } catch { return null; }
  if (!Array.isArray(games)) return null;
  const target = canonical(gameDir) || path.resolve(gameDir);
  const game = games.find((g) => (canonical(g.dir) || path.resolve(g.dir)) === target);
  if (!game) return null;
  const context = resolveContext(upstreamContext, game, undefined);
  return (context && context.prefix) ? context.prefix : null;
}

// Annex B's hidden-process table: the judgement of a hidden process by the
// shape of its argv[0] alone, per proton-install-core~14~6 and ADR-011.
function judgeHidden(argv0, canonicalGameDir, resolvePrefix) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(argv0);
  if (drive) {
    const prefix = resolvePrefix();
    if (!prefix) return { verdict: 'refused', path: argv0 };
    const link = path.join(prefix, 'dosdevices', `${drive[1].toLowerCase()}:`);
    let target;
    try { target = fs.readlinkSync(link); } catch { return { verdict: 'refused', path: argv0 }; }
    const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(link), target);
    const full = path.join(resolvedTarget, drive[2].replace(/\\/g, '/'));
    const canon = canonical(full);
    if (!canon) return { verdict: 'unjudged', path: full };
    return { verdict: (canon === canonicalGameDir || canon.startsWith(canonicalGameDir + path.sep)) ? 'refused' : 'admitted', path: canon };
  }
  if (argv0.startsWith('/')) {
    const canon = canonical(argv0);
    if (!canon) return { verdict: 'unjudged', path: argv0 };
    return { verdict: (canon === canonicalGameDir || canon.startsWith(canonicalGameDir + path.sep)) ? 'refused' : 'admitted', path: canon };
  }
  return { verdict: 'unjudged', path: argv0 };
}

function readArgv0(cmdlinePath) {
  // proton-install-core~13~1: no element of a process's command line other
  // than argv[0] is read, so the buffer is cut at the first NUL and nothing
  // past it is ever inspected.
  let raw;
  try { raw = fs.readFileSync(cmdlinePath); } catch { return ''; }
  const nul = raw.indexOf(0);
  return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8');
}

async function linuxAssertGameClosed(gameDir, log, processRoot, resolvePrefix) {
  let pidNames;
  try {
    pidNames = fs.readdirSync(processRoot).filter((name) => /^[0-9]+$/.test(name));
  } catch (error) {
    // proton-install-core~15~2: the process root does not exist at all.
    throw refuse(`the process root could not be read: ${error.code || error.message}`);
  }
  const invokingUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const index = api.buildFileIndex(gameDir);
  if (index.truncated) {
    // Review remedy 1-4: an unbounded walk is the resource the review named;
    // past the bound, correctness cannot be guaranteed, so this refuses
    // rather than silently checking a partial index, as ~34~4 refuses.
    throw refuse(`the game folder holds more than ${index.count} entries; the walk stopped there`);
  }
  const canonicalGameDir = canonical(gameDir) || path.resolve(gameDir);
  let readableEntries = 0;
  for (const pid of pidNames) {
    if (Number(pid) === process.pid) continue;
    let statusText;
    try { statusText = fs.readFileSync(path.join(processRoot, pid, 'status'), 'utf8'); } catch { continue; }
    readableEntries += 1;
    if (invokingUid !== null) {
      const uidLine = /^Uid:\s*(\d+)/m.exec(statusText);
      if (!uidLine || Number(uidLine[1]) !== invokingUid) continue;
    }
    let exeStat = null;
    let mapsText = null;
    try { exeStat = fs.statSync(path.join(processRoot, pid, 'exe')); } catch { exeStat = null; }
    try { mapsText = fs.readFileSync(path.join(processRoot, pid, 'maps'), 'utf8'); } catch { mapsText = null; }
    if (exeStat && mapsText !== null) {
      // A readable process: judged by identity, device and inode, never by
      // path, per proton-install-core~12~3.
      const exeMatch = index.byExe.get(`${exeStat.dev}:${exeStat.ino}`);
      if (exeMatch) throw refuse(`process ${pid} runs ${exeMatch}`, Number(pid), exeMatch);
      const mapped = mapMatch(mapsText, index.byMap);
      if (mapped) throw refuse(`process ${pid} maps ${mapped}`, Number(pid), mapped);
      continue;
    }
    // A hidden process: judged by argv[0] alone, per proton-install-core~14~6.
    const argv0 = readArgv0(path.join(processRoot, pid, 'cmdline'));
    const { verdict, path: matchedPath } = judgeHidden(argv0, canonicalGameDir, resolvePrefix);
    if (log) log({ code: 'linux-hidden-process', params: { pid: Number(pid), verdict, path: matchedPath } });
    if (verdict === 'refused') throw refuse(`hidden process ${pid} matches ${matchedPath}`, Number(pid), matchedPath);
  }
  if (readableEntries === 0) {
    // proton-install-core~15~2: the process root lists no entry named by
    // digits whose status the check can read.
    throw refuse('the process root lists no entry the check can read');
  }
}

// The barrel's delegate: matchingProcesses, runner and locked are upstream's
// own inputs, kept for the off-Linux passthrough; log and processRoot are
// this check's own on Linux, and resolvePrefix, an eighth and optional
// parameter no call site supplies today, is where a test hands the check a
// fixture Proton prefix for the hidden-process table's drive-letter rows.
// Review remedy 3-3, 4-7, 7-2: where no call site injects one, the default
// resolves the prefix itself, through `api.resolvePrefixFromGameFolder` so a
// test can substitute it, rather than always taking the no-translation row.
async function assertGameClosed(matchingProcesses, gameDir, exePath, runner, locked, log, processRoot, resolvePrefix) {
  if (process.platform === 'linux') {
    return linuxAssertGameClosed(gameDir, log, processRoot || '/proc', resolvePrefix || (() => api.resolvePrefixFromGameFolder(gameDir)));
  }
  return upstreamAssertGameClosed(matchingProcesses, gameDir, exePath, runner, locked);
}

// Exported as `api` too, and read through it from inside this module (never
// called directly by name where a test may need to substitute it), so a test
// can override `buildFileIndex` or `resolvePrefixFromGameFolder` on the
// exported object without a mocking library.
const api = { assertGameClosed, resolvePrefixFromGameFolder, buildFileIndex };
module.exports = api;
