'use strict';
/**
 * The update feed: one small JSON file, `latest.json`, attached to every GitHub release.
 *
 * The launcher always reads it from
 *   https://github.com/<owner>/<repo>/releases/latest/download/latest.json
 * which GitHub redirects to that file on whichever release is currently marked "latest".
 * So publishing a release that carries a new latest.json IS the update, and there is no
 * GitHub API call involved (no rate limits, no token).
 *
 * {
 *   "schema": 1,
 *   "game":     { "version": "185", "url": "https://…/pokemon_battle_v185.html.gz",
 *                 "sha256": "…", "size": 25000000, "notes": "…", "date": "2026-09-30",
 *                 "minLauncher": "1.0.0" },
 *                 "history": [{ "version": "184", "notes": "…", "date": "2026-09-20" }, …] },
 *   "launcher": { "version": "1.1.0", "url": "https://…/Pokemon-Battle-Setup-1.1.0.exe",
 *                 "sha256": "…", "size": 90000000, "notes": "…", "date": "…" }
 * }
 * Every release carries BOTH blocks (the release script copies the one it isn't changing
 * forward), because only the newest release's latest.json is ever read.
 * game.history (optional, added for launcher 1.0.3): the notes of the game versions before this one,
 * newest first, so the launcher can show the last few updates. Launchers before 1.0.3 ignore it.
 */
const { normalizeVersion } = require('./versioning');

const SCHEMA = 1;
const HISTORY_MAX = 12;
const PLACEHOLDER_REPO = 'OWNER/REPO';

function isConfiguredRepo(repo) {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) && repo.trim() !== PLACEHOLDER_REPO;
}

/** Where to read latest.json from, given app config and (optional) user override. */
function feedUrlFrom({ feedUrl, github } = {}) {
  if (feedUrl && /^https?:\/\//i.test(feedUrl)) return feedUrl.trim();
  if (isConfiguredRepo(github)) return `https://github.com/${github.trim()}/releases/latest/download/latest.json`;
  return null;
}

/** Accepts "owner/repo", a github.com repo URL, or a direct https URL to a latest.json. */
function parseUpdateSource(input) {
  const s = String(input || '').trim();
  if (!s) return { github: null, feedUrl: null };
  const gh = s.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (gh && !/\.json$/i.test(s)) return { github: `${gh[1]}/${gh[2]}`, feedUrl: null };
  if (/^https?:\/\//i.test(s)) return { github: null, feedUrl: s };
  throw new Error('Expected "owner/repo" or a https:// link to latest.json');
}

function releaseAssetUrl(repo, tag, fileName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

function cleanEntry(raw, kind, baseUrl) {
  if (!raw || typeof raw !== 'object') return null;
  const version = normalizeVersion(raw.version);
  if (!version) throw new Error(`latest.json: ${kind}.version is missing or not a version`);
  if (!raw.url || typeof raw.url !== 'string') throw new Error(`latest.json: ${kind}.url is missing`);
  let url;
  try { url = new URL(raw.url, baseUrl).toString(); } catch { throw new Error(`latest.json: ${kind}.url is not a valid link`); }
  if (!/^https?:/.test(url)) throw new Error(`latest.json: ${kind}.url must be http(s)`);
  const sha256 = raw.sha256 ? String(raw.sha256).toLowerCase() : null;
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`latest.json: ${kind}.sha256 is not a SHA-256 hex digest`);
  const size = Number.isFinite(raw.size) && raw.size > 0 ? raw.size : null;
  return {
    version,
    url,
    sha256,
    size,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 20000) : '',
    date: typeof raw.date === 'string' ? raw.date : null,
    ...(kind === 'game' ? { minLauncher: raw.minLauncher ? normalizeVersion(raw.minLauncher) : null, history: cleanHistory(raw.history, version) } : {}),
  };
}

/** Earlier versions' notes. Lenient: a bad item is dropped, never a reason to reject the feed. */
function cleanHistory(raw, current) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set([current]);
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    const version = normalizeVersion(h.version);
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push({ version, notes: typeof h.notes === 'string' ? h.notes.slice(0, 20000) : '', date: typeof h.date === 'string' ? h.date : null });
    if (out.length >= HISTORY_MAX) break;
  }
  return out;
}

/** Validates and normalises a parsed latest.json. Throws with a readable message if it's broken. */
function parseManifest(json, baseUrl) {
  if (!json || typeof json !== 'object') throw new Error('latest.json is not a JSON object');
  if (json.schema != null && Number(json.schema) > SCHEMA) {
    // A future format. Still try: fields are only ever added, never repurposed.
  }
  const game = cleanEntry(json.game, 'game', baseUrl);
  const launcher = cleanEntry(json.launcher, 'launcher', baseUrl);
  if (!game && !launcher) throw new Error('latest.json has neither a game nor a launcher entry');
  return { schema: SCHEMA, game, launcher };
}

module.exports = { SCHEMA, HISTORY_MAX, cleanHistory, PLACEHOLDER_REPO, isConfiguredRepo, feedUrlFrom, parseUpdateSource, releaseAssetUrl, parseManifest };
