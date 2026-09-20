'use strict';

// install-guards.js's query line lands here: nvidia-smi.exe through the
// injected runner, parsed to [{ name, driver }]. A failing runner throws to
// the caller, whose catch reads it as unknown, as upstream's did.
async function gpuInfo(runner) {
  const output = await runner('nvidia-smi.exe', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, driver] = line.split(',').map(s => s.trim());
    return { name, driver };
  });
}

module.exports = { gpuInfo };
