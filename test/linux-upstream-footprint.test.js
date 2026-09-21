'use strict';
// proton-install-core~28~8: the fork carries its Linux behaviour under
// src/linux/, reached from an upstream file only through a hook Annex D
// lists, with no other change to an upstream file than the in-place edits
// Annex D marks. The oracle is the committed tree against the upstream
// commit `24bd2ac`, read with git.
//
// UPSTREAM_SHA is the base commit Annex D reads at: "The hook set ~28~6,
// ~29~5, ~31~6, ~11~5 and ~33~3 read, at upstream 24bd2ac".
//
// Every upstream file Annex D names is compared whole, hunk headers and
// content, against a fixture committed under test/fixtures/linux-upstream-
// footprint/: no line window, generous or otherwise, remains, so an edit at
// any other line, of any other content, at any length, fails it. Regenerate
// a fixture, after reviewing the new diff as the diff it is, with:
//
//   git diff -U0 24bd2ac -- <file> | grep -v '^index ' \
//     > test/fixtures/linux-upstream-footprint/<file, / turned to _>.diff
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'linux-upstream-footprint');
const UPSTREAM_SHA = '24bd2ac';

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

// Every upstream file Annex D names an edit at.
const ANNEX_D_UPSTREAM_FILES = [
  'main.js',
  'package.json',
  'src/core/apply.js',
  'src/core/backend-manager.js',
  'src/core/compatibility.js',
  'src/core/install-guards.js',
  'src/core/scan.js',
];

// Annex D's New file rows, and the paths that are the fork's own tooling
// rather than an entry the annex enumerates by name: the two fork test
// runner scripts (Annex D's "Linux test run" and "Hook-presence and Linux
// tests" rows), every src/linux/ module and test/linux-*.test.js file, the
// entries.js generator report-architecture.md's carve-out-1 finding asked
// committed, the criteria file is regenerated, and the fixture
// trees a test plants.
const ALLOWED_NEW_FILE_PATTERNS = [
  /^src\/linux\//,
  /^test\/linux-.*\.test\.js$/,
  /^scripts\/test-linux\.js$/,
  /^scripts\/gen-entries\.js$/,
  /^Makefile$/,
  /^linux\//,
  /^test\/fixtures\//,
  /^\.specs\//,
];

const isUpstreamFile = (file) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${UPSTREAM_SHA}:${file}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// The whole tree, tracked and untracked: a tracked change against the
// upstream commit, plus every untracked path `git status` reports, node's
// own `node_modules` symlink among them once, filtered by the same New-file
// patterns below like every other new path.
function changedFiles() {
  const tracked = git(['diff', '--name-only', UPSTREAM_SHA]).split('\n').filter(Boolean);
  const untracked = git(['status', '--porcelain', '--untracked-files=all']).split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3));
  return [...new Set([...tracked, ...untracked])];
}

// Hunk headers and content, nothing else: the two path lines and the
// per-blob `index` line carry no text of the file itself, so `index` is
// dropped and `--- a/x` / `+++ b/x` are kept as the fixed preamble every
// diff of that file carries.
function normalisedDiff(file) {
  const raw = git(['diff', '-U0', UPSTREAM_SHA, '--', file]);
  return raw.split('\n').filter((line) => !line.startsWith('index ')).join('\n');
}

// [test->proton-install-core~28~8]
test('every changed upstream file\'s diff against 24bd2ac equals its committed fixture, hunk headers and content', () => {
  const violations = [];
  for (const file of ANNEX_D_UPSTREAM_FILES) {
    const slug = file.replace(/\//g, '_');
    const fixturePath = path.join(FIXTURE_DIR, `${slug}.diff`);
    if (!fs.existsSync(fixturePath)) { violations.push(`${file}: no fixture at ${fixturePath}`); continue; }
    const expected = fs.readFileSync(fixturePath, 'utf8');
    const actual = normalisedDiff(file);
    if (actual !== expected) violations.push(`${file}: diff against ${UPSTREAM_SHA} does not equal the committed fixture`);
  }
  assert.deepEqual(violations, []);
});

// [test->proton-install-core~28~8]
test('no upstream file changes outside Annex D\'s own list', () => {
  const violations = [];
  for (const file of changedFiles()) {
    if (!isUpstreamFile(file)) continue; // the fork's own new file, checked below
    if (!ANNEX_D_UPSTREAM_FILES.includes(file)) violations.push(`${file}: changed, but is not one of Annex D's upstream files`);
  }
  assert.deepEqual(violations, []);
});

// [test->proton-install-core~28~8]
test('no file appears outside Annex D\'s New file rows', () => {
  const violations = [];
  for (const file of changedFiles()) {
    if (isUpstreamFile(file)) continue; // a modified upstream file, checked above
    if (file === 'node_modules') continue; // the worktree's symlink, never a tracked or generated file
    if (ALLOWED_NEW_FILE_PATTERNS.some((p) => p.test(file))) continue;
    violations.push(`${file}: a new file outside every Annex D New file row`);
  }
  assert.deepEqual(violations, []);
});
