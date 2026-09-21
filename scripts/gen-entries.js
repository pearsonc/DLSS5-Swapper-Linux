'use strict';

// Regenerates src/linux/entries.js from Annex A of proton-install-core-spec.md,
// tables one, two and three: the allowlist, the placement table, and the
// members the ensure step never extracts. Table four, the refused pairs, is
// not read: entries.js carries only what an install places.
//
// Usage: node scripts/gen-entries.js <path-to-proton-install-core-spec.md> > src/linux/entries.js
//
// Byte-identical on every run against the same spec content: this script
// carries no state of its own beyond the file it is pointed at, so a
// regenerated module diffs as empty against the committed one until the
// spec's Annex A changes.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`gen-entries: ${message}\n`);
  process.exit(1);
}

function section(text, heading, nextHeading) {
  const start = text.indexOf(heading);
  if (start === -1) fail(`no "${heading}" heading in the spec`);
  const rest = text.slice(start + heading.length);
  const end = nextHeading ? rest.indexOf(nextHeading) : -1;
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every data row of the first pipe table whose header line contains `headerLiteral`. */
function tableRows(text, headerLiteral) {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes(headerLiteral));
  if (headerIdx === -1) fail(`no table headed "${headerLiteral}" in Annex A`);
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

const firstBacktick = (cell) => { const m = /`([^`]+)`/.exec(cell); return m ? m[1] : null; };
const allBackticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const firstNumber = (cell) => { const m = /([\d,]+)/.exec(cell); return m ? Number(m[1].replace(/,/g, '')) : null; };

/** Table one: the allowlist, one entry per row. */
function parseAllowlist(annexA) {
  return tableRows(annexA, '| Entry | Route |').map((cells) => {
    const [entryCol, routeCol, apiCol, bitnessCol, emulatorCol, nativeDlssCol, proxyCol,
      buildCol, sha256Col, urlCol, licenceCol, launchOptionsCol] = cells;
    const buildTokens = allBackticks(buildCol);
    return {
      id: entryCol,
      route: firstBacktick(routeCol),
      api: allBackticks(apiCol)[0],
      apiLabel: (/`[^`]+`,\s*([^,]+),/.exec(apiCol) || [])[1]?.trim() || null,
      bitness: Number(bitnessCol),
      emulator: firstBacktick(emulatorCol) || emulatorCol,
      nativeDlss: nativeDlssCol === 'yes',
      proxy: firstBacktick(proxyCol),
      archive: buildTokens[0],
      build: (/\bbuild `([^`]+)`/.exec(buildCol) || [])[1] || buildTokens[buildTokens.length - 1],
      sha256: firstBacktick(sha256Col),
      bytes: (/([\d,]+)\s*bytes/.exec(buildCol) || [])[1] ? Number(RegExp.$1.replace(/,/g, '')) : null,
      url: firstBacktick(urlCol),
      licence: licenceCol.split(',')[0].trim(),
      launchOptions: firstBacktick(launchOptionsCol),
    };
  });
}

/** Table two: what the entry places, `placedAs` derived from the Placed-as
 * cell's convention: `its own name` keeps the member's own path; a backtick
 * token ending in `/` is a directory the member's basename joins; a bare
 * backtick token is the placed name verbatim; no backtick at all (a plain
 * "beside the executable") places the member's own basename. */
function parseCellToPlacedAs(cell, member) {
  if (cell.includes('its own name')) return member;
  const token = firstBacktick(cell);
  if (token) return token.endsWith('/') ? token + path.basename(member) : token;
  return path.basename(member);
}

function parsePlacement(annexA) {
  return tableRows(annexA, '| File the entry places | Source |').map((cells) => {
    const [memberCol, sourceCol, placedAsCol, sha256Col, bytesCol, fileVersionCol] = cells;
    const member = firstBacktick(memberCol);
    const row = {
      member,
      placedAs: parseCellToPlacedAs(placedAsCol, member),
      sha256: firstBacktick(sha256Col),
      bytes: firstNumber(bytesCol),
      source: sourceCol.includes("entry's archive") ? 'archive'
        : sourceCol.includes("user's release") ? 'release'
        : firstBacktick(sourceCol),
    };
    if (fileVersionCol.trim() !== 'not applicable') row.fileVersion = fileVersionCol.trim();
    return row;
  });
}

/** Table three: every backtick-quoted member across every row, in order. */
function parseNotExtracted(annexA) {
  const rows = tableRows(annexA, '| Archive member not extracted | Why |');
  return rows.flatMap((cells) => allBackticks(cells[0]));
}

function buildEntries(specPath) {
  const specText = fs.readFileSync(specPath, 'utf8');
  const annexA = section(specText, '### Annex A.', '### Annex B.');
  const allowlist = parseAllowlist(annexA);
  const placement = parsePlacement(annexA);
  const notExtracted = parseNotExtracted(annexA);
  // One entry today, A1; a second row in table one would need its own slice
  // of table two and table three by entry id, which Annex A does not yet
  // need to carry.
  const entries = allowlist.map((entry) => ({ ...entry, placement, notExtracted }));
  return { entries, sourceSha256: crypto.createHash('sha256').update(specText).digest('hex') };
}

function serialise(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = indent + '  ';
    return `[\n${value.map((v) => `${inner}${serialise(v, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const inner = indent + '  ';
    const keys = Object.keys(value);
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${serialise(value[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function render({ entries, sourceSha256 }) {
  return `'use strict';
// Generated by scripts/gen-entries.js from Annex A of proton-install-core-spec.md.
// Never hand-edit; regenerate with:
//   node scripts/gen-entries.js <path-to-proton-install-core-spec.md> > src/linux/entries.js
// source: proton-install-core-spec.md
// source_sha256: ${sourceSha256}
//
// Entry A1's fields, the placement table as { member, placedAs, sha256, bytes, source } rows,
// \`placedAs\` relative to the executable folder, \`source\` one of 'archive', 'release' or the
// URL a file is read from, and the archive members the ensure step never extracts. Read by
// routeGate, ensureEntry and installEntry, the three Annex D hooks proton-install-core~9~4,
// ~10~7, ~16~2 and ~33~3 govern. Every entry, and every array and object it carries, is
// deep-frozen: no in-process code may rewrite a digest, a URL or a byte count before
// linux.ensureEntry( or linux.installEntry( reads it.

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  }
  return value;
};

const entries = deepFreeze(${serialise(entries)});

/** The entry for a route, or undefined where Annex A lists none. */
function entryFor(route) {
  return entries.find((entry) => entry.route === route);
}

/** The placement rows the ensure step extracts from the entry's archive. */
function archiveMembers(entry) {
  return entry.placement.filter((row) => row.source === 'archive');
}

module.exports = { entries, entryFor, archiveMembers };
`;
}

function main() {
  const specPath = process.argv[2];
  if (!specPath) fail('usage: gen-entries.js <path-to-proton-install-core-spec.md>');
  process.stdout.write(render(buildEntries(specPath)));
}

if (require.main === module) main();

module.exports = { buildEntries, render, parseAllowlist, parsePlacement, parseNotExtracted, section };
