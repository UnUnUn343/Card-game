#!/usr/bin/env node
'use strict';
/**
 * Release tool. Builds the files the launcher's updater reads and (optionally) uploads them.
 * You normally never run this by hand: the GitHub Actions in .github/workflows call it.
 *
 *   node scripts/release.js game      --html <file> --repo owner/repo --tag v185 [--notes-file f] [--base latest.json] [--out dir] [--upload]
 *   node scripts/release.js launcher  --installer <exe> --repo owner/repo --tag launcher-v1.1.0 [--notes …] [--base-from-releases] [--upload]
 *   node scripts/release.js ci-game   --repo owner/repo --tag v185        (CI: a release was published with a game file attached)
 *   node scripts/release.js fetch-game --repo owner/repo                  (CI: bundle the newest published game into game/)
 *   node scripts/release.js configure --repo owner/repo                   (writes app.config.json)
 *
 * --upload and the ci-* commands use the GitHub CLI (`gh`), which reads GH_TOKEN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { extractGameHtml } = require('../src/shared/gamePackage');
const { detectGameVersion, normalizeVersion, compareVersions } = require('../src/shared/versioning');
const { SCHEMA, parseManifest, releaseAssetUrl, isConfiguredRepo } = require('../src/shared/manifest');

const HISTORY_KEEP = 9;           // earlier game versions carried in latest.json (the launcher shows the last 5 updates)
const HISTORY_NOTES_MAX = 8000;   // characters of notes kept per earlier version

const ROOT = path.join(__dirname, '..');

// ── pure part (unit-tested) ──────────────────────────────────────────────────────────────────
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const str = v => (typeof v === 'string' ? v : '');
const today = () => new Date().toISOString().slice(0, 10);

/** Version from a tag like "v185" / "185" / "v185.1"; null for anything else ("launcher-v1.0.0", "test"). */
function versionFromTag(tag) {
  return /^v?\d+(\.\d+)*$/i.test(String(tag || '')) ? normalizeVersion(tag) : null;
}

/**
 * Packs a game build for release.
 * @returns {{version, fileName, gz: Buffer, entry: object}}
 */
/**
 * game.history for a new latest.json: the notes of the game versions before `current`, newest first.
 * `sources` are lists of game entries (a previous latest.json's game block, its history, the game
 * blocks found on recent releases), in any order and with repeats; the first entry with notes wins.
 */
function gameHistory(sources, current) {
  const byVersion = new Map();
  for (const list of sources) {
    for (const e of list || []) {
      const v = e && normalizeVersion(e.version);
      if (!v || (current && compareVersions(v, current) >= 0)) continue;
      const notes = str(e.notes).trim().slice(0, HISTORY_NOTES_MAX);
      const had = byVersion.get(v);
      if (!had || (!had.notes && notes)) byVersion.set(v, { version: v, notes, date: typeof e.date === 'string' ? e.date : (had && had.date) || null });
    }
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, HISTORY_KEEP);
}

function buildGameRelease({ input, inputName, repo, tag, version, notes, minLauncher, history }) {
  const { html, innerName } = extractGameHtml(input);
  // The file's own first line ("v188 — …") wins over the tag: it's what the game says it is, and what
  // the launcher reads from a build installed by hand. A tag typed as "v1.8.8" once published 188 as
  // version 1.8.8, which every launcher then saw as OLDER than 187 and ignored.
  const fromFile = detectGameVersion(html);
  const fromTag = versionFromTag(tag);
  if (fromFile && fromTag && fromFile !== fromTag) console.warn(`Tag ${tag} says ${fromTag}, the file says v${fromFile}: using v${fromFile}.`);
  const v = normalizeVersion(version) || fromFile || fromTag || detectGameVersion(html, innerName || inputName);
  if (!v) throw new Error('Cannot tell the game version: name the tag like v185, or put "v185 — …" at the top of the file.');
  const fileName = `pokemon_battle_v${v}.html.gz`;
  const gz = zlib.gzipSync(html, { level: 9 });
  const entry = {
    version: v,
    url: releaseAssetUrl(repo, tag, fileName),
    sha256: sha256(gz),
    size: gz.length,
    notes: (notes || '').trim(),
    date: today(),
    ...(minLauncher ? { minLauncher: normalizeVersion(minLauncher) } : {}),
  };
  const h = gameHistory([history], v);
  if (h.length) entry.history = h;
  return { version: v, fileName, gz, entry };
}

function buildLauncherEntry({ installer, installerName, repo, tag, version, notes }) {
  return {
    version: normalizeVersion(version),
    url: releaseAssetUrl(repo, tag, installerName),
    sha256: sha256(installer),
    size: installer.length,
    notes: (notes || '').trim(),
    date: today(),
  };
}

/** New latest.json = the previous one with one block replaced. Validates the result. */
function mergeManifest(base, patch) {
  const out = { schema: SCHEMA, game: (base && base.game) || undefined, launcher: (base && base.launcher) || undefined, ...patch };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  parseManifest(out, 'https://github.com/'); // throws if broken
  return out;
}

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────
function args() {
  const a = process.argv.slice(3);
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (i + 1 < a.length && !a[i + 1].startsWith('--')) o[k] = a[++i]; else o[k] = true;
  }
  return o;
}

function need(o, ...keys) {
  for (const k of keys) if (!o[k]) { console.error(`missing --${k}`); process.exit(2); }
}

function gh(...a) {
  return execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function readBase(o) {
  if (o.base && fs.existsSync(o.base)) return JSON.parse(fs.readFileSync(o.base, 'utf8'));
  if (o.base === 'none') return null;
  // In CI the release being built is already "latest" (without a latest.json yet), so look past it.
  if (o['base-from-releases']) return previousManifestViaGh(o.repo, o.tag);
  return fetchJson(`https://github.com/${o.repo}/releases/latest/download/latest.json`).catch(() => null);
}

/**
 * The most up-to-date game and launcher entries published so far (ignoring `exceptTag`).
 *
 * Don't trust GitHub's list order: a release's created_at is the date of the commit it was tagged
 * on, and the list isn't reliably sorted even by that (v184 was listed ahead of the newer
 * launcher-v1.0.2, which is how v185's latest.json lost its launcher entry). So read latest.json from
 * the recent published releases and keep the HIGHEST version of each block, whatever the order.
 */
function previousManifestViaGh(repo, exceptTag) {
  const releases = JSON.parse(gh('api', `repos/${repo}/releases?per_page=30`))
    .filter(r => !r.draft && !r.prerelease && r.tag_name !== exceptTag && (r.assets || []).some(a => a.name === 'latest.json'))
    .sort((x, y) => String(y.published_at || '').localeCompare(String(x.published_at || '')))
    .slice(0, 12);
  let best = null;
  const games = [];
  for (const r of releases) {
    let m;
    try { m = JSON.parse(gh('release', 'download', r.tag_name, '--repo', repo, '--pattern', 'latest.json', '--output', '-')); }
    catch { continue; }
    if (m && m.game && m.game.version) games.push(m.game, ...(Array.isArray(m.game.history) ? m.game.history : []));
    for (const k of ['game', 'launcher']) {
      if (!m || !m[k] || !m[k].version) continue;
      best = best || { schema: SCHEMA };
      if (!best[k] || compareVersions(m[k].version, best[k].version) > 0) best[k] = m[k];
    }
  }
  // The newest game block also gets the history of the ones before it, from every latest.json read
  // (releases published before history existed still have their own game block and notes).
  if (best && best.game) {
    const h = gameHistory([best.game.history, games], best.game.version);
    best.game = { ...best.game };
    if (h.length) best.game.history = h; else delete best.game.history;
  }
  return best;
}

function writeOut(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const paths = [];
  for (const [name, data] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, data);
    paths.push(p);
  }
  return paths;
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────
const commands = {
  async game(o) {
    need(o, 'html', 'repo', 'tag');
    const notes = o['notes-file'] ? fs.readFileSync(o['notes-file'], 'utf8') : str(o.notes);
    const base = o.baseManifest !== undefined ? o.baseManifest : await readBase(o);
    // Earlier versions' notes: the version this one replaces, and the history it carried.
    const history = base && base.game ? [base.game, ...(Array.isArray(base.game.history) ? base.game.history : [])] : [];
    const rel = buildGameRelease({ input: fs.readFileSync(o.html), inputName: path.basename(o.html), repo: o.repo, tag: o.tag, version: o.version, notes, minLauncher: o['min-launcher'], history });
    const manifest = mergeManifest(base, { game: rel.entry });
    const out = o.out || path.join(ROOT, 'release', o.tag);
    const files = writeOut(out, { [rel.fileName]: rel.gz, 'latest.json': JSON.stringify(manifest, null, 2) + '\n' });
    console.log(`game v${rel.version}: ${rel.fileName} (${(rel.gz.length / 1048576).toFixed(1)} MB), sha256 ${rel.entry.sha256.slice(0, 12)}…`);
    if (o.upload) { gh('release', 'upload', o.tag, ...files, '--clobber', '--repo', o.repo); console.log('uploaded to release', o.tag); }
    else console.log(`files in ${out}. Attach both to the GitHub release "${o.tag}".`);
    return manifest;
  },

  async launcher(o) {
    need(o, 'installer', 'repo', 'tag');
    const installerName = path.basename(o.installer);
    const version = o.version || (o.tag.match(/(\d+\.\d+\.\d+.*)$/) || [])[1];
    if (!normalizeVersion(version)) throw new Error('Cannot tell the launcher version; pass --version 1.2.3');
    const entry = buildLauncherEntry({ installer: fs.readFileSync(o.installer), installerName, repo: o.repo, tag: o.tag, version, notes: o['notes-file'] ? fs.readFileSync(o['notes-file'], 'utf8') : str(o.notes) });
    const base = o.baseManifest !== undefined ? o.baseManifest : await readBase(o);
    const manifest = mergeManifest(base, { launcher: entry });
    const out = o.out || path.join(ROOT, 'release', o.tag);
    const files = writeOut(out, { 'latest.json': JSON.stringify(manifest, null, 2) + '\n' });
    console.log(`launcher ${entry.version}: ${installerName}, sha256 ${entry.sha256.slice(0, 12)}…`);
    if (o.upload) { gh('release', 'upload', o.tag, ...files, '--clobber', '--repo', o.repo); console.log('uploaded latest.json to', o.tag); }
    return manifest;
  },

  /** CI: a human published release <tag> with the game's .html/.zip attached. Add the .gz and latest.json. */
  async 'ci-game'(o) {
    need(o, 'repo', 'tag');
    const rel = JSON.parse(gh('release', 'view', o.tag, '--repo', o.repo, '--json', 'body,assets,isPrerelease'));
    const candidates = rel.assets.filter(a => /\.(html?|zip)$/i.test(a.name)).sort((a, b) => b.size - a.size);
    if (!candidates.length) {
      // Not a game release. It is still "latest" now, so give it the current latest.json or the
      // launchers would find nothing until the next game release.
      const prev = previousManifestViaGh(o.repo, o.tag);
      if (!prev) { console.log(`Release ${o.tag} has no game file and there is no earlier latest.json: nothing to do.`); return null; }
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-'));
      const files = writeOut(out, { 'latest.json': JSON.stringify(prev, null, 2) + '\n' });
      gh('release', 'upload', o.tag, ...files, '--clobber', '--repo', o.repo);
      console.log(`Release ${o.tag} has no game file: copied the current latest.json onto it.`);
      return prev;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-'));
    gh('release', 'download', o.tag, '--repo', o.repo, '--pattern', candidates[0].name, '--dir', tmp);
    const notesFile = path.join(tmp, 'notes.md');
    fs.writeFileSync(notesFile, rel.body || '');
    return commands.game({
      ...o, html: path.join(tmp, candidates[0].name), 'notes-file': notesFile, out: path.join(tmp, 'out'), upload: true,
      baseManifest: previousManifestViaGh(o.repo, o.tag),
    });
  },

  /** CI: put the newest published game into game/ so the installer ships with it. */
  async 'fetch-game'(o) {
    need(o, 'repo');
    const m = await fetchJson(`https://github.com/${o.repo}/releases/latest/download/latest.json`);
    if (!m || !m.game) {
      if (fs.existsSync(path.join(ROOT, 'game', 'game.html'))) { console.log('No published game yet; keeping the game/ already in the repo.'); return; }
      throw new Error('No published game release yet and no game/game.html in the repo. Publish a game release first.');
    }
    const entry = parseManifest(m, 'https://github.com/').game;
    const res = await fetch(entry.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${entry.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (entry.sha256 && sha256(buf) !== entry.sha256) throw new Error('Checksum mismatch on the published game');
    const { html } = extractGameHtml(buf);
    const dir = path.join(ROOT, 'game');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'game.html'), html);
    fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({ version: entry.version, notes: entry.notes, date: entry.date }, null, 2) + '\n');
    console.log(`bundled game v${entry.version}`);
  },

  async configure(o) {
    need(o, 'repo');
    if (!isConfiguredRepo(o.repo)) throw new Error(`"${o.repo}" is not owner/repo`);
    const file = path.join(ROOT, 'app.config.json');
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    cfg.github = o.repo;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`app.config.json -> github: ${o.repo}`);
  },
};

if (require.main === module) {
  const cmd = process.argv[2];
  if (!commands[cmd]) {
    console.error(`usage: node scripts/release.js <${Object.keys(commands).join('|')}> [options]\nSee the comment at the top of this file.`);
    process.exit(2);
  }
  commands[cmd](args()).catch(err => { console.error(`release ${cmd} failed: ${err.message}`); process.exit(1); });
}

module.exports = { buildGameRelease, buildLauncherEntry, mergeManifest, gameHistory, versionFromTag, commands };
