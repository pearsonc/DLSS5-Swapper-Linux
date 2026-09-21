'use strict';
// proton-install-core~17~2: the compiler check refuses before any write when
// the user's copy of upstream's matching Windows release does not carry a
// file the entry needs, naming the file that is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compilerCheck } = require('../src/linux/compiler-check');
const { entries } = require('../src/linux/entries');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-compiler-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// [test->proton-install-core~17~2]
test('a fixture release directory carrying every release file the entry needs admits', (t) => {
  const dir = temp(t);
  const entry = entries[0];
  for (const row of entry.placement.filter((r) => r.source === 'release')) {
    fs.writeFileSync(path.join(dir, row.member), 'x');
  }
  assert.equal(compilerCheck(dir, entry), null);
});

// [test->proton-install-core~17~2]
test('a fixture release directory with a named file absent refuses before any write, naming the file', (t) => {
  const dir = temp(t);
  const entry = entries[0];
  const releaseRows = entry.placement.filter((r) => r.source === 'release');
  assert.ok(releaseRows.length >= 2, 'the fixture needs at least two release-sourced rows to prove only the absent one is named');
  // Place every release file except the first, so a pass here can only come
  // from the check reaching the missing one and not from an empty directory.
  for (const row of releaseRows.slice(1)) fs.writeFileSync(path.join(dir, row.member), 'x');
  const before = fs.readdirSync(dir).sort();
  const refusal = compilerCheck(dir, entry);
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, new RegExp(releaseRows[0].member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(refusal.message.includes(dir), 'the refusal names the directory it looked in');
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no file was written by the refusal');
});

// [test->proton-install-core~17~2]
test('off Linux the check always admits, whatever the release directory holds', (t) => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const dir = temp(t);
    assert.equal(compilerCheck(dir, entries[0]), null);
  } finally {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  }
});

// The real call site, main.js:1752, hands compilerCheck one argument only;
// the second parameter exists for tests, and the check defaults to Annex
// A's own entry when it is not supplied, so production behaviour is not a
// silent no-op.
// [test->proton-install-core~17~2]
test('with no entry argument the check defaults to Annex A\'s own entry', (t) => {
  const dir = temp(t);
  const refusal = compilerCheck(dir);
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /d3dcompiler_47\.dll|nvngx_dlssnr\.dll/);
});
