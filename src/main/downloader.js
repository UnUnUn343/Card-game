'use strict';
/**
 * Streams a URL to disk while hashing it, then checks size and SHA-256.
 * `fetchImpl` is injected: Electron's net.fetch in the app (follows GitHub's redirects, uses the
 * system proxy), plain global fetch in tests.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DownloadError extends Error {
  constructor(message, { retryable = true } = {}) { super(message); this.retryable = retryable; }
}

async function downloadOnce(url, dest, { fetchImpl, onProgress, signal, expectedSize }) {
  const res = await fetchImpl(url, { signal, cache: 'no-store', redirect: 'follow' });
  if (!res.ok) throw new DownloadError(`HTTP ${res.status} for ${url}`, { retryable: res.status >= 500 || res.status === 429 });
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  const tmp = dest + '.part';
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(tmp);
  let writeErr = null;
  out.on('error', e => { writeErr = e; });
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastEmit = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writeErr) throw writeErr;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => { out.once('drain', resolve); out.once('error', reject); });
      }
      const now = Date.now();
      if (onProgress && (now - lastEmit > 100 || received === total)) {
        lastEmit = now;
        onProgress({ received, total });
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fs.promises.rm(tmp, { force: true });
    if (signal && signal.aborted) throw new DownloadError('Download cancelled', { retryable: false });
    throw err instanceof DownloadError ? err : new DownloadError(`Download interrupted: ${err.message}`);
  }
  if (onProgress) onProgress({ received, total: total || received });
  return { tmp, received, sha256: hash.digest('hex') };
}

/**
 * @param {string} url
 * @param {string} dest final path; written to dest+'.part' first and renamed only once verified
 * @param {{fetchImpl: Function, onProgress?: Function, signal?: AbortSignal,
 *          expectedSha256?: string|null, expectedSize?: number|null, retries?: number}} opts
 * @returns {Promise<{path: string, size: number, sha256: string}>}
 */
async function download(url, dest, opts) {
  const { retries = 2, expectedSha256, expectedSize } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal && opts.signal.aborted) throw new DownloadError('Download cancelled', { retryable: false });
    try {
      const r = await downloadOnce(url, dest, opts);
      if (expectedSize && r.received !== expectedSize) {
        await fs.promises.rm(r.tmp, { force: true });
        throw new DownloadError(`Size mismatch: got ${r.received} bytes, expected ${expectedSize}`);
      }
      if (expectedSha256 && r.sha256 !== expectedSha256.toLowerCase()) {
        await fs.promises.rm(r.tmp, { force: true });
        throw new DownloadError('Checksum mismatch: the downloaded file is not the one that was published');
      }
      await fs.promises.rm(dest, { force: true });
      await fs.promises.rename(r.tmp, dest);
      return { path: dest, size: r.received, sha256: r.sha256 };
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof DownloadError) || err.retryable;
      if (!retryable || attempt === retries) break;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

module.exports = { download, sha256File, DownloadError };
