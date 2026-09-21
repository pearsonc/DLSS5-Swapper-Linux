'use strict';
// proton-install-core~10~7, ~32~1, ~33~3: the Linux entry ensure step,
// `linux.ensureEntry(`, fetches and extracts Annex A entry A1. Every fixture
// here is fixed at os.tmpdir(), removed after its test, and the archive
// itself is never fetched from the network: a fetcher stub reads a committed
// fixture .7z from disk and yields it in chunks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

Object.defineProperty(process, 'platform', { value: 'linux' });

const { ensureEntry } = require('../src/linux/ensure-entry');

const fixturesDir = path.join(__dirname, 'fixtures', 'linux-ensure-entry');
const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'entry.json'), 'utf8'));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cloneEntry(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...fixture.entry, ...overrides }));
}

// Yields the whole buffer as one or more chunks of chunkSize bytes; the
// fetcher's own PATH argument, `url`, is unused by these stubs, the fetch
// itself is always the fixture buffer.
function bufferFetcher(buffer, chunkSize = 4096, onDraw) {
  return async function* fetcher(url) {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      if (onDraw) onDraw(chunk, url);
      yield chunk;
    }
  };
}

function routingFetcher(routes) {
  return (url) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch of ${url}`);
    return route(url);
  };
}

function counting(fn) {
  const calls = [];
  const wrapped = (...args) => { calls.push(args); return fn(...args); };
  wrapped.calls = calls;
  return wrapped;
}

let restorePath = null;
function usePath(value) {
  restorePath = process.env.PATH;
  process.env.PATH = value;
}
test.afterEach(() => {
  if (restorePath !== null) { process.env.PATH = restorePath; restorePath = null; }
});

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name));
}

function fetchersFor(entry, archiveBuffer, licenceBuffer, onDraw) {
  const licenceRow = entry.placement.find((row) => /^https?:\/\//.test(row.source));
  return routingFetcher({
    [entry.url]: bufferFetcher(archiveBuffer, 4096, onDraw),
    ...(licenceRow ? { [licenceRow.source]: bufferFetcher(licenceBuffer, 4096, onDraw) } : {})
  });
}

// --- proton-install-core~32~1: no `7z` on PATH refuses before any fetch or write ---

// [test->proton-install-core~32~1]
test('with no 7z on PATH, the install refuses before fetching or writing, naming the extractor', async () => {
  const cacheRoot = tmpDir('u8-no7z-');
  usePath('');
  const fetcher = counting(fetchersFor(fixture.entry, readFixture('archive-control.7z'), readFixture('licence.txt')));
  await assert.rejects(
    () => ensureEntry(cacheRoot, cloneEntry(), fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinux7zMissing');
      assert.match(err.message, /7z/);
      return true;
    }
  );
  assert.equal(fetcher.calls.length, 0, 'no fetch happened before the refusal');
  const written = fs.readdirSync(cacheRoot);
  assert.deepEqual(written, [], 'nothing was written under the cache root');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// --- proton-install-core~10~7: the Archive row's three attacks, and a positive control ---

// [test->proton-install-core~10~7]
test('an omitted listed member refuses the install naming it', async () => {
  const cacheRoot = tmpDir('u8-missing-');
  const entry = cloneEntry({ sha256: fixture.missingMemberArchive.sha256, bytes: fixture.missingMemberArchive.bytes });
  const fetcher = fetchersFor(entry, readFixture('archive-missing-member.7z'), readFixture('licence.txt'));
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinuxMemberMissing');
      assert.match(err.message, /OptiScaler\/libxell\.dll/);
      return true;
    }
  );
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~10~7]
test('a listed member stored as a symbolic link refuses the install naming it', async () => {
  const cacheRoot = tmpDir('u8-symlink-');
  const entry = cloneEntry({ sha256: fixture.symlinkMemberArchive.sha256, bytes: fixture.symlinkMemberArchive.bytes });
  const fetcher = fetchersFor(entry, readFixture('archive-symlink-member.7z'), readFixture('licence.txt'));
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinuxMemberMissing');
      assert.match(err.message, /OptiScaler\.ini/);
      return true;
    }
  );
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~10~7]
test('a shim 7z first on PATH writing wrong bytes under a listed name refuses naming the member', async () => {
  const cacheRoot = tmpDir('u8-shim-');
  const shimDir = tmpDir('u8-shimbin-');
  const shim = path.join(shimDir, '7z');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'dir=""',
    'archive=""',
    'seen_archive=0',
    'members=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    -o*) dir="${arg#-o}"; continue ;;',
    '    -*) continue ;;',
    '  esac',
    '  if [ "$seen_archive" -eq 0 ]; then archive="$arg"; seen_archive=1; continue; fi',
    '  members="$members $arg"',
    'done',
    'for m in $members; do',
    '  mkdir -p "$dir/$(dirname "$m")"',
    '  printf "wrong bytes from shim 7z\\n" > "$dir/$m"',
    'done',
    'exit 0'
  ].join('\n') + '\n');
  fs.chmodSync(shim, 0o755);
  usePath(shimDir);
  const entry = cloneEntry();
  const fetcher = fetchersFor(entry, readFixture('archive-control.7z'), readFixture('licence.txt'));
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinuxMemberChecksum');
      assert.match(err.message, /OptiScaler\.dll/);
      return true;
    }
  );
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.rmSync(shimDir, { recursive: true, force: true });
});

// [test->proton-install-core~10~7]
test('the control extracts the placement table set in both directions with the decoy absent', async () => {
  const cacheRoot = tmpDir('u8-control-');
  const entry = cloneEntry();
  const fetcher = fetchersFor(entry, readFixture('archive-control.7z'), readFixture('licence.txt'));
  const extractRoot = await ensureEntry(cacheRoot, entry, fetcher, 5000);
  const wanted = new Set(entry.placement.map((row) => row.member));
  const found = new Set();
  const stack = [extractRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile()) found.add(path.relative(extractRoot, full).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(found, wanted, 'the extracted set equals the table in both directions');
  assert.ok(!found.has('OptiScaler/D3D12_OptiScaler/D3D12Core.dll'), 'the decoy is absent');
  for (const row of entry.placement) {
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(extractRoot, ...row.member.split('/')))).digest('hex');
    assert.equal(digest, row.sha256, `${row.member} matches its recorded checksum`);
  }
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// --- proton-install-core~33~3: fetch bound, deadline, checksum and cache arms ---

// [test->proton-install-core~33~3]
test('a fetcher yielding chunks past the count draws at most the crossing chunk and refuses naming the bound', async () => {
  const cacheRoot = tmpDir('u8-runaway-');
  const entry = cloneEntry();
  const runawayArchive = Buffer.concat([readFixture('archive-control.7z'), Buffer.alloc(entry.bytes * 4, 7)]);
  let draws = 0;
  const fetcher = fetchersFor(entry, runawayArchive, readFixture('licence.txt'), () => { draws += 1; });
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinuxFetchBound');
      assert.match(err.message, new RegExp(String(entry.bytes)));
      return true;
    }
  );
  const crossingChunks = Math.ceil(entry.bytes / 4096) + 1;
  assert.ok(draws <= crossingChunks, `drew at most the crossing chunk: ${draws} <= ${crossingChunks}`);
  assert.ok(!fs.existsSync(path.join(cacheRoot, 'linux-entries', entry.id, entry.archive)), 'no file of the body under the cache root');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~33~3]
test('a stalling fetcher refuses at an injected short deadline, naming the bound', async () => {
  const cacheRoot = tmpDir('u8-stall-');
  const entry = cloneEntry();
  const stallingFetcher = async function* () {
    yield Buffer.from('a few bytes then nothing');
    await new Promise(() => {}); // never resolves: a stalled body
  };
  const fetcher = routingFetcher({ [entry.url]: stallingFetcher });
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 50),
    (err) => {
      assert.equal(err.code, 'errLinuxFetchDeadline');
      assert.match(err.message, /50/);
      return true;
    }
  );
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~33~3]
test('a fetched body of another checksum is refused naming the file, with no .part left', async () => {
  const cacheRoot = tmpDir('u8-badbody-');
  const entry = cloneEntry();
  const wrongBody = Buffer.alloc(entry.bytes, 9);
  const fetcher = fetchersFor(entry, wrongBody, readFixture('licence.txt'));
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinuxFetchChecksum');
      assert.match(err.message, new RegExp(entry.archive.replace('.', '\\.')));
      return true;
    }
  );
  const archiveFile = path.join(cacheRoot, 'linux-entries', entry.id, entry.archive);
  assert.ok(!fs.existsSync(archiveFile), 'no final file was left');
  assert.ok(!fs.existsSync(archiveFile + '.part'), 'no .part file was left');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~33~3]
test('a cached body of another checksum is fetched again exactly once and replaced only by a verified body', async () => {
  const cacheRoot = tmpDir('u8-stalecache-');
  const entry = cloneEntry();
  const archiveFile = path.join(cacheRoot, 'linux-entries', entry.id, entry.archive);
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  fs.writeFileSync(archiveFile, Buffer.alloc(10, 1)); // stale, wrong digest
  let archiveFetches = 0;
  const goodArchive = readFixture('archive-control.7z');
  const fetcher = fetchersFor(entry, goodArchive, readFixture('licence.txt'), (chunk, url) => {
    if (url === entry.url) archiveFetches += 1;
  });
  const extractRoot = await ensureEntry(cacheRoot, entry, fetcher, 5000);
  assert.ok(archiveFetches > 0, 'the archive was fetched again');
  const digest = require('crypto').createHash('sha256').update(fs.readFileSync(archiveFile)).digest('hex');
  assert.equal(digest, entry.sha256, 'the stale file was replaced only by a verified body');
  assert.ok(fs.existsSync(extractRoot));
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~33~3]
test('a stale cache whose re-fetch also mismatches is refused once', async () => {
  const cacheRoot = tmpDir('u8-stalecache2-');
  const entry = cloneEntry();
  const archiveFile = path.join(cacheRoot, 'linux-entries', entry.id, entry.archive);
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  fs.writeFileSync(archiveFile, Buffer.alloc(10, 1)); // stale, wrong digest
  let archiveFetches = 0;
  const wrongBody = Buffer.alloc(entry.bytes, 9);
  const fetcher = fetchersFor(entry, wrongBody, readFixture('licence.txt'), (chunk, url) => {
    if (url === entry.url) archiveFetches += 1;
  });
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => { assert.equal(err.code, 'errLinuxFetchChecksum'); return true; }
  );
  assert.equal(archiveFetches, 1, 'refused after exactly one re-fetch');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~33~3]
test('the licence text is refused before any extractor runs or file is placed', async () => {
  const cacheRoot = tmpDir('u8-licence-');
  const entry = cloneEntry();
  const wrongLicence = readFixture('licence-wrong.txt');
  const fetcher = fetchersFor(entry, readFixture('archive-control.7z'), wrongLicence);
  await assert.rejects(
    () => ensureEntry(cacheRoot, entry, fetcher, 5000),
    (err) => {
      assert.equal(err.code, 'errLinuxFetchChecksum');
      assert.match(err.message, /LICENSE\.GPL-3\.0\.txt/);
      return true;
    }
  );
  const extractRoot = path.join(cacheRoot, 'linux-entries', entry.id, 'extracted');
  assert.ok(!fs.existsSync(extractRoot) || fs.readdirSync(extractRoot).length === 0, 'no extraction and no placement happened');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// [test->proton-install-core~33~3]
test('the default fetcher carries a 120-second whole-request deadline', async () => {
  const cacheRoot = tmpDir('u8-default-');
  const entry = cloneEntry();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
  });
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const promise = ensureEntry(cacheRoot, entry, undefined, undefined);
    const assertion = assert.rejects(() => promise, (err) => {
      assert.equal(err.code, 'errLinuxFetchDeadline');
      assert.match(err.message, /120000/);
      return true;
    });
    // Flush the microtasks between the call and the setTimeout it schedules
    // (through `fetch`, then the stalled `for await`) before advancing the
    // mocked clock past the default deadline.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    mock.timers.tick(120000);
    await assertion;
  } finally {
    mock.timers.reset();
    global.fetch = originalFetch;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
