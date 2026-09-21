'use strict';

// The mode a written file is set to. Upstream cleared the read-only attribute
// with 0o666 whatever the file had, and off Linux that is the answer;
// existingMode, the mode found before the write or undefined for a new file,
// is read once the Linux behaviour lands.
//
// On Linux, proton-install-core~19~2 gives a replaced file the mode the
// original carried with the owner's write bit set, so a read-only original,
// such as test/readonly-attribute.test.js's 0o444 ReShade.ini, still accepts
// the write that same chmod call has to let through at apply.js:257's
// pre-write site; proton-install-core~20~1 gives a new file 0644; against
// upstream's fixed 0o666 which makes a game-folder DLL writable by every
// user of the machine.
function fileMode(existingMode) {
  if (process.platform !== 'linux') return 0o666;
  return existingMode === undefined ? 0o644 : (existingMode | 0o200);
}

module.exports = { fileMode };
