'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const optiscaler = require('../core/optiscaler');
const { entryFor } = require('./entries');

// main.js, in place of optiscaler.releaseFor and optiscaler.ensureOptiScaler
// for upstream's pin (main.js:1718-1719). Off Linux the passthrough is
// unchanged. On Linux the step fetches and extracts an Annex A entry:
// proton-install-core~10~7, ~32~1, ~33~3.

const DEFAULT_DEADLINE_MS = 120000;

function refuse(code, message, params) {
  return Object.assign(new Error(message), { code, params });
}

function digestFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Whether a listed member is stored as a symbolic link, is absent, or is
// anything other than a regular file, closing the Annex C attack that stores
// a listed name as a link 7z reproduces as one (proton-install-core~10~7).
function isRegularFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return false;
  }
  return stat.isFile();
}

// The extractor is a host dependency, found by walking PATH ourselves rather
// than trusting a shell's own resolution, so a test can hand it an empty PATH
// (proton-install-core~32~1) or one whose first `7z` is a shim
// (proton-install-core~10~7's Annex C attack); the digest check below is what
// actually refuses a shim's wrong bytes, this only decides whether one runs.
function find7z() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, '7z');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // not on this PATH entry
    }
  }
  return null;
}

// Draws chunks from the injected fetcher under a byte bound and a
// whole-request deadline, per ADR-010: the step, not the fetcher, stops
// drawing once the recorded byte count plus the chunk that crosses it is
// reached, and refuses naming whichever bound was passed. Nothing is written
// to disk until the whole body has drawn cleanly under both bounds.
async function drawBody(fetcher, url, boundBytes, deadlineMs) {
  const iterable = fetcher(url);
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable;
  const startedAt = Date.now();
  const chunks = [];
  let total = 0;
  for (;;) {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw refuse('errLinuxFetchDeadline', `Download of ${url} passed its ${deadlineMs} ms deadline.`, { url, deadlineMs });
    }
    let timer;
    const timedOut = await Promise.race([
      iterator.next().then((step) => ({ step })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), remaining); })
    ]);
    clearTimeout(timer);
    if (timedOut.timedOut) {
      throw refuse('errLinuxFetchDeadline', `Download of ${url} passed its ${deadlineMs} ms deadline.`, { url, deadlineMs });
    }
    const { value, done } = timedOut.step;
    if (done) break;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > boundBytes) {
      throw refuse('errLinuxFetchBound', `Download of ${url} passed its ${boundBytes}-byte bound.`, { url, bytes: boundBytes });
    }
    chunks.push(chunk);
    if (total >= boundBytes) break;
  }
  if (total > boundBytes) {
    throw refuse('errLinuxFetchBound', `Download of ${url} passed its ${boundBytes}-byte bound.`, { url, bytes: boundBytes });
  }
  return Buffer.concat(chunks, total);
}

// Every file Annex A sources from a URL that the cache does not hold at its
// checksum is fetched, written first as `.part`, then renamed, so a refused
// body reaches no name under the cache root (proton-install-core~33~3). A
// cached body of another checksum is not refused: it is logged with the
// digest it held and fetched again, and only a verified body replaces it.
async function ensureCachedFile(fetcher, url, expectedSha256, expectedBytes, destFile, deadlineMs, log) {
  if (isRegularFile(destFile) && digestFile(destFile) === expectedSha256) return destFile;
  if (fs.existsSync(destFile)) {
    let held = null;
    try { held = digestFile(destFile); } catch { held = null; }
    if (typeof log === 'function') {
      log({ code: 'linux-cache-mismatch', params: { file: destFile, held, expected: expectedSha256 } });
    }
  }
  const body = await drawBody(fetcher, url, expectedBytes, deadlineMs);
  const received = crypto.createHash('sha256').update(body).digest('hex');
  if (received !== expectedSha256) {
    throw refuse('errLinuxFetchChecksum', `Fetched body of ${destFile} does not match its recorded checksum.`, { file: destFile, url, expected: expectedSha256, received });
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const temp = destFile + '.part';
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, destFile);
  return destFile;
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

// The default fetcher used only when main.js injects none: it streams the
// global `fetch`'s body, so the deadline this step reads is the fork's own
// 120 seconds, ADR-010's re-decided value, and not upstream's dead code path.
// An AbortController tied to the same deadline closes the underlying
// request when it passes, rather than leaving the response body open behind
// drawBody's own logical timeout.
async function* defaultFetcher(url, deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw refuse('errLinuxFetchFailed', `Fetch of ${url} failed: ${response.status}`, { url, status: response.status });
    }
    for await (const chunk of response.body) {
      yield chunk;
    }
  } finally {
    clearTimeout(timer);
  }
}

function ensureEntry(cacheRoot, entry, fetcher, deadlineMs, log) {
  if (process.platform !== 'linux') {
    return optiscaler.ensureOptiScaler(cacheRoot, entry.version);
  }
  return ensureEntryLinux(cacheRoot, entry, fetcher, deadlineMs, log);
}

async function ensureEntryLinux(cacheRoot, entry, fetcher, deadlineMs, log) {
  // The call site (main.js:1714) passes the route, per Annex D's amended
  // Ensure row; a string is resolved to Annex A's entry through
  // entries.entryFor, and any value carrying no placement table, a route
  // this table does not list or an entry object alike, is refused.
  const resolved = typeof entry === 'string' ? entryFor(entry) : entry;
  if (!resolved || !Array.isArray(resolved.placement)) {
    const named = typeof entry === 'string' ? entry : (entry && entry.id);
    throw refuse('errLinuxEntryUnresolved', `No Annex A entry for ${JSON.stringify(named)}: refusing a value that is neither a known route nor an entry carrying a placement table on Linux.`, { entry: named });
  }
  entry = resolved;
  const bound = Number.isFinite(deadlineMs) ? deadlineMs : DEFAULT_DEADLINE_MS;
  const draw = fetcher || ((url) => defaultFetcher(url, bound));
  const sevenZip = find7z();
  if (!sevenZip) {
    throw refuse('errLinux7zMissing', "Install '7z' to continue: entry A1's archive needs it and it is not on PATH.", { extractor: '7z' });
  }

  const entryRoot = path.join(path.resolve(cacheRoot), 'linux-entries', entry.id);
  fs.mkdirSync(entryRoot, { recursive: true });

  const archiveFile = path.join(entryRoot, entry.archive);
  await ensureCachedFile(draw, entry.url, entry.sha256, entry.bytes, archiveFile, bound, log);

  const urlRows = entry.placement.filter((row) => typeof row.source === 'string' && /^https?:\/\//.test(row.source));
  const fetchedUrlFiles = new Map();
  for (const row of urlRows) {
    const dest = path.join(entryRoot, 'fetched', path.basename(row.member));
    await ensureCachedFile(draw, row.source, row.sha256, row.bytes, dest, bound, log);
    fetchedUrlFiles.set(row.member, dest);
  }

  // Only after every URL-sourced file (the archive and the licence text
  // among them) has drawn and verified does the extractor run, so a
  // checksum refusal above leaves this step never reached
  // (proton-install-core~33~3).
  const archiveRows = entry.placement.filter((row) => row.source === 'archive');
  const extractRoot = path.join(entryRoot, 'extracted');
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });

  const memberNames = archiveRows.map((row) => row.member);
  if (memberNames.length) {
    const result = spawnSync(sevenZip, ['x', '-spd', '-y', `-o${extractRoot}`, archiveFile, ...memberNames], { stdio: 'ignore' });
    if (result.error || result.status !== 0) {
      throw refuse('errLinuxExtractorFailed', `${sevenZip} exited ${result.status} extracting ${archiveFile}.`, { extractor: sevenZip, status: result.status });
    }
  }

  for (const row of archiveRows) {
    const extracted = path.join(extractRoot, ...row.member.split('/'));
    if (!isRegularFile(extracted)) {
      throw refuse('errLinuxMemberMissing', `Archive member ${row.member} was not extracted as a regular file.`, { member: row.member });
    }
    const digest = digestFile(extracted);
    if (digest !== row.sha256) {
      throw refuse('errLinuxMemberChecksum', `Archive member ${row.member} does not match its recorded checksum.`, { member: row.member, expected: row.sha256, received: digest });
    }
  }

  // The extracted set equals the table's archive members exactly, in both
  // directions: nothing else the archive carried, the decoy included, is
  // extracted (proton-install-core~10~7).
  const wanted = new Set(archiveRows.map((row) => row.member));
  for (const file of walkFiles(extractRoot)) {
    const rel = path.relative(extractRoot, file).split(path.sep).join('/');
    if (!wanted.has(rel)) {
      throw refuse('errLinuxMemberUnexpected', `Archive member ${rel} is not in the placement table.`, { member: rel });
    }
  }

  // The extraction root holds the placement table's members: the archive's
  // own, above, and every URL-sourced file, the licence text included, so
  // installEntry reads one root for both.
  for (const row of urlRows) {
    const dest = path.join(extractRoot, ...row.member.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(fetchedUrlFiles.get(row.member), dest);
  }

  return extractRoot;
}

module.exports = { ensureEntry };
