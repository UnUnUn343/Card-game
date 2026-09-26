#!/usr/bin/env node
'use strict';
/**
 * Android launcher icons from build/icon.svg → android/app/src/main/res/mipmap-* (committed; rerun
 * after changing the icon):  node scripts/make-android-icons.js
 *   ic_launcher.png                 the whole rounded icon (Android 7)
 *   ic_launcher_background.png      adaptive icon, back layer: the plate, edge to edge (Android 8+)
 *   ic_launcher_foreground.png      adaptive icon, front layer: ring + swords inside the safe zone
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const svg = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');

const PLATE = /<rect x="16" y="16" width="480" height="480" rx="112" fill="url\(#bg\)"\/>/;
const PLATE_EDGE = /<rect x="16" y="16" width="480" height="480" rx="112" fill="none"[^>]*\/>/;
const EMBLEM_START = /(<circle cx="256" cy="256" r="200")/;
if (!PLATE.test(svg) || !PLATE_EDGE.test(svg) || !EMBLEM_START.test(svg)) throw new Error('build/icon.svg changed shape; update make-android-icons.js');

// Back layer: just the gradient, full square (the launcher crops it to its own shape).
const background = svg.replace(PLATE, '<rect width="512" height="512" fill="url(#bg)"/>').replace(PLATE_EDGE, '')
  .replace(/<circle cx="256" cy="256" r="200"[\s\S]*<\/svg>\s*$/, '</svg>');
// Front layer: emblem only, scaled so the ring (r≈182 of 256) sits inside the 66/108 safe circle.
const foreground = svg.replace(PLATE, '').replace(PLATE_EDGE, '')
  .replace(EMBLEM_START, '<g transform="translate(256 256) scale(0.81) translate(-256 -256)">$1')
  .replace(/<\/svg>\s*$/, '</g></svg>');

const png = (s, size) => new Resvg(s, { fitTo: { mode: 'width', value: size } }).render().asPng();
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, k] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png(svg, Math.round(48 * k)));
  fs.writeFileSync(path.join(dir, 'ic_launcher_background.png'), png(background, Math.round(108 * k)));
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), png(foreground, Math.round(108 * k)));
}
console.log('Android icons →', path.relative(ROOT, RES));
