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

// The game folder's files, listed without following a symbolic link, as
// Annex B's identity-of-a-file entry requires.
function listGameFiles(gameDir) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      files.push({ path: full, dev: st.dev, ino: st.ino });
    }
  };
  walk(gameDir);
  return files;
}

// One line of /proc/<pid>/maps: "address perms offset dev inode pathname".
function mapMatch(mapsText, gameFiles) {
  for (const line of mapsText.split('\n')) {
    const m = /^\S+\s+\S+\s+\S+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const inode = Number(m[3]);
    if (inode === 0) continue;
    const major = parseInt(m[1], 16);
    const minor = parseInt(m[2], 16);
    const found = gameFiles.find((f) => { const d = majorMinor(f.dev); return d.major === major && d.minor === minor && f.ino === inode; });
    if (found) return found;
  }
  return null;
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
  const gameFiles = listGameFiles(gameDir);
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
      const exeMatch = gameFiles.find((f) => f.dev === exeStat.dev && f.ino === exeStat.ino);
      if (exeMatch) throw refuse(`process ${pid} runs ${exeMatch.path}`, Number(pid), exeMatch.path);
      const mapped = mapMatch(mapsText, gameFiles);
      if (mapped) throw refuse(`process ${pid} maps ${mapped.path}`, Number(pid), mapped.path);
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
// fixture Proton prefix for the hidden-process table's drive-letter rows;
// production has none to hand it until u1-proton-context's resolver is
// wired to a game row this delegate does not receive, so a drive letter
// never translates in production yet and is refused under the table's
// no-translation row, the fail-closed direction ADR-011 already chooses for
// that row on purpose.
async function assertGameClosed(matchingProcesses, gameDir, exePath, runner, locked, log, processRoot, resolvePrefix) {
  if (process.platform === 'linux') {
    return linuxAssertGameClosed(gameDir, log, processRoot || '/proc', resolvePrefix || (() => null));
  }
  return upstreamAssertGameClosed(matchingProcesses, gameDir, exePath, runner, locked);
}

module.exports = { assertGameClosed };
