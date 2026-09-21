'use strict';

// install-guards.js:91's query line lands here, in place of the line inside
// its own try. Off Linux this is exactly upstream's line: nvidia-smi.exe
// through the injected runner, parsed to [{ name, driver }] (~31~6). On
// Linux the binary carries no extension (~25~1); the driver field is never
// carried forward as a number to gate an install on, and instead names the
// wording the app shows for it, since nothing on this platform can judge a
// Linux driver version (~26~1). A runner that throws, because nvidia-smi is
// absent or exits non-zero, is left to throw here too: install-guards.js's
// own gpuInfo() wraps this call in a try/catch that already reads a throw as
// an unknown GPU and carries the install on (~27~1), and no host GPU is
// queried, only the injected runner.
async function gpuInfo(runner) {
  const onLinux = process.platform === 'linux';
  const output = await runner(onLinux ? 'nvidia-smi' : 'nvidia-smi.exe', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, driver] = line.split(',').map(s => s.trim());
    return { name, driver: onLinux ? 'the app cannot judge a Linux driver version' : driver };
  });
}

module.exports = { gpuInfo };
