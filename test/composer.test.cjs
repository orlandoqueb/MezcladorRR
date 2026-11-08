// node --test   (no API key needed: Claude's part is replaced by test/demo-spec.json)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSong, saveSong, SCHEMA } = require('../composer.cjs');
const { TYPES, render } = require('../synth.cjs');
const { cleanMix } = require('../server.cjs');

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-spec.json'), 'utf8'));
const level = (l, bpm) => {
  const ss = (a, b, x) => (b <= a ? (x >= a ? 1 : 0) : Math.min(1, Math.max(0, (x - a) / (b - a))));
  return ss(l.in[0], l.in[1], bpm) * (1 - (l.out ? ss(l.out[0], l.out[1], bpm) : 0));
};

test('every instrument type renders clean audio', () => {
  for (const type of Object.keys(TYPES)) {
    for (const brightness of [0, 1]) {
      const { data } = render({ type, brightness }, 45);
      assert.ok(data.length > 0, type);
      assert.ok(data.every(Number.isFinite), `${type} has NaN`);
      assert.ok(data.some((v) => Math.abs(v) > 0.1), `${type} is silent`);
    }
  }
});

test('a spec becomes a song.json the Mezclador can play', () => {
  const { song, sounds } = buildSong(spec);
  assert.equal(song.layers.length, spec.instruments.length);
  for (const l of song.layers) {
    assert.match(l.id, /^[a-z0-9-]+$/);
    assert.ok(l.in[0] <= l.in[1]);
    if (l.out) assert.ok(l.in[1] <= l.out[0] && l.out[0] <= l.out[1]);
    for (const [step, sample] of l.events) {
      assert.ok(step >= 0 && step < l.length);
      assert.ok(sounds[sample], sample);
    }
  }
  // It is also valid for the server's mix check.
  assert.deepEqual(cleanMix({ [song.layers[0].id]: { gain: 0.5 } }, song.layers), { [song.layers[0].id]: { gain: 0.5 } });
});

test('the RadioRun arc holds: calm at 40, full at 215', () => {
  const { song } = buildSong(spec);
  const at = (bpm) => song.layers.filter((l) => level(l, bpm) > 0.5);
  assert.ok(at(40).length >= 2);
  assert.ok(at(40).every((l) => l.group === 'spa'));
  assert.ok(at(215).length > at(120).length);
  assert.ok(at(215).some((l) => l.group === 'pico'));
});

test('broken or out-of-range specs are repaired', () => {
  const messy = {
    title: 'x',
    instruments: [
      { id: 'Pad Grande!!', group: 'pico', sound: { type: 'nope' }, gain: 9, poly: 40, in_from: 10, in_full: 5, out_from: 1, out_to: 0, length: 999, events: [{ step: 3, note: 200, vel: 4 }, { step: -1 }] },
      { id: 'pad grande', group: 'spa', sound: { type: 'pad' }, gain: 0.2, in_from: 70, in_full: 80, keeps_playing: false, out_from: 90, out_to: 100, length: 16, events: [{ step: 0, note: 57, vel: 1 }] },
      { id: 'kick', group: 'ritmo', sound: { type: 'kick' }, gain: 0.5, in_from: 100, in_full: 120, keeps_playing: false, out_from: 150, out_to: 160, length: 16, events: [{ step: 0, note: 60, vel: 1 }] },
      { id: 'empty', group: 'ritmo', sound: { type: 'hat' }, events: [] },
    ],
  };
  const { song } = buildSong(messy);
  assert.equal(song.layers.length, 3);
  const ids = song.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(song.layers.some((l) => l.in[0] === 40), 'something plays at 40');
  assert.ok(song.layers.some((l) => l.out === null), 'something lasts to 220');
  const wild = song.layers.find((l) => l.group === 'pico');
  assert.ok(wild.gain <= 0.8 && wild.poly <= 6 && wild.length === 256 && wild.in[0] >= 125);
  assert.throws(() => buildSong({ instruments: [] }));
});

test('saveSong writes song.json and the kit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezclador-'));
  const built = buildSong(spec);
  const name = saveSong(dir, built);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, name, 'song.json'), 'utf8'));
  assert.equal(saved.meta.title, 'Marimba al atardecer');
  for (const sample of Object.keys(built.sounds)) assert.ok(fs.existsSync(path.join(dir, name, 'kit', sample + '.wav')), sample);
  fs.rmSync(dir, { recursive: true });
});

test('the schema lists every instrument type', () => {
  const types = SCHEMA.properties.instruments.items.properties.sound.properties.type.enum;
  assert.deepEqual(types, Object.keys(TYPES));
});
