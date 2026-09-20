'use strict';
const optiscaler = require('../core/optiscaler');

// backend-manager.js's optiscaler branch lands here. The options are the
// install config with the job log and the ensured root added; the passthrough
// takes those two back off and hands optiscaler.install what upstream did.
function installEntry(options) {
  const { log, ensuredRoot, ...config } = options;
  return optiscaler.install(config, log);
}

module.exports = { installEntry };
