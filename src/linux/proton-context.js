'use strict';
const { contextForSteamGame } = require('../core/proton');

// main.js, in place of contextForSteamGame(protonGame). The passthrough hands
// the game to upstream's resolver, which answers null off Linux; steamRoots is
// the resolver's second input once the Linux behaviour lands, and main.js does
// not pass it, so the module reads the roots itself then.
function protonContext(game, steamRoots) {
  return contextForSteamGame(game);
}

module.exports = { protonContext };
