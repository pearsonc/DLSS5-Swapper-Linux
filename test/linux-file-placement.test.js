'use strict';
// proton-install-core~19~2, ~20~1, ~21~1: a replaced file keeps the mode the
// original carried with the owner's write bit set, a new file gets 0644 on
// Linux, and a write whose target name exists in the directory under
// another case is backed up and written under the existing name. Driven
// through upstream's copyTracked and writeTracked in a fixture game folder,
// per Annex D's File modes and Case-aware targets rows and the wave-2
// contract table. ~19~2 amended on 2026-09-21 from ~19~1 to add the
// owner's write bit, so apply.js:257's pre-write chmod, the replacement's
// only chmod, can still let the write through on a read-only original,
// test/readonly-attribute.test.js's 0o444 ReShade.ini among them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

assert.equal(process.platform, 'linux', 'this suite drives the Linux behaviour and must run on Linux');

const apply = require('../src/core/apply');
const { fileMode } = require('../src/linux/file-mode');
const { caseAwareTarget } = require('../src/linux/case-aware-target');

const temp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swapper-file-placement-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const mode = (p) => fs.statSync(p).mode & 0o777;

function freshManifest() {
  return { added: [], addedDirs: [], replaced: [], reshade: {} };
}

// [test->proton-install-core~19~2]
test('fileMode returns the original mode with the owner write bit set, for a replaced file, on Linux', () => {
  assert.equal(fileMode(0o600), 0o600);
  assert.equal(fileMode(0o755), 0o755);
  assert.equal(fileMode(0o444), 0o644);
});

// [test->proton-install-core~19~2]
test('copyTracked over an existing file gives the replacement the mode the original carried', async (t) => {
  const gameDir = temp(t, 'replace');
  const dest = path.join(gameDir, 'dxgi.dll');
  fs.writeFileSync(dest, 'old');
  fs.chmodSync(dest, 0o640);
  const src = path.join(gameDir, 'source.dll');
  fs.writeFileSync(src, 'new');

  const manifest = freshManifest();
  await apply.copyTracked(manifest, gameDir, src, dest);

  assert.equal(mode(dest), 0o640);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new');
});

// [test->proton-install-core~19~2]
test('writeTracked over a read-only original still carries out the write, owner write bit added', async (t) => {
  const gameDir = temp(t, 'write-readonly');
  const dest = path.join(gameDir, 'ReShade.ini');
  fs.writeFileSync(dest, '[GENERAL]\r\nOld=1\r\n');
  fs.chmodSync(dest, 0o444);

  const manifest = freshManifest();
  await apply.writeTracked(manifest, gameDir, dest, '[GENERAL]\r\nNew=1\r\n');

  assert.match(fs.readFileSync(dest, 'utf8'), /New=1/);
  assert.equal(mode(dest), 0o644);
});

// [test->proton-install-core~20~1]
test('fileMode returns 0644 for a new file (undefined existing mode), on Linux', () => {
  assert.equal(fileMode(undefined), 0o644);
});

// [test->proton-install-core~20~1]
test('copyTracked writing a new file creates it with mode 0644', async (t) => {
  const gameDir = temp(t, 'new');
  const dest = path.join(gameDir, 'newfile.dll');
  const src = path.join(gameDir, 'source.dll');
  fs.writeFileSync(src, 'payload');

  const manifest = freshManifest();
  await apply.copyTracked(manifest, gameDir, src, dest);

  assert.equal(mode(dest), 0o644);
});

// [test->proton-install-core~21~1]
test('caseAwareTarget returns the existing name under another case, on Linux', (t) => {
  const dir = temp(t, 'case-lookup');
  fs.writeFileSync(path.join(dir, 'DXGI.dll'), 'existing');
  assert.equal(caseAwareTarget(dir, 'dxgi.dll'), 'DXGI.dll');
});

// [test->proton-install-core~21~1]
test('caseAwareTarget returns the given name where no other-case entry exists', (t) => {
  const dir = temp(t, 'case-none');
  assert.equal(caseAwareTarget(dir, 'dxgi.dll'), 'dxgi.dll');
});

// [test->proton-install-core~21~1]
test('caseAwareTarget returns the given name where the directory cannot be read', (t) => {
  const parent = temp(t, 'case-unreadable');
  const dir = path.join(parent, 'locked');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o000);
  try {
    assert.equal(caseAwareTarget(dir, 'dxgi.dll'), 'dxgi.dll');
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

// [test->proton-install-core~21~1]
test('copyTracked writing dxgi.dll beside an existing DXGI.dll backs it up and writes under the existing name', async (t) => {
  const gameDir = temp(t, 'case-write');
  const existing = path.join(gameDir, 'DXGI.dll');
  fs.writeFileSync(existing, 'old-dxgi');
  const src = path.join(gameDir, 'source.dll');
  fs.writeFileSync(src, 'new-dxgi');

  const manifest = freshManifest();
  const rel = await apply.copyTracked(manifest, gameDir, src, path.join(gameDir, 'dxgi.dll'));

  assert.equal(rel, 'DXGI.dll');
  assert.equal(fs.existsSync(path.join(gameDir, 'dxgi.dll')), false);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'new-dxgi');
  const backupDir = path.join(gameDir, '_DLSS5_Backup');
  const backedUp = fs.readdirSync(backupDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .some((e) => fs.readFileSync(path.join(e.parentPath || e.path, e.name), 'utf8') === 'old-dxgi');
  assert.equal(backedUp, true);
});
