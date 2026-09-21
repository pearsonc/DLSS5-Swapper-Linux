'use strict';

// main.js, in place of the two inline refusals that followed the Proton
// context. Returns null to admit or { ok: false, code, message } to refuse.
// The options object carries the route surface proton-install-core~9~4
// scopes, and `proton`, the context the first refusal reads; the entry table
// `~9~4`, `~10~7`, `~11~5` and `~33~3` read is `linux.ensureEntry(` and
// `linux.installEntry(`'s own parameter, not this gate's.
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
