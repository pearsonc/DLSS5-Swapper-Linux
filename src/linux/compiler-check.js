'use strict';

const fs = require('fs');
const path = require('path');
const { entries } = require('./entries');

// main.js, after the Feeder runtime checks. `releaseDir` is the user's own
// copy of upstream's matching Windows release; `entry` is the Annex A entry
// being installed, and defaults to that annex's own entry since the one call
// site, main.js:1752, hands this hook one argument only. For every
// placement row the entry sources from that release, rather than from its
// own archive, the file must already sit under `releaseDir` by the row's
// member name: proton-install-core~17~2 refuses before any file is written,
// naming the file that is missing.
function compilerCheck(releaseDir, entry = entries[0]) {
  if (process.platform !== 'linux') return null;
  if (!entry) return null;
  for (const row of entry.placement || []) {
    if (row.source !== 'release') continue;
    if (!fs.existsSync(path.join(releaseDir, row.member))) {
      return {
        ok: false,
        code: 'errLinuxReleaseFileMissing',
        message: `The release directory ${releaseDir} does not carry ${row.member}, which this install needs.`
      };
    }
  }
  return null;
}

module.exports = { compilerCheck };
