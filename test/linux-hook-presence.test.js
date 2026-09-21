'use strict';
// Annex D of the proton-install-core specification lists every hook an
// upstream file carries into src/linux/. Each row here is one hook at one
// file, and the count is its number of sites, so a hook that vanishes from
// its file fails naming both.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const HOOKS = [
  { hook: 'Load the Linux modules', file: 'main.js', literal: "require('./src/linux')", sites: 1 },
  { hook: 'Barrel import per hooked file', file: 'src/core/apply.js', literal: "require('../linux')", sites: 1 },
  { hook: 'Barrel import per hooked file', file: 'src/core/backend-manager.js', literal: "require('../linux')", sites: 1 },
  { hook: 'Barrel import per hooked file', file: 'src/core/compatibility.js', literal: "require('../linux')", sites: 1 },
  { hook: 'Barrel import per hooked file', file: 'src/core/install-guards.js', literal: "require('../linux')", sites: 1 },
  { hook: 'Barrel import per hooked file', file: 'src/core/scan.js', literal: "require('../linux')", sites: 1 },
  { hook: 'Proton context', file: 'main.js', literal: 'linux.protonContext(', sites: 1 },
  { hook: 'Route allowlist and native refusal', file: 'main.js', literal: 'linux.routeGate(', sites: 1 },
  { hook: 'Compiler check', file: 'main.js', literal: 'linux.compilerCheck(', sites: 1 },
  { hook: 'Linux entry ensure step', file: 'main.js', literal: 'linux.ensureEntry(', sites: 1 },
  { hook: 'Running-game check', file: 'src/core/install-guards.js', literal: 'linux.assertGameClosed(', sites: 1 },
  { hook: 'GPU query and driver wording', file: 'src/core/install-guards.js', literal: 'linux.gpuInfo(', sites: 1 },
  { hook: 'Linux entry install, copy step', file: 'src/core/backend-manager.js', literal: 'linux.installEntry(', sites: 1 },
  { hook: 'Restore', file: 'src/core/apply.js', literal: 'linux.restoreSweep(', sites: 1 },
  { hook: 'Case-aware targets', file: 'src/core/apply.js', literal: 'linux.caseAwareTarget(', sites: 4 },
  { hook: 'Case-aware targets', file: 'src/core/scan.js', literal: 'linux.caseAwareTarget(', sites: 1 },
  { hook: 'Case-aware targets', file: 'src/core/compatibility.js', literal: 'linux.caseAwareTarget(', sites: 1 },
  { hook: 'File modes', file: 'src/core/apply.js', literal: 'linux.fileMode(', sites: 2 },
  { hook: 'Linux test run', file: 'package.json', literal: '"test:linux": "node scripts/test-linux.js"', sites: 1 },
  // [test->proton-install-core~28~7]
  { hook: 'Running-game call sites', file: 'main.js', literal: 'assertGameClosed(dir, target.path, undefined, undefined, send)', sites: 2 },
  // [test->proton-install-core~28~7]
  { hook: 'Running-game call sites', file: 'main.js', literal: 'assertGameClosed(dir, exe, undefined, undefined, send)', sites: 1 }
];

// A literal on a line whose trimmed text begins `//` or `*` counts as
// absent: a commented-out call site is no site at all.
const occurrences = (text, literal) => {
  const live = text.split('\n')
    .filter((line) => { const t = line.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
    .join('\n');
  return live.split(literal).length - 1;
};

for (const { hook, file, literal, sites } of HOOKS) {
  // [test->proton-install-core~29~5]
  test(`hook "${hook}" is present in ${file} at ${sites} site(s)`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(occurrences(text, literal), sites,
      `hook "${hook}" (${literal}) is absent from ${file}: expected ${sites} site(s)`);
  });
}

// The barrel is the one door from an upstream file into src/linux/. Its
// export set is exactly Annex D's ten hook names, so an eleventh export -
// a leak of internal wiring past the one door - fails the test.
// [test->proton-install-core~29~5]
test('the barrel exports exactly Annex D\'s ten hook names', () => {
  const barrel = require(path.join(root, 'src/linux'));
  const expected = ['assertGameClosed', 'caseAwareTarget', 'compilerCheck', 'ensureEntry',
    'fileMode', 'gpuInfo', 'installEntry', 'protonContext', 'restoreSweep', 'routeGate'].sort();
  assert.deepEqual(Object.keys(barrel).sort(), expected);
});
