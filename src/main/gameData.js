'use strict';
/**
 * What the launcher reads from a game build (its .html) without running it (launcher 1.1.0):
 *   - the cards, for «Карта дня» on the Pokédex screen: the game's DB lines ("rf9:{id:"rf9",name:…") and the card's
 *     picture from its image table ("rf9":"data:image/jpeg;base64,…");
 *   - the group's Google Sheet: the game's own ANALYTICS_WEBAPP_URL (Наживо and Турніри read it).
 * Pure functions, no Electron: test/gameData.test.js runs them on a small fake build. A build that doesn't have a
 * part simply gives nothing for it, and the launcher leaves that panel out.
 */

const CARD_RE = /^(\w+):\{id:"(\w+)",name:"([^"]+)",hp:(\d+),type:"(\w+)"([^\n]*)\n((?:[ \t]+[^\n]*\n){0,4})/gm;

/** Every card the game defines (first definition of each id; Megas left out), with what the dex entry shows. */
function parseCards(html) {
  const out = new Map();
  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(html))) {
    const [, key, id, name, hp, type, rest, body] = m;
    if (key !== id || out.has(id) || /isMega:true/.test(rest + body)) continue;
    const attacks = [...body.matchAll(/\{n:"([^"]+)",dmg:(\d+)/g)].map(a => ({ name: a[1], dmg: Number(a[2]) }));
    if (!attacks.length) continue;
    const wk = /wk:\{t:"(\w+)"/.exec(rest), rs = /rs:\{t:"(\w+)"/.exec(rest), ab = /ab:\{n:"([^"]*)"/.exec(body);
    out.set(id, { id, name, hp: Number(hp), type, weak: wk ? wk[1] : null, resist: rs ? rs[1] : null, ability: ab ? ab[1] : null, attacks: attacks.slice(0, 3) });
  }
  return [...out.values()];
}

/** A card's picture (a data: URL), or null. */
function cardImage(html, id) {
  const key = `"${id}":"data:image/`;
  const i = html.indexOf(key);
  if (i < 0) return null;
  const start = i + id.length + 4;
  const end = html.indexOf('"', start);
  const src = end > start ? html.slice(start, end) : '';
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

function jsArray(html, name) {
  const m = new RegExp(`const ${name}=(\\[[^\\n;]*\\]);`).exec(html);
  if (!m) return [];
  try { return JSON.parse(m[1].replace(/'/g, '"')); } catch { return []; }
}

/** The rotation letter of a card id from the game's ROTATION_LETTERS (longest prefix wins: "gb3" is B, "g3" is C). */
function rotationOf(id, rotations) {
  let best = null;
  for (const [letter, prefix] of rotations) {
    if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)) && (!best || prefix.length > best.prefix.length)) best = { letter, prefix };
  }
  return best;
}

/** The same number for the same day on every PC (FNV-1a of "YYYY-MM-DD"). */
function dayIndex(dateKey, n) {
  let h = 2166136261;
  for (const ch of String(dateKey)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

/**
 * «Карта дня»: one card of a rotation that is still played (not a locked one), with a picture, the same one all day.
 * dateKey is the local day, "YYYY-MM-DD".
 */
function cardOfDay(html, dateKey) {
  const rotations = jsArray(html, 'ROTATION_LETTERS');
  const locked = jsArray(html, 'LOCKED_ROTATION_PREFIXES');
  const pictured = new Set([...html.matchAll(/"(\w+)":"data:image\//g)].map(m => m[1]));// one pass, not one per card
  const list = parseCards(html)
    .map(c => ({ c, r: rotationOf(c.id, rotations) }))
    .filter(x => x.r && !locked.includes(x.r.prefix) && pictured.has(x.c.id))
    .sort((a, b) => (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
  if (!list.length) return null;
  const { c, r } = list[dayIndex(dateKey, list.length)];
  return { ...c, rotation: r.letter, image: cardImage(html, c.id), date: dateKey };
}

/** The game's Google Sheet web app, or null. */
function sheetUrl(html) {
  const m = /ANALYTICS_WEBAPP_URL="(https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec)"/.exec(html);
  return m ? m[1] : null;
}

module.exports = { parseCards, cardImage, rotationOf, dayIndex, cardOfDay, sheetUrl };
