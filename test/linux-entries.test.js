'use strict';
// src/linux/entries.js is a generated copy of Annex A of proton-install-core-spec.md,
// carve-out 1 of "Authorship Has One Home": the generator is scripts/gen-entries.js,
// committed, and the module is never hand-edited. Deep-frozen, so it cannot be
// rewritten in-process either, and its header's source_sha256 has to move in the
// same commit that regenerates .specs/proton-install-core.criteria.yaml, or this
// suite fails until it does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const entries = require('../src/linux/entries');
const generator = require('../scripts/gen-entries');

test('entries is deep-frozen: no field, row or array can be rewritten in-process', () => {
  assert.throws(() => { entries.entries[0].sha256 = 'x'; }, TypeError);
  assert.throws(() => { entries.entries[0].placement[0].bytes = 1; }, TypeError);
  assert.throws(() => { entries.entries[0].placement.push({}); }, TypeError);
  assert.throws(() => { entries.entries[0].notExtracted.push('x'); }, TypeError);
  assert.throws(() => { entries.entries.push({}); }, TypeError);
});

test('the generator re-emits src/linux/entries.js byte-identically from the specification at 08e8192', (t) => {
  const rel = path.join('dlss-5-linux-proton-swapper', 'specs', 'proton-install-core', 'proton-install-core-spec.md');
  // The specification sits beside the code repository's own root, at any of the
  // paths a plain checkout (`../brain-db`) or a wave worktree
  // (`../../../brain-db`, one hop per worktree directory) would place it.
  const specPath = [1, 2, 3].map((hops) => path.join(root, ...Array(hops).fill('..'), 'brain-db', rel))
    .find((candidate) => fs.existsSync(candidate));
  if (!specPath) { t.skip('the specification is not present beside this checkout'); return; }
  const committed = fs.readFileSync(path.join(root, 'src/linux/entries.js'), 'utf8');
  const regenerated = generator.render(generator.buildEntries(specPath));
  assert.equal(regenerated, committed);
});

// [test->proton-install-core~28~8]
test('entries.js\'s source_sha256 equals the generated criteria file\'s, so a spec change fails this until the module is regenerated', () => {
  const entriesText = fs.readFileSync(path.join(root, 'src/linux/entries.js'), 'utf8');
  const entriesSha = /source_sha256: ([0-9a-f]{64})/.exec(entriesText)[1];
  const criteriaText = fs.readFileSync(path.join(root, '.specs/proton-install-core.criteria.yaml'), 'utf8');
  const criteriaSha = /source_sha256: ([0-9a-f]{64})/.exec(criteriaText)[1];
  assert.equal(entriesSha, criteriaSha);
});

// Step 8 remedy A, finding 4-8: Annex A's fourth table, the refused pairs
// with their evidence, is generated too, so routeGate never falls back to a
// machine name for evidence it has never gathered.
// [test->proton-install-core~9~4]
test('the generator emits Annex A\'s refused-pair table, each row carrying the evidence column verbatim', () => {
  assert.ok(Array.isArray(entries.refusedPairs), 'entries.js exports refusedPairs');
  const native = entries.refusedPairs.find((row) => row.route === 'native' && row.apiLabel === 'DirectX 12');
  assert.ok(native, 'the native/DirectX 12/64-bit refused pair is present');
  assert.equal(native.bitness, 64);
  assert.match(native.evidence, /RenoDX|route 1 result/);
  const dx11 = entries.refusedPairs.find((row) => row.route === 'optiscaler' && row.apiLabel === 'DirectX 11');
  assert.ok(dx11);
  assert.match(dx11.evidence, /No evidence gathered on Thor/);
  const wildcard = entries.refusedPairs.find((row) => row.route === null);
  assert.ok(wildcard, 'the "every other route and API pair" row is present as the wildcard');
  assert.match(wildcard.evidence, /No evidence gathered on Thor/);
});

// Step 8 remedy A, finding 5-4: the eight OptiScaler.ini keys the entry
// writes after extraction travel as entry.iniKeys, so u3's copy step does
// not re-derive them from prose.
// [test->proton-install-core~16~2]
test('the generator emits the eight OptiScaler.ini keys Annex A names as entry.iniKeys', () => {
  const entry = entries.entries[0];
  assert.ok(Array.isArray(entry.iniKeys));
  assert.equal(entry.iniKeys.length, 8);
  assert.deepEqual(entry.iniKeys[0], { section: 'DlssNr', key: 'Enabled', value: 'true' });
  assert.deepEqual(entry.iniKeys[1], { section: 'DlssNr', key: 'ToggleKey', value: '0x78' });
  assert.deepEqual(entry.iniKeys[3], { section: 'Log', key: 'LogLevel', value: '2' });
  const targetProcessName = entry.iniKeys.find((row) => row.key === 'TargetProcessName');
  assert.deepEqual(targetProcessName, { section: 'ProcessFilter', key: 'TargetProcessName', value: null });
  assert.throws(() => { entry.iniKeys.push({}); }, TypeError, 'iniKeys is deep-frozen with the rest of the entry');
});
