'use strict';

// The mode a written file is set to. Upstream cleared the read-only attribute
// with 0o666 whatever the file had, and off Linux that is the answer;
// existingMode, the mode found before the write or undefined for a new file,
// is read once the Linux behaviour lands.
function fileMode(existingMode) {
  return 0o666;
}

module.exports = { fileMode };
