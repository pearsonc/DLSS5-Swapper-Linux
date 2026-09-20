'use strict';

// The fork's test runner, scripts/test-linux.js, driven against fixture trees
// rather than the real suite: Annex E's six expected upstream failures, then
// one fewer, then one more, then a failing Linux test. Each fixture is a real
// `test/*.test.js` tree under a temporary root, run by the real `node --test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = require('../scripts/test-linux');
const RUNNER = path.join(__dirname, '..', 'scripts', 'test-linux.js');

/** Annex E of proton-install-core-spec.md, the six upstream tests that fail on Linux. */
const ANNEX_E = [
  ['test/api-override-ipc.test.js', 'real IPC persists per-EXE choices, validates selection, uses effective routes and keeps Vulkan switch guards'],
  ['test/history-ipc.test.js', 'install/restore IPC records all backends, not failures/cancels, and validates clipboard writes'],
  ['test/backend-profile.test.js', 'a tampered profile is still refused outright'],
  ['test/payload-guidance.test.js', 'from source it still says the thing a developer needs'],
  ['test/payload-guidance.test.js', 'without a temp path it still names the folder in a form a person can paste'],
  ['test/shader-compiler.test.js', 'the install retires the stale compiler and Restore gives it back'],
];

/** Writes one `node --test` file holding the named tests, each passing or failing as asked. */
function writeTestFile(root, file, tests) {
  const lines = ["'use strict';", "const test = require('node:test');", "const assert = require('node:assert/strict');"];
  for (const [name, fails] of tests) {
    lines.push(`test(${JSON.stringify(name)}, () => { ${fails ? "assert.fail('fixture failure');" : ''} });`);
  }
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join('\n')}\n`);
}

/** A fixture tree: Annex E's six failing, one passing test beside each, an upstream Linux file and a fork Linux file, both passing. */
function annexETree(root, { drop = null, extra = [], linuxFailing = false } = {}) {
  const byFile = new Map();
  for (const [file, name] of ANNEX_E) {
    if (!byFile.has(file)) byFile.set(file, [['a test that passes on Linux', false]]);
    const fails = !(drop && drop[0] === file && drop[1] === name);
    byFile.get(file).push([name, fails]);
  }
  for (const [file, name] of extra) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([name, true]);
  }
  byFile.set('test/palette.test.js', [['a plain colour comes back as itself', false], ...(byFile.get('test/palette.test.js') || [])]);
  byFile.set('test/linux-proton.test.js', [['upstream Linux test that passes', false], ...(byFile.get('test/linux-proton.test.js') || [])]);
  byFile.set('test/linux-fixture.test.js', [['a fork Linux test', linuxFailing], ['another fork Linux test', false]]);
  for (const [file, tests] of byFile) writeTestFile(root, file, tests);
  return root;
}

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-suite-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const key = ([file, name]) => `${file} :: ${name}`;

// [test->proton-install-core~30~2]
test('a tree failing exactly the six Annex E tests, with every Linux test green, passes', async (t) => {
  const root = annexETree(tmpRoot(t));
  const result = await runner.runSuite({ root });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.linuxFailures, []);
  assert.deepEqual(result.expectedFailures.map(key).sort(), ANNEX_E.map(key).sort());
  assert.ok(result.files.includes('test/linux-proton.test.js'), 'the upstream Linux test file ran');
  assert.ok(result.files.includes('test/linux-fixture.test.js'), 'the fork Linux test file ran');
  assert.ok(result.files.includes('test/palette.test.js'), 'a plain upstream file ran');
});

// [test->proton-install-core~30~2]
test('one Annex E test passing fails the run and names it', async (t) => {
  const dropped = ANNEX_E[5];
  const root = annexETree(tmpRoot(t), { drop: dropped });
  const result = await runner.runSuite({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map(key), [key(dropped)]);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.linuxFailures, []);
  assert.ok(result.lines.some((l) => l.includes('EXPECTED FAILURE PASSED') && l.includes(dropped[1])), result.lines.join('\n'));
});

// [test->proton-install-core~30~2]
test('one upstream test failing beyond Annex E fails the run and names it', async (t) => {
  const added = ['test/palette.test.js', 'grey has no colour to give, and says so'];
  const root = annexETree(tmpRoot(t), { extra: [added] });
  const result = await runner.runSuite({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected.map(key), [key(added)]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.linuxFailures, []);
  assert.ok(result.lines.some((l) => l.includes('UNEXPECTED FAILURE') && l.includes(added[1])), result.lines.join('\n'));
});

// [test->proton-install-core~30~2]
test('a failing test in a test/linux-*.test.js file fails the run and names it', async (t) => {
  const root = annexETree(tmpRoot(t), { linuxFailing: true });
  const result = await runner.runSuite({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.linuxFailures.map(key), ['test/linux-fixture.test.js :: a fork Linux test']);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, []);
  assert.ok(result.lines.some((l) => l.includes('LINUX FAILURE') && l.includes('a fork Linux test')), result.lines.join('\n'));
});

// [test->proton-install-core~30~2]
test("upstream's own test/linux-proton.test.js is an upstream test, so its failure is unexpected, not a Linux failure", async (t) => {
  const added = ['test/linux-proton.test.js', 'a resolver case upstream ships'];
  const root = annexETree(tmpRoot(t), { extra: [added] });
  const result = await runner.runSuite({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected.map(key), [key(added)]);
  assert.deepEqual(result.linuxFailures, []);
});

// [test->proton-install-core~30~2]
test('the command line exits 0 on the Annex E tree and 1 on a tree with one more failure', async (t) => {
  const green = annexETree(tmpRoot(t));
  const ok = spawnSync(process.execPath, [RUNNER, '--root', green], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const red = annexETree(tmpRoot(t), { extra: [['test/palette.test.js', 'one more']] });
  const fail = spawnSync(process.execPath, [RUNNER, '--root', red], { encoding: 'utf8' });
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stdout, /UNEXPECTED FAILURE: test\/palette\.test\.js :: one more/);
});
