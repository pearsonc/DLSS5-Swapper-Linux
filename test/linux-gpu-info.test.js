'use strict';
// install-guards.js:91, the GPU query hook, on Linux. No host GPU is
// queried by any test here: every case injects its own runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { gpuInfo } = require('../src/linux/gpu-info');

test('gpuInfo on Linux reads the name and driver version from nvidia-smi through the injected runner', async () => {
  const calls = [];
  const runner = async (file, args) => {
    calls.push([file, args]);
    return 'NVIDIA GeForce RTX 5090, 616.56\nNVIDIA GeForce RTX 4090, 616.92\n';
  };
  // [test->proton-install-core~25~1]
  const rows = await gpuInfo(runner);
  assert.deepEqual(calls, [['nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']]]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'NVIDIA GeForce RTX 5090');
  assert.equal(rows[1].name, 'NVIDIA GeForce RTX 4090');
  assert.equal(rows[0].driver, '616.56', 'the driver field keeps what nvidia-smi printed, unchanged, so install-guards.js:56 still parses a version out of it');
  assert.equal(rows[1].driver, '616.92');
});

test('gpuInfo on Linux gates no install on the driver version and shows wording that it cannot judge one, in its own field', async () => {
  const runner = async () => 'NVIDIA GeForce RTX 5090, 616.56\n';
  // [test->proton-install-core~26~1]
  const rows = await gpuInfo(runner);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].driver, '616.56', 'the wording travels in its own field, never displacing the parsed driver version (code-quality MEDIUM gpu-info.js:19, conformance MEDIUM the driver dialog contradicts ~26~1\'s wording)');
  assert.match(rows[0].note, /cannot judge a Linux driver version/);
});

test('gpuInfo on Linux reads the GPU as unknown and lets the install carry on when nvidia-smi is absent or fails', async () => {
  // [test->proton-install-core~27~1]
  const absent = async () => { const e = new Error('spawn nvidia-smi ENOENT'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(() => gpuInfo(absent), /ENOENT|nvidia-smi/);

  const failing = async () => { const e = new Error('nvidia-smi exited 9'); e.code = 9; throw e; };
  await assert.rejects(() => gpuInfo(failing));
  // install-guards.js's own gpuInfo wraps this in try/catch and reads a
  // throw as null, which is what the rest of the app already shows as
  // unknown and carries the install on; this proves the hook does not
  // swallow the failure itself into a false reading, so that catch still
  // fires. [Method: src/core/install-guards.js:72-75, must-not-change]
  const guards = require('../src/core/install-guards');
  assert.equal(await guards.gpuInfo(absent), null);
});
