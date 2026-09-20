'use strict';

// main.js, in place of the two inline refusals that followed the Proton
// context. Returns null to admit or { ok: false, code, message } to refuse.
// The options object carries the route surface the wave-2 gate reads, and
// `proton`, the context the first refusal reads; the entry table it does not
// carry is the module's own once the Linux behaviour lands.
function routeGate({ api, proton }) {
  if (process.platform === 'linux' && !proton) {
    return { ok: false, code: 'errProtonRequired', message: 'This installer supports Windows games launched through Steam Proton. Launch the game once with Proton, then try again.' };
  }
  if (process.platform === 'linux' && api === 'vulkan') {
    return { ok: false, code: 'errLinuxVulkanUnsupported', message: 'The Vulkan Feeder route needs a host Vulkan layer and is not supported on Linux yet. Select a DirectX renderer in the game.' };
  }
  return null;
}

module.exports = { routeGate };
