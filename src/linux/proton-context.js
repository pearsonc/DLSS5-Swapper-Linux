'use strict';

// main.js, in place of contextForSteamGame(protonGame). main.js passes its own
// contextForSteamGame in as the first argument, so this module requires
// nothing from src/core/ and the barrel's require graph stays acyclic. The
// passthrough hands the game to upstream's resolver, which answers null off
// Linux; steamRoots is the resolver's second input once the Linux behaviour
// lands, and main.js does not pass it, so the module reads the roots itself
// then.
function protonContext(contextForSteamGame, game, steamRoots) {
  return contextForSteamGame(game);
}

module.exports = { protonContext };
