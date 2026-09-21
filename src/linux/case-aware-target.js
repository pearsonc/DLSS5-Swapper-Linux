'use strict';

const fs = require('fs');

// The name a write under dir lands on. Upstream wrote the name it was given,
// and off Linux that is the answer; dir is read once the Linux behaviour
// lands.
//
// On Linux, proton-install-core~21~1: where dir already holds an entry with
// the same name under another case, the write lands on that existing name
// instead, so a game folder that already carries `DXGI.dll` is not left with
// both `DXGI.dll` and `dxgi.dll` on a case-sensitive filesystem.
function caseAwareTarget(dir, name) {
  if (process.platform !== 'linux') return name;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return name;
  }
  if (entries.includes(name)) return name;
  const lower = name.toLowerCase();
  const match = entries.find((entry) => entry.toLowerCase() === lower);
  return match === undefined ? name : match;
}

module.exports = { caseAwareTarget };
