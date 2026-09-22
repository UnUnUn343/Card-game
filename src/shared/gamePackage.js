'use strict';
/**
 * Turns whatever a game build arrives as into the game's HTML.
 *
 * Accepted: a plain .html, a gzipped .html.gz (what releases publish, ~25% smaller), or a .zip
 * holding one .html (how builds get passed around by hand, e.g. *_DROPIN_10.zip).
 * No dependencies: gzip and zip entries both go through Node's zlib.
 */
const zlib = require('zlib');

const MAX_HTML_BYTES = 300 * 1024 * 1024; // sanity cap; the game is ~33 MB today

function isGzip(buf) { return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b; }
function isZip(buf) { return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50; }

function looksLikeHtml(buf) {
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || (head.startsWith('<!--') && head.includes('<html'));
}

/** Minimal zip reader: finds the central directory and returns [{name, method, compSize, size, offset}]. */
function listZip(buf) {
  // End of central directory record is in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Zip file is damaged (no central directory).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip file is damaged (bad directory entry).');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, e) {
  const lh = e.offset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('Zip file is damaged (bad local header).');
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_HTML_BYTES });
  throw new Error(`Zip uses an unsupported compression method (${e.method}).`);
}

/**
 * @param {Buffer} buf
 * @returns {{html: Buffer, innerName: string|null}}
 */
function extractGameHtml(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (isGzip(buf)) {
    const html = zlib.gunzipSync(buf, { maxOutputLength: MAX_HTML_BYTES });
    if (!looksLikeHtml(html)) throw new Error('The .gz file does not contain an HTML page.');
    return { html, innerName: null };
  }
  if (isZip(buf)) {
    const htmls = listZip(buf).filter(e => /\.html?$/i.test(e.name) && !e.name.startsWith('__MACOSX/') && !e.name.endsWith('/'));
    if (!htmls.length) throw new Error('The .zip has no .html file inside.');
    // If several, take the biggest: that is the game, the rest are notes/changelogs.
    htmls.sort((a, b) => b.size - a.size);
    const html = readZipEntry(buf, htmls[0]);
    if (!looksLikeHtml(html)) throw new Error('The .html inside the .zip does not look like a web page.');
    return { html, innerName: htmls[0].name.split('/').pop() };
  }
  if (looksLikeHtml(buf)) return { html: buf, innerName: null };
  throw new Error('This file is not a game build. Expected .html, .html.gz or .zip.');
}

module.exports = { extractGameHtml, looksLikeHtml, isGzip, isZip, listZip };
