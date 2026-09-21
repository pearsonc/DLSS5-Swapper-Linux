'use strict';
// proton-install-core~28~5: the fork carries its Linux behaviour under
// src/linux/, reached from an upstream file only through a hook Annex D
// lists, with no other change to an upstream file than the in-place edits
// Annex D marks. The oracle is the committed tree against the upstream
// commit `24bd2ac`, read with git.
//
// UPSTREAM_SHA is the base commit Annex D reads at: "The hook set ~28~5,
// ~29~4, ~31~5, ~11~5 and ~33~3 read, at upstream 24bd2ac".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const UPSTREAM_SHA = '24bd2ac';

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

// Every upstream site Annex D permits a change at, as a line window on the
// *old* file's line numbers (the ones a diff hunk header reports for the
// pre-image), one entry per annex row plus, where the row is not the "Load
// the Linux modules" row itself, one entry for the require('../linux')
// barrel import the site needs to reach src/linux/ at all -- the mechanism
// proton-install-core~28~5 itself names: "reached from an upstream file
// only through a hook Annex D lists". Windows are generous around the
// annex's cited line so a Node-shaped edit (a helper line the delegate
// call needs, or a multi-line function collapsing to a one-line delegate)
// still counts as "at" the site, while a change anywhere else in the file
// does not.
const ALLOWED_RANGES = {
  'main.js': [
    { row: 'Annex D: Load the Linux modules -- main.js near line 44', lo: 40, hi: 48 },
    { row: 'Annex D: Proton context (main.js:1657) and Route allowlist and native refusal (main.js:1658-1663)', lo: 1654, hi: 1666 },
    { row: 'Annex D: Linux entry ensure step -- main.js:1718-1719', lo: 1714, hi: 1723 },
    { row: 'Annex D: Compiler check -- main.js after line 1756', lo: 1753, hi: 1759 },
  ],
  'src/core/install-guards.js': [
    { row: "~28~5's own text: the require('../linux') barrel import near the top, the mechanism a hook reaches through", lo: 1, hi: 10 },
    { row: 'Annex D: Running-game check -- install-guards.js:39', lo: 35, hi: 62 },
    { row: 'Annex D: GPU query and driver wording -- install-guards.js:91', lo: 85, hi: 98 },
  ],
  'src/core/backend-manager.js': [
    { row: "~28~5's own text: the require('../linux') barrel import near the top", lo: 1, hi: 14 },
    { row: 'Annex D: Linux entry install, copy step -- backend-manager.js:130', lo: 126, hi: 134 },
  ],
  'src/core/apply.js': [
    { row: "~28~5's own text: the require('../linux') barrel import near the top", lo: 1, hi: 20 },
    { row: 'Annex D: File modes, In place -- apply.js:150', lo: 140, hi: 154 },
    { row: 'Annex D: Case-aware targets -- apply.js:221-260', lo: 218, hi: 263 },
    { row: 'Annex D: File modes, In place -- apply.js:257', lo: 254, hi: 261 },
    { row: 'Annex D: Case-aware targets -- apply.js:345-346', lo: 342, hi: 349 },
    { row: 'Annex D: Restore -- apply.js:959', lo: 955, hi: 963 },
  ],
  'src/core/scan.js': [
    { row: "~28~5's own text: the require('../linux') barrel import near the top", lo: 1, hi: 16 },
    { row: 'Annex D: Case-aware targets -- scan.js:85-87', lo: 82, hi: 92 },
  ],
  'src/core/compatibility.js': [
    { row: "~28~5's own text: the require('../linux') barrel import near the top", lo: 1, hi: 12 },
    { row: 'Annex D: Case-aware targets -- compatibility.js:45', lo: 42, hi: 50 },
  ],
  'package.json': [
    { row: 'Annex D: Linux test run, In place -- one test:linux line in the scripts block', lo: 6, hi: 20 },
  ],
};

// Annex D's New file rows, and the paths Annex D names as outside this
// test's assertion because they are the fork's own: "the fork's own files,
// which Annex D's New file rows and the test/linux-*.test.js,
// scripts/test-linux.js, Makefile, linux/, test/fixtures/ and .specs/
// paths name, are outside the assertion."
const ALLOWED_NEW_FILE_PATTERNS = [
  /^src\/linux\//,
  /^test\/linux-.*\.test\.js$/,
  /^scripts\/test-linux\.js$/,
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

const changedFiles = () => git(['diff', '--name-only', UPSTREAM_SHA]).split('\n').filter(Boolean);

const hunkOldRanges = (file) => {
  const out = git(['diff', '-U0', UPSTREAM_SHA, '--', file]);
  const ranges = [];
  for (const line of out.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure insertion reports a 0 count at the line it follows; treat it
    // as touching that anchor line so it must still sit inside a window.
    ranges.push(count === 0 ? [start, start] : [start, start + count - 1]);
  }
  return ranges;
};

// [test->proton-install-core~28~5]
test('every changed upstream file changes only at an Annex D site', () => {
  const violations = [];
  for (const file of changedFiles()) {
    if (!isUpstreamFile(file)) continue; // the fork's own new file, checked separately below
    const windows = ALLOWED_RANGES[file];
    if (!windows) {
      violations.push(`${file}: not named by any Annex D row, and is not the upstream file at ${UPSTREAM_SHA}`);
      continue;
    }
    for (const [lo, hi] of hunkOldRanges(file)) {
      const covered = windows.some((w) => lo >= w.lo && hi <= w.hi);
      if (!covered) {
        violations.push(`${file}:${lo}-${hi} falls outside every Annex D site (${windows.map((w) => w.row).join('; ')})`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

// [test->proton-install-core~28~5]
test('no file appears outside Annex D\'s New file rows', () => {
  const violations = [];
  for (const file of changedFiles()) {
    if (isUpstreamFile(file)) continue; // a modified upstream file, checked above
    if (ALLOWED_NEW_FILE_PATTERNS.some((p) => p.test(file))) continue;
    violations.push(`${file}: a new file outside every Annex D New file row`);
  }
  assert.deepEqual(violations, []);
});
