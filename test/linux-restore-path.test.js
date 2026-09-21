'use strict';
// proton-install-core~28~9, the restore half of the wave-2 property: one
// restore through apply.js:959's real hook, `apply.restore`, with the real
// `restoreFiles` (never a stub), returns what upstream's restore returns,
// keeps every backup under `originals/`, and, for a file the fixture
// changes after the install and one it adds after the install, emits the
// `linux-restore-sweep` outcomes Annex D's Restore row records: `changed`
// for a listed, unowned file whose size or mtime no longer matches its
// before-install record, and `moved` into `_DLSS5_Backup/swept/` for a file
// the record never listed at all.
Object.defineProperty(process, 'platform', { value: 'linux' });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const apply = require('../src/core/apply');
const { installEntry } = require('../src/linux/entry-install');

const ARCHIVE = path.join(__dirname, 'fixtures', 'linux-ensure-entry', 'archive-control.7z');

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `restore-path-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function noopGuard() { return async () => {}; }

// [test->proton-install-core~28~9]
test('apply.restore, through the real restoreFiles, keeps every backup under originals/ and reports a changed file and an added one via linux-restore-sweep', async (t) => {
  const dir = temp(t, 'game');
  const gameDir = path.join(dir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, 'Game.exe');
  fs.writeFileSync(exePath, 'exe');

  // A pre-existing file the install neither placed nor replaced: part of
  // the before-install record, and left alone by the copy step.
  fs.writeFileSync(path.join(gameDir, 'readme.txt'), 'original readme');
  // A pre-existing file the install replaces: upstream's own tracked copy
  // backs it up under originals/ before overwriting it.
  fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'old proxy bytes');

  // The extraction root a real ensure step would have produced: extracted
  // directly from the committed fixture archive here, since this test is
  // about the restore hook, not the ensure step test/linux-ensure-entry.test.js
  // already covers.
  const ensuredRoot = path.join(dir, 'extracted');
  fs.mkdirSync(ensuredRoot, { recursive: true });
  execFileSync('7z', ['x', '-spd', '-y', `-o${ensuredRoot}`, ARCHIVE, 'OptiScaler.dll', 'nvngx.dll_dlssnr.dll'], { stdio: 'ignore' });

  const entry = {
    id: 'U9RESTORE', route: 'optiscaler', launchOptions: 'none',
    placement: [
      { member: 'OptiScaler.dll', placedAs: 'dxgi.dll', sha256: 'bf210e6fa7e4bd461162e09554a515c4baeac5f3753a0c6960999fc7a3622151', bytes: 35, source: 'archive' },
      { member: 'nvngx.dll_dlssnr.dll', placedAs: 'nvngx.dll_dlssnr.dll', sha256: 'ab5a372ad4d6510f8cd0bb7097d346391d0ed4dca6f9009763b3f3e933411012', bytes: 41, source: 'archive' }
    ]
  };

  const manifest = apply.beginManifest(gameDir, exePath, 'dxgi');
  manifest.route = 'optiscaler';
  const installEvents = [];
  await installEntry({
    gameDir, exePath, entry, releaseDir: dir, manifest, ensuredRoot,
    guard: noopGuard(), placeTracked: apply.copyTracked, log: (e) => installEvents.push(e)
  });
  assert.equal(manifest.replaced.length, 1, 'dxgi.dll was replaced, with a backup');
  assert.equal(manifest.added.length, 1, 'nvngx.dll_dlssnr.dll was newly added');
  await apply.saveActiveManifest(gameDir, manifest);

  const backupRoot = apply.backupRoot(gameDir);
  const backupPrefix = manifest.backupPrefix;
  const originalDxgi = path.join(backupRoot, backupPrefix, 'dxgi.dll');
  assert.ok(fs.existsSync(originalDxgi), 'the replaced file was backed up under originals/ before the install overwrote it');
  assert.equal(fs.readFileSync(originalDxgi, 'utf8'), 'old proxy bytes');

  // After the install: one file the fixture changes, one it adds.
  fs.writeFileSync(path.join(gameDir, 'readme.txt'), 'a different readme, a different size');
  fs.writeFileSync(path.join(gameDir, 'stray.log'), 'nobody placed this');

  const events = [];
  const result = await apply.restore(gameDir, (e) => events.push(e));

  assert.equal(result, true, 'restore reports what upstream reports');

  // The backup survives restore, per ADR-004: originals/ is never cleared.
  assert.ok(fs.existsSync(originalDxgi), 'the backup under originals/ still exists after restore');
  assert.equal(fs.readFileSync(path.join(gameDir, 'dxgi.dll'), 'utf8'), 'old proxy bytes', 'the replaced file itself was restored from its backup');

  const sweepEvents = events.filter((e) => e.code === 'linux-restore-sweep');

  const changed = sweepEvents.find((e) => e.params.rel === 'readme.txt');
  assert.ok(changed, 'a linux-restore-sweep event named the changed file');
  assert.equal(changed.params.outcome, 'changed');
  assert.equal(fs.readFileSync(path.join(gameDir, 'readme.txt'), 'utf8'), 'a different readme, a different size',
    'a changed, listed file is named and left exactly as the fixture left it, never swept');

  const added = sweepEvents.find((e) => e.params.rel === 'stray.log');
  assert.ok(added, 'a linux-restore-sweep event named the added file');
  assert.equal(added.params.outcome, 'moved');
  assert.match(added.params.to, /^_DLSS5_Backup\/swept\/[0-9a-f-]+\/stray\.log$/);
  assert.equal(fs.existsSync(path.join(gameDir, 'stray.log')), false, 'the unlisted file no longer sits where it was added');
  assert.ok(fs.existsSync(path.join(gameDir, added.params.to)), 'it was moved under swept/, not deleted');

  // Nothing else was swept: the only entries under swept/ are the one file
  // the fixture actually added.
  const sweptRoot = path.join(backupRoot, 'swept');
  const sweptFiles = [];
  const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else sweptFiles.push(path.relative(sweptRoot, p)); } };
  walk(sweptRoot);
  assert.deepEqual(sweptFiles.map((f) => path.basename(f)), ['stray.log'], 'swept/ carries exactly the one added file');
});
