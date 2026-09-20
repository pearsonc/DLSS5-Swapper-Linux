'use strict';

// apply.js's restore hands its own restoreFiles in, and the passthrough calls
// it unchanged, returning what it returned.
function restoreSweep(restoreFiles, gameDir, manifest, onLog) {
  return restoreFiles(gameDir, manifest, onLog);
}

module.exports = { restoreSweep };
