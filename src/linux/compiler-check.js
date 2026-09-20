'use strict';

// main.js, after the Feeder runtime checks. Upstream made no check here, so
// the passthrough admits: null, never a refusal. releaseDir is the ensured
// extraction root and entry the Annex A entry the wave-2 check reads.
function compilerCheck(releaseDir, entry) {
  return null;
}

module.exports = { compilerCheck };
