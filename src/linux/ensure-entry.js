'use strict';
const optiscaler = require('../core/optiscaler');

// main.js, in place of optiscaler.ensureOptiScaler for the pinned build.
// main.js passes upstream's release as the entry, and the passthrough ensures
// it under the cache root exactly as upstream did. fetcher and deadlineMs are
// the wave-2 step's inputs, defaulted by that step.
function ensureEntry(cacheRoot, entry, fetcher, deadlineMs) {
  return optiscaler.ensureOptiScaler(cacheRoot, entry.version);
}

module.exports = { ensureEntry };
