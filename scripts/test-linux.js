'use strict';

// The fork's test run on Linux, proton-install-core~30~3. It runs every file
// upstream's `npm test` runs, `test/*.test.js` at package.json's test script,
// one `node --test` process per file so each failure carries its file. An
// upstream file's failures are compared with Annex E of the specification in
// both directions; a fork Linux file, `test/linux-*.test.js` other than
// upstream's own `test/linux-proton.test.js`, must fail no test at all.
//
// `node scripts/test-linux.js [--root <dir>]`; the test suite drives
// `runSuite({ root })` against fixture trees.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Annex E, proton-install-core-spec.md: upstream tests at 24bd2ac that fail on Linux. */
const EXPECTED_UPSTREAM_FAILURES = [
  { file: 'test/api-override-ipc.test.js', test: 'real IPC persists per-EXE choices, validates selection, uses effective routes and keeps Vulkan switch guards' },
  { file: 'test/history-ipc.test.js', test: 'install/restore IPC records all backends, not failures/cancels, and validates clipboard writes' },
  { file: 'test/backend-profile.test.js', test: 'a tampered profile is still refused outright' },
  { file: 'test/payload-guidance.test.js', test: 'from source it still says the thing a developer needs' },
  { file: 'test/payload-guidance.test.js', test: 'without a temp path it still names the folder in a form a person can paste' },
  { file: 'test/shader-compiler.test.js', test: 'the install retires the stale compiler and Restore gives it back' },
  { file: 'test/optiscaler.test.js', test: 'GPU requirements and process guards reject known unsupported/running targets' },
];

/** Upstream files matching the fork's Linux pattern; Annex D, the hook-presence row. */
const UPSTREAM_LINUX_FILES = ['test/linux-proton.test.js'];

const TEST_DIR = 'test';
const TEST_SUFFIX = '.test.js';
const LINUX_PREFIX = 'linux-';

const key = ({ file, test }) => `${file} :: ${test}`;

/** The files upstream's `npm test` runs, `test/*.test.js`, sorted. */
function testFiles(root) {
  const dir = path.join(root, TEST_DIR);
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(TEST_SUFFIX) && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => `${TEST_DIR}/${name}`);
}

function isLinuxFile(file) {
  return path.basename(file).startsWith(LINUX_PREFIX) && !UPSTREAM_LINUX_FILES.includes(file);
}

/** A TAP test name, with Node's `\#` and `\\` escapes undone and any directive removed. */
function tapName(rest) {
  let name = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '\\' && i + 1 < rest.length) { name += rest[++i]; continue; }
    if (ch === '#' && rest[i - 1] === ' ') { name = name.slice(0, -1); break; }
    name += ch;
  }
  return name.trim();
}

/** Top-level `ok` and `not ok` lines of one file's TAP output, each carrying
 * the `exitCode` its YAML diagnostic block names, where one is present: the
 * whole file crashed rather than one of its tests failing an assertion. */
function parseTap(text) {
  const results = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not )?ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const result = { test: tapName(m[2]), ok: !m[1] };
    if (m[1] && lines[i + 1] === '  ---') {
      for (let j = i + 1; j < lines.length && lines[j] !== '  ...'; j++) {
        const e = /^\s*exitCode: (\d+)/.exec(lines[j]);
        if (e) { result.exitCode = Number(e[1]); break; }
      }
    }
    results.push(result);
  }
  return results;
}

/** The runner's own environment, less the marker `node --test` sets on its children, which would change the child's reporter. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runFile(root, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', file], {
      cwd: root,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const results = parseTap(stdout);
      const failures = results.filter((r) => !r.ok)
        .map((r) => ({ file, test: r.exitCode !== undefined ? `${r.test} (crashed, exit ${r.exitCode})` : r.test }));
      if ((code !== 0 || signal) && failures.length === 0) {
        failures.push({ file, test: `(the file's process ended with ${signal ? `signal ${signal}` : `exit ${code}`} and no failing test)` });
      }
      resolve({ file, failures, code, signal, stdout, stderr });
    });
  });
}

/**
 * Runs the whole suite under `root` and compares it with Annex E.
 * Returns `{ ok, files, expectedFailures, unexpected, missing, linuxFailures, lines }`.
 */
async function runSuite({ root = path.join(__dirname, '..') } = {}) {
  const files = testFiles(root);
  const expected = new Map(EXPECTED_UPSTREAM_FAILURES.map((e) => [key(e), e]));
  const seen = new Set();
  const expectedFailures = [];
  const unexpected = [];
  const missing = [];
  const linuxFailures = [];
  const lines = [];

  for (const file of files) {
    const run = await runFile(root, file);
    for (const failure of run.failures) {
      if (isLinuxFile(file)) {
        linuxFailures.push(failure);
        lines.push(`LINUX FAILURE: ${key(failure)}`);
      } else if (expected.has(key(failure))) {
        seen.add(key(failure));
        expectedFailures.push(failure);
        lines.push(`expected failure, Annex E: ${key(failure)}`);
      } else {
        unexpected.push(failure);
        lines.push(`UNEXPECTED FAILURE: ${key(failure)}`);
      }
    }
    if (run.failures.length > 0 && (unexpected.length > 0 || linuxFailures.length > 0)) {
      lines.push(...run.stdout.split('\n').filter((l) => l.startsWith('#') || /^ +/.test(l)).map((l) => `  | ${l}`));
      if (run.stderr.trim()) lines.push(...run.stderr.trim().split('\n').map((l) => `  ! ${l}`));
    }
  }
  for (const [k, e] of expected) {
    if (!seen.has(k)) {
      missing.push(e);
      lines.push(`EXPECTED FAILURE NOT SEEN: ${k}`);
    }
  }
  const ok = unexpected.length === 0 && missing.length === 0 && linuxFailures.length === 0;
  lines.push(`test:linux: ${files.length} files, ${expectedFailures.length} of ${expected.size} Annex E failures seen, ` +
    `${unexpected.length} unexpected, ${missing.length} passed unexpectedly, ${linuxFailures.length} Linux failures: ${ok ? 'ok' : 'FAIL'}`);
  return { ok, files, expectedFailures, unexpected, missing, linuxFailures, lines };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) { options.root = path.resolve(argv[++i]); continue; }
    throw new Error(`test-linux: unknown argument ${argv[i]}`);
  }
  return options;
}

async function main() {
  const result = await runSuite(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`test-linux: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  });
}

module.exports = { runSuite, runFile, parseTap, testFiles, isLinuxFile, EXPECTED_UPSTREAM_FAILURES, UPSTREAM_LINUX_FILES };
