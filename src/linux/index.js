'use strict';
// The one door from an upstream file into the fork's Linux code. Annex D of
// the proton-install-core specification lists every call site, and the wave
// plan's contract table fixes each export's signature; each lives in its own
// module so one wave-2 unit owns one file behind an unchanged barrel.
module.exports = {
  protonContext: require('./proton-context').protonContext,
  routeGate: require('./route-gate').routeGate,
  compilerCheck: require('./compiler-check').compilerCheck,
  assertGameClosed: require('./running-game').assertGameClosed,
  gpuInfo: require('./gpu-info').gpuInfo,
  ensureEntry: require('./ensure-entry').ensureEntry,
  installEntry: require('./entry-install').installEntry,
  caseAwareTarget: require('./case-aware-target').caseAwareTarget,
  fileMode: require('./file-mode').fileMode,
  restoreSweep: require('./restore-sweep').restoreSweep
};
