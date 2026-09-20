'use strict';

// The name a write under dir lands on. Upstream wrote the name it was given,
// and off Linux that is the answer; dir is read once the Linux behaviour lands.
function caseAwareTarget(dir, name) {
  return name;
}

module.exports = { caseAwareTarget };
