'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { GameStore, KEEP_INSTALLED } = require('../src/main/gameStore');
const { download } = require('../src/main/downloader');
const { FakeGithub, fakeGameHtml } = require('./helpers/fakeGithub');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-test-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function storeWithBundled(version = '184') {
  const dir = tmp();
  const bundledDir = path.join(dir, 'bundled');
  fs.mkdirSync(bundledDir);
  fs.writeFileSync(path.join(bundledDir, 'game.html'), fakeGameHtml(version));
  fs.writeFileSync(path.join(bundledDir, 'game.json'), JSON.stringify({ version }));
  return new GameStore({ rootDir: path.join(dir, 'games'), bundledDir });
}

test('store: bundled build is found and is the active one by default', () => {
  const s = storeWithBundled('184');
  assert.equal(s.list().length, 1);
  assert.equal(s.resolveActive(null).id, 'bundled');
  assert.equal(s.newestVersion(), '184');
});

test('store: newest version wins; a pin wins over newest while it exists', () => {
  const s = storeWithBundled('184');
  s.install(fakeGameHtml(185), { version: '185', source: 'download' });
  s.install(fakeGameHtml(186), { version: '186', source: 'download' });
  assert.equal(s.resolveActive(null).version, '186');
  assert.equal(s.resolveActive('185').version, '185');
  s.remove('185');
  assert.equal(s.resolveActive('185').version, '186', 'pinned build gone -> newest');
});

test('store: same version prefers downloaded over hand-installed over bundled', () => {
  const s = storeWithBundled('185');
  s.install(fakeGameHtml(185), { version: '185', source: 'file' });
  assert.equal(s.resolveActive(null).source, 'file');
  s.install(fakeGameHtml(185), { version: '185', source: 'download' });
  assert.equal(s.list().filter(b => b.version === '185').length, 2, 'installed 185 replaced in place, bundled 185 kept');
  assert.equal(s.resolveActive(null).source, 'download');
});

test('store: builds without a version get a local id and never beat numbered ones', () => {
  const s = storeWithBundled('184');
  const local = s.install(Buffer.from('<!DOCTYPE html><html></html>'), { version: null, source: 'file', originalName: 'my-test.html' });
  assert.match(local.id, /^local-/);
  assert.equal(local.label, 'my-test.html');
  assert.equal(s.resolveActive(null).id, 'bundled');
  assert.equal(s.resolveActive(local.id).id, local.id);
});

test('store: prune keeps the newest few plus protected builds, never the bundled one', () => {
  const s = storeWithBundled('184');
  for (let v = 185; v <= 190; v++) s.install(fakeGameHtml(v), { version: String(v), source: 'download' });
  const removed = s.prune(['185']);
  const left = s.list().map(b => b.id).sort();
  assert.deepEqual(left, ['185', '188', '189', '190', 'bundled'].sort());
  assert.equal(removed.length, 6 - KEEP_INSTALLED - 1);
  assert.throws(() => s.remove('bundled'));
  s.remove('..'); s.remove('../..'); // must not escape the games folder
  assert.ok(fs.existsSync(s.rootDir) && fs.existsSync(path.join(s.bundledDir, 'game.html')));
});

test('download: follows redirects, reports progress, verifies checksum', async () => {
  const gh = await new FakeGithub().start();
  try {
    const data = crypto.randomBytes(900 * 1024);
    gh.publish('v185', { 'big.bin': data });
    const dest = path.join(tmp(), 'out.bin');
    const seen = [];
    const r = await download(gh.assetUrl('v185', 'big.bin'), dest, { fetchImpl: fetch, expectedSha256: sha(data), expectedSize: data.length, onProgress: p => seen.push(p.received) });
    assert.equal(r.sha256, sha(data));
    assert.deepEqual(fs.readFileSync(dest), data);
    assert.ok(seen.length >= 3, `progress fired ${seen.length} times`);
    assert.equal(seen[seen.length - 1], data.length);
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { await gh.stop(); }
});

test('download: wrong checksum is rejected and nothing is left behind', async () => {
  const gh = await new FakeGithub().start();
  try {
    gh.publish('v185', { 'f.bin': Buffer.from('hello') });
    const dest = path.join(tmp(), 'f.bin');
    await assert.rejects(download(gh.assetUrl('v185', 'f.bin'), dest, { fetchImpl: fetch, expectedSha256: 'b'.repeat(64), retries: 0 }), /Checksum mismatch/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
  } finally { await gh.stop(); }
});

test('download: retries after a server error and after a dropped connection', async () => {
  const gh = await new FakeGithub().start();
  try {
    const data = crypto.randomBytes(300 * 1024);
    gh.publish('v185', { 'f.bin': data });
    gh.failures.set('/assets/v185/f.bin', 1);
    gh.truncate.add('v185/f.bin');
    const dest = path.join(tmp(), 'f.bin');
    const r = await download(gh.assetUrl('v185', 'f.bin'), dest, { fetchImpl: fetch, expectedSha256: sha(data), retries: 3 });
    assert.equal(r.size, data.length);
  } finally { await gh.stop(); }
});

test('download: 404 is not retried and cancel stops it', async () => {
  const gh = await new FakeGithub().start();
  try {
    const dest = path.join(tmp(), 'x.bin');
    const before = gh.requests.length;
    await assert.rejects(download(gh.assetUrl('v185', 'missing.bin'), dest, { fetchImpl: fetch, retries: 3 }), /HTTP 404/);
    assert.equal(gh.requests.length - before, 1, 'no retries on 404');
    gh.publish('v185', { 'f.bin': crypto.randomBytes(2 * 1024 * 1024) });
    const ac = new AbortController();
    const p = download(gh.assetUrl('v185', 'f.bin'), dest, { fetchImpl: fetch, signal: ac.signal, onProgress: () => ac.abort() });
    await assert.rejects(p, /cancelled/);
  } finally { await gh.stop(); }
});
