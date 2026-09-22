'use strict';
/**
 * Keeps track of every game build the launcher can play.
 *
 *   bundled   the build shipped inside the installer (read-only, in the app's resources)
 *   download  builds fetched by the updater          -> <userData>/games/<version>/
 *   file      builds installed by hand (drag & drop)  -> <userData>/games/<version or local-…>/
 *
 * Each installed build is a folder with game.html and game.json (its metadata).
 * The build that gets played is the pinned one if the player picked one, otherwise the newest.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compareVersions, normalizeVersion } = require('../shared/versioning');

const KEEP_INSTALLED = 3; // newest N downloaded/local builds kept on disk, besides pinned/active

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function safeId(s) {
  return String(s).replace(/[^0-9A-Za-z._-]/g, '_').replace(/^\.+/, '_').slice(0, 64);
}

class GameStore {
  /**
   * @param {{rootDir: string, bundledDir: string}} opts
   */
  constructor({ rootDir, bundledDir }) {
    this.rootDir = rootDir;
    this.bundledDir = bundledDir;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  bundled() {
    const html = path.join(this.bundledDir, 'game.html');
    if (!fs.existsSync(html)) return null;
    const meta = readJson(path.join(this.bundledDir, 'game.json')) || {};
    const version = normalizeVersion(meta.version);
    return { id: 'bundled', version, label: meta.label || null, source: 'bundled', path: html, notes: meta.notes || '', date: meta.date || null };
  }

  /** All playable builds, newest first. */
  list() {
    const out = [];
    const b = this.bundled();
    if (b) out.push(b);
    let dirs = [];
    try { dirs = fs.readdirSync(this.rootDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')); } catch {}
    for (const d of dirs) {
      const dir = path.join(this.rootDir, d.name);
      const html = path.join(dir, 'game.html');
      const meta = readJson(path.join(dir, 'game.json'));
      if (!meta || !fs.existsSync(html)) continue;
      out.push({ ...meta, id: d.name, version: normalizeVersion(meta.version), path: html });
    }
    return out.sort(GameStore.order);
  }

  /** Newest version first; for the same version a downloaded build beats a hand-installed one beats bundled. */
  static order(a, b) {
    const c = compareVersions(b.version, a.version);
    if (c) return c;
    const rank = { download: 0, file: 1, bundled: 2 };
    const r = (rank[a.source] ?? 3) - (rank[b.source] ?? 3);
    if (r) return r;
    return (b.installedAt || '').localeCompare(a.installedAt || '');
  }

  get(id) { return this.list().find(e => e.id === id) || null; }

  newest() { return this.list().find(e => e.version) || this.list()[0] || null; }

  /** Highest version on disk (any source). */
  newestVersion() { const n = this.newest(); return n ? n.version : null; }

  /** The build to play: the pinned one if it still exists, else the newest. */
  resolveActive(pinnedId) {
    if (pinnedId) {
      const p = this.get(pinnedId);
      if (p) return p;
    }
    return this.newest();
  }

  findByVersion(version) {
    const v = normalizeVersion(version);
    return this.list().filter(e => e.version && compareVersions(e.version, v) === 0);
  }

  /**
   * Installs a build from its HTML. Written to a temp folder then renamed, so a crash half-way
   * never leaves a broken build that looks installed.
   * @param {Buffer} html
   * @param {{version: string|null, source: 'download'|'file', notes?: string, date?: string,
   *          originalName?: string, packageSha256?: string}} meta
   */
  install(html, meta) {
    const version = normalizeVersion(meta.version);
    const id = version ? safeId(version) : safeId(`local-${Date.now()}`);
    const finalDir = path.join(this.rootDir, id);
    const tmpDir = path.join(this.rootDir, `.tmp-${id}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const record = {
      version,
      label: version ? null : (meta.originalName || 'local build'),
      source: meta.source,
      notes: meta.notes || '',
      date: meta.date || null,
      originalName: meta.originalName || null,
      packageSha256: meta.packageSha256 || null,
      sha256: crypto.createHash('sha256').update(html).digest('hex'),
      size: html.length,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmpDir, 'game.html'), html);
    fs.writeFileSync(path.join(tmpDir, 'game.json'), JSON.stringify(record, null, 2));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    return { ...record, id, path: path.join(finalDir, 'game.html') };
  }

  remove(id) {
    if (id === 'bundled') throw new Error('The bundled build is part of the app and cannot be removed.');
    const sid = safeId(id);
    if (!sid || sid.startsWith('.')) throw new Error('Bad build id');
    const dir = path.join(this.rootDir, sid);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Deletes old downloaded/local builds, keeping the newest KEEP_INSTALLED plus anything in `protect`. */
  prune(protect = []) {
    const keep = new Set(protect.filter(Boolean));
    const installed = this.list().filter(e => e.source !== 'bundled');
    installed.slice(0, KEEP_INSTALLED).forEach(e => keep.add(e.id));
    const removed = [];
    for (const e of installed) {
      if (!keep.has(e.id)) { this.remove(e.id); removed.push(e.id); }
    }
    // Leftovers from installs that were interrupted (older than an hour, so never one in progress).
    try {
      for (const d of fs.readdirSync(this.rootDir)) {
        if (!d.startsWith('.tmp-')) continue;
        const p = path.join(this.rootDir, d);
        if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
    return removed;
  }
}

module.exports = { GameStore, KEEP_INSTALLED };
