'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCards, cardImage, rotationOf, dayIndex, cardOfDay, sheetUrl } = require('../src/main/gameData');

// A tiny build in the game's own format.
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const FAKE = [
  '<!--\n  v206 — 2.0.6: test\n-->',
  '<script>',
  'const ANALYTICS_WEBAPP_URL="https://script.google.com/macros/s/AKfy_test-123/exec";',
  'const _imgs={',
  `"rf9":"${IMG}",`,
  `"gb1":"${IMG}",`,
  `"g2":"${IMG}"`,
  '};',
  'const LOCKED_ROTATION_PREFIXES=[\'gb\'];',
  'const DB={',
  'rf9:{id:"rf9",name:"Charizard",hp:80,type:"fire",wk:{t:"electric",v:20},rs:{t:"grass",v:30},rt:2,',
  '  ab:{n:"Блейз",d:"x1.5 вогняні при HP<50%."},',
  '  atks:[{n:"Сталевий Кіготь",dmg:50,cost:["steel"],d:"50."},{n:"Вогняний Спін",dmg:30,cost:["fire"],d:"30+пастка."}]},',
  'gb1:{id:"gb1",name:"Old",hp:60,type:"normal",',
  '  atks:[{n:"Удар",dmg:20,cost:["normal"],d:"20."}]},',
  'g2:{id:"g2",name:"Zoroark",hp:60,type:"dark",wk:{t:"fighting",v:10},rt:1,',
  '  atks:[{n:"Обман",dmg:40,cost:["dark"],d:"40."}]},',
  'g3:{id:"g3",name:"NoPicture",hp:60,type:"dark",',
  '  atks:[{n:"Обман",dmg:40,cost:["dark"],d:"40."}]},',
  'rf20:{id:"rf20",name:"Mega X",hp:200,type:"fire",isMega:true,',
  '  atks:[{n:"Мега",dmg:200,cost:["fire"],d:"200."}]},',
  '};',
  "const ROTATION_LETTERS=[['B','gb'],['C','g'],['D','rd'],['E','rc'],['F','rf']];",
  '</script>',
].join('\n');

test('cards are read from the game\'s DB lines (Megas left out)', () => {
  const cards = parseCards(FAKE);
  assert.deepStrictEqual(cards.map(c => c.id), ['rf9', 'gb1', 'g2', 'g3']);
  const c = cards[0];
  assert.strictEqual(c.name, 'Charizard');
  assert.strictEqual(c.hp, 80);
  assert.strictEqual(c.type, 'fire');
  assert.strictEqual(c.weak, 'electric');
  assert.strictEqual(c.resist, 'grass');
  assert.strictEqual(c.ability, 'Блейз');
  assert.deepStrictEqual(c.attacks, [{ name: 'Сталевий Кіготь', dmg: 50 }, { name: 'Вогняний Спін', dmg: 30 }]);
});

test('pictures, rotations and the Sheet address', () => {
  assert.strictEqual(cardImage(FAKE, 'rf9'), IMG);
  assert.strictEqual(cardImage(FAKE, 'g3'), null);
  const rots = [['B', 'gb'], ['C', 'g'], ['F', 'rf']];
  assert.strictEqual(rotationOf('gb1', rots).letter, 'B');
  assert.strictEqual(rotationOf('g12', rots).letter, 'C');
  assert.strictEqual(rotationOf('rf9', rots).letter, 'F');
  assert.strictEqual(rotationOf('m3', rots), null);
  assert.strictEqual(sheetUrl(FAKE), 'https://script.google.com/macros/s/AKfy_test-123/exec');
  assert.strictEqual(sheetUrl('<html></html>'), null);
});

test('the card of the day: a played rotation, with a picture, the same all day', () => {
  const seen = new Set();
  for (let d = 1; d <= 28; d++) {
    const key = `2026-10-${String(d).padStart(2, '0')}`;
    const c = cardOfDay(FAKE, key);
    assert.ok(['rf9', 'g2'].includes(c.id), 'never a locked rotation, a Mega or a card without a picture');
    assert.strictEqual(cardOfDay(FAKE, key).id, c.id, 'same day, same card');
    assert.strictEqual(c.image, IMG);
    seen.add(c.id);
  }
  assert.strictEqual(seen.size, 2, 'it changes from day to day');
  assert.strictEqual(cardOfDay('<html></html>', '2026-10-10'), null);
  assert.ok(dayIndex('2026-10-10', 7) >= 0 && dayIndex('2026-10-10', 7) < 7);
});

test('the bundled game, if it is here', { skip: !fs.existsSync(path.join(__dirname, '..', 'game', 'game.html')) }, () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'game', 'game.html'), 'utf8');
  const c = cardOfDay(html, '2026-10-10');
  assert.ok(c && c.name && c.attacks.length && /^data:image\//.test(c.image));
  assert.ok(sheetUrl(html));
});
