'use strict';
/**
 * A local stand-in for GitHub Releases, used by unit tests and the end-to-end run.
 * Mimics the parts the launcher relies on: /releases/latest/download/<file> and
 * /releases/download/<tag>/<file> both answer with a 302 to a separate "asset" URL.
 */
const http = require('http');
const zlib = require('zlib');

function makeZip(entries) {
  // entries: [{name, data: Buffer, deflate?: boolean}]
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = e.deflate === false ? e.data : zlib.deflateRawSync(e.data);
    const method = e.deflate === false ? 0 : 8;
    const crc = zlib.crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A tiny but valid "game build" whose header says which version it is. */
function fakeGameHtml(version, extra = '') {
  return Buffer.from(`<!DOCTYPE html>\n<!--\n  v${version} — test build\n-->\n<html><head><meta charset="UTF-8"><title>t</title></head>` +
    `<body><div id="root">GAME v${version}</div>${extra}<script>window.GAME_VERSION=${JSON.stringify(String(version))};localStorage.setItem('seen-'+window.GAME_VERSION,'1');</script></body></html>`);
}

class FakeGithub {
  constructor({ repo = 'owner/repo' } = {}) {
    this.repo = repo;
    this.files = new Map();        // "tag/file" -> Buffer
    this.latestTag = null;
    this.failures = new Map();     // path -> remaining failures (HTTP 500)
    this.truncate = new Set();     // paths served cut short (connection drops mid-body)
    this.requests = [];
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  async start() {
    await new Promise(r => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  stop() { return new Promise(r => this.server.close(r)); }

  get feedUrl() { return `${this.base}/${this.repo}/releases/latest/download/latest.json`; }
  assetUrl(tag, file) { return `${this.base}/${this.repo}/releases/download/${tag}/${file}`; }

  publish(tag, files, { latest = true } = {}) {
    for (const [name, data] of Object.entries(files)) this.files.set(`${tag}/${name}`, Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (latest) this.latestTag = tag;
  }

  _handle(req, res) {
    const url = new URL(req.url, this.base);
    this.requests.push(url.pathname);
    const p = decodeURIComponent(url.pathname);
    const fail = this.failures.get(p);
    if (fail) { this.failures.set(p, fail - 1); res.writeHead(500); return res.end('boom'); }
    const prefix = `/${this.repo}/releases/`;
    if (p.startsWith(prefix + 'latest/download/')) {
      if (!this.latestTag) { res.writeHead(404); return res.end('Not Found'); }
      const file = p.slice((prefix + 'latest/download/').length);
      if (!this.files.has(`${this.latestTag}/${file}`)) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(302, { location: `${this.base}/assets/${this.latestTag}/${file}?sig=${Date.now()}` });
      return res.end();
    }
    if (p.startsWith(prefix + 'download/')) {
      const rest = p.slice((prefix + 'download/').length);
      if (!this.files.has(rest)) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(302, { location: `${this.base}/assets/${rest}?sig=${Date.now()}` });
      return res.end();
    }
    if (p.startsWith('/assets/')) {
      const key = p.slice('/assets/'.length);
      const data = this.files.get(key);
      if (!data) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
      if (this.truncate.has(key)) { this.truncate.delete(key); res.write(data.subarray(0, Math.floor(data.length / 2))); return res.destroy(); }
      // Send in chunks so progress events actually fire.
      let i = 0;
      const step = Math.max(64 * 1024, Math.ceil(data.length / 20));
      const pump = () => {
        if (i >= data.length) return res.end();
        const ok = res.write(data.subarray(i, i + step));
        i += step;
        if (ok) setImmediate(pump); else res.once('drain', pump);
      };
      return pump();
    }
    res.writeHead(404); res.end('Not Found');
  }
}

module.exports = { FakeGithub, makeZip, fakeGameHtml };
