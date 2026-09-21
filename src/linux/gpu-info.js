'use strict';

// install-guards.js:91's query line lands here, in place of the line inside
// its own try. Off Linux this is exactly upstream's line: nvidia-smi.exe
// through the injected runner, parsed to [{ name, driver }] (~31~6). On
// Linux the binary carries no extension (~25~1). The driver field keeps
// exactly what nvidia-smi printed, because install-guards.js:56 still parses
// it numerically for its own Windows-only gates; the app gates no install on
// it (~26~1) not by hiding the number but because nothing downstream reads
// this hook's own note field to gate on. The wording travels in that
// separate field instead of displacing the parsed value (code-quality MEDIUM
// `gpu-info.js:19`; conformance MEDIUM "the driver dialog contradicts
// ~26~1's wording"), so a caller wanting the "cannot judge" text reads
// `note` and never mistakes the version string for it. A runner that
// throws, because nvidia-smi is absent or exits non-zero, is left to throw
// here too: install-guards.js's own gpuInfo() wraps this call in a
// try/catch that already reads a throw as an unknown GPU and carries the
// install on (~27~1), and no host GPU is queried, only the injected runner.
async function gpuInfo(runner) {
  const onLinux = process.platform === 'linux';
  const output = await runner(onLinux ? 'nvidia-smi' : 'nvidia-smi.exe', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, driver] = line.split(',').map(s => s.trim());
    return onLinux ? { name, driver, note: 'the app cannot judge a Linux driver version' } : { name, driver };
  });
}

module.exports = { gpuInfo };
