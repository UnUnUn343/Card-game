'use strict';
/**
 * Version helpers shared by the app, the release script and the tests.
 *
 * Game versions are what the game's own changelog uses: "184", "185", optionally "185.1".
 * Launcher versions are normal semver: "1.0.0". Both compare the same way here: split into
 * numeric parts and compare part by part ("185" < "185.1" < "186").
 */

/** @returns {number[]|null} numeric parts, or null if the string has no leading number */
function parseVersion(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  const m = s.match(/^\d+(?:\.\d+)*/);
  if (!m) return null;
  return m[0].split('.').map(n => parseInt(n, 10));
}

/** Returns >0 if a is newer, <0 if b is newer, 0 if equal. Unparseable versions sort oldest. */
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function isNewer(a, b) { return compareVersions(a, b) > 0; }

/** "v185" / "185" / " 185 " -> "185". Keeps dotted parts. Returns null if not a version. */
function normalizeVersion(v) {
  const p = parseVersion(v);
  return p ? p.join('.') : null;
}

/**
 * Work out a game build's version.
 * 1. The changelog comment at the top of the file: its first entry reads "v184 — ...".
 * 2. The file name: pokemon_battle_v185.html
 * Returns null when neither is found.
 */
function detectGameVersion(html, fileName) {
  const head = typeof html === 'string' ? html.slice(0, 20000) : html ? html.subarray(0, 20000).toString('utf8') : '';
  const fromHeader = head.match(/<!--\s*v(\d+(?:\.\d+)?)\s*[—–-]/);
  if (fromHeader) return fromHeader[1];
  const fromAnyLine = head.match(/^\s*v(\d+(?:\.\d+)?)\s+[—–-]/m);
  if (fromAnyLine) return fromAnyLine[1];
  if (fileName) {
    const fromName = String(fileName).match(/v(\d+(?:\.\d+)?)/i);
    if (fromName) return fromName[1];
  }
  return null;
}

module.exports = { parseVersion, compareVersions, isNewer, normalizeVersion, detectGameVersion };
