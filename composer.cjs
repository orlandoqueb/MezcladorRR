// Turns a song link into a new adaptive composition for RadioRun.
//
// 1. readLink(url): the song's title and artist from the link (oEmbed or the
//    page's <meta> tags). The audio itself is never downloaded.
// 2. compose(...): Claude designs a new composition inspired by that song, in
//    the same shape as song.json, keeping RadioRun's arc (spa → rhythm → peak).
// 3. buildSong(spec): checks and repairs what Claude wrote, so the result always
//    plays in the Mezclador, and synthesizes every sound it needs.
// 4. saveSong(...): writes songs/<slug>/song.json and songs/<slug>/kit/*.wav.
'use strict';

const fs = require('fs');
const path = require('path');
const { TYPES, CHORDS, render, toWav } = require('./synth.cjs');

const MODEL = 'claude-opus-5-5';
const MIN_BPM = 40;
const MAX_BPM = 220;
const LENGTHS = [16, 32, 64, 128, 256];
const GROUPS = ['spa', 'ritmo', 'pico'];
const MAX_LAYERS = 22;
const MAX_EVENTS = 256;

// ---------------------------------------------------------------- 1. The link

/** Reads what a song link says about the song: title, artist, service. */
async function readLink(link) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw new Error('Eso no parece un enlace. Pega la dirección completa, por ejemplo https://www.youtube.com/watch?v=…');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('El enlace tiene que empezar por http:// o https://');
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  const info = { url: url.href, service: host, title: '', artist: '' };
  const oembed = {
    'youtube.com': 'https://www.youtube.com/oembed?format=json&url=',
    'youtu.be': 'https://www.youtube.com/oembed?format=json&url=',
    'open.spotify.com': 'https://open.spotify.com/oembed?url=',
    'soundcloud.com': 'https://soundcloud.com/oembed?format=json&url=',
    'vimeo.com': 'https://vimeo.com/api/oembed.json?url=',
  }[host];
  try {
    if (oembed) {
      const res = await fetch(oembed + encodeURIComponent(url.href), { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        info.title = String(data.title || '').slice(0, 200);
        info.artist = String(data.author_name || '').slice(0, 120);
      }
    } else {
      const res = await fetch(url.href, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mezclador/1.0' } });
      if (res.ok) {
        const html = (await res.text()).slice(0, 300_000);
        const meta = (name) => {
          const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))
            || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'));
          return m ? m[1] : '';
        };
        info.title = (meta('og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim().slice(0, 200);
        info.artist = (meta('music:musician_description') || meta('og:site_name') || '').slice(0, 120);
        info.description = meta('og:description').slice(0, 400);
      }
    }
  } catch {
    // No network or the service said no: Claude still gets the link itself.
  }
  return info;
}

// ------------------------------------------------------------- 2. Claude

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'inspiration', 'key', 'instruments'],
  properties: {
    title: { type: 'string', description: 'Short original title for the new composition (Spanish or English).' },
    inspiration: { type: 'string', description: 'Two or three sentences in Spanish: what was taken from the song (style, instruments, groove, mood) and how it grows with the BPM.' },
    key: { type: 'string', description: 'Key and mode, e.g. "La menor".' },
    instruments: {
      type: 'array',
      description: 'Between 12 and 20 layers, ordered from the first that enters (spa) to the last (peak).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'group', 'sound', 'gain', 'poly', 'in_from', 'in_full', 'keeps_playing', 'out_from', 'out_to', 'length', 'events'],
        properties: {
          id: { type: 'string', description: 'lowercase a-z and dashes, unique, e.g. "marimba" or "bass-roll"' },
          name: { type: 'string', description: 'Name shown in the Mezclador, in Spanish, e.g. "Marimba suave".' },
          group: { type: 'string', enum: GROUPS },
          sound: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'brightness', 'attack', 'decay', 'chord', 'detune'],
            properties: {
              type: { type: 'string', enum: Object.keys(TYPES) },
              brightness: { type: 'number', description: '0 dark/soft … 1 bright/harsh' },
              attack: { type: 'number', description: 'seconds' },
              decay: { type: 'number', description: 'seconds the sample lasts' },
              chord: { type: 'string', enum: Object.keys(CHORDS), description: 'Only used by pad, strings and stab; "single" otherwise.' },
              detune: { type: 'number', description: '0 … 1, width of the sound' },
            },
          },
          gain: { type: 'number', description: 'Layer volume, 0.05 … 0.6. Kick around 0.55, pads around 0.25, hats around 0.15.' },
          poly: { type: 'integer', description: 'Voices that can ring at once (1 … 6).' },
          in_from: { type: 'integer', description: 'BPM where it starts to fade in (40 … 220). 40 means it is there from the start.' },
          in_full: { type: 'integer', description: 'BPM where it is at full volume (>= in_from).' },
          keeps_playing: { type: 'boolean', description: 'true: never leaves once in (out_from/out_to are ignored).' },
          out_from: { type: 'integer', description: 'BPM where it starts to fade out (>= in_full).' },
          out_to: { type: 'integer', description: 'BPM where it is silent (>= out_from).' },
          length: { type: 'integer', enum: LENGTHS, description: 'Pattern length in 16th-note steps (16 = one bar).' },
          events: {
            type: 'array',
            description: 'Notes of the loop. step: 0 … length-1 (16th notes). note: MIDI note (60 = middle C); drums use 60. vel: 0.1 … 1.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['step', 'note', 'vel'],
              properties: { step: { type: 'integer' }, note: { type: 'integer' }, vel: { type: 'number' } },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You compose adaptive music for RadioRun, a running app. The music follows the runner's pace: it is one loop-based song whose layers fade in and out with the BPM (40 to 220).

Every composition must keep RadioRun's arc:
- SPA (40–100 BPM, group "spa"): calm, spa-like, meditative. Pads, soft textures (waves, rain), gentle melodic instruments, maybe a soft heartbeat. No drums except very soft ones. Most of these are in from 40 BPM and fade out somewhere between 90 and 190 BPM.
- RITMO (roughly 70–160 BPM, group "ritmo"): the groove arrives step by step: shaker, bass, then the kick (which then keeps playing to the end), hats, claps, a rolling bass line.
- PICO (roughly 140–220 BPM, group "pico"): complex and intense: more percussion, ride, acid or lead lines, stabs, fills, a second driving kick or crash accents. These keep playing to 220.
Layers enter one or two at a time, spread across the whole range, so every 10–15 BPM something changes. Something must be audible at 40 BPM and the mix must be at its fullest at 200–220.

How the engine works:
- A step is a 16th note; 16 steps = one 4/4 bar. Each layer repeats its own pattern of "length" steps.
- Each event plays one sample at its step: pitched instruments are rendered per MIDI note, so keep each melodic layer to at most 8 different notes. Drums use note 60 (tom and conga use the note for pitch).
- pad, strings and stab render a whole chord from one note ("chord" field). Pads usually play one long note every 32 steps; give them decay 8–13 s and poly 2.
- When more than "poly" voices ring, the oldest fades out. Bass and acid lines: poly 1.
- Volumes are mixed by the layer "gain"; keep the total balanced (see the reference).

The reference below is RadioRun's current song (groups: SPA pad, air, flute, heartbeat, shaker, sub; RITMO kick, hat, clap, roll, hats16; PICO openhat, perc, ride, acid, stab, fill, drive). Match its structure and density, not its notes.

Write an ORIGINAL composition inspired by the song the user shares: take its genre, mood, instrumentation, harmonic colour, tempo feel and groove, but never copy its melody, lyrics or recognisable riffs. Use instruments that evoke it (for example marimba and congas for a tropical song, strings and bells for a cinematic one, plucks and synth bass for indie electronic), always inside the arc above. If you do not recognise the song, infer what you can from the title, artist and the user's note, and say so in "inspiration".`;

function referenceSong(songFile) {
  try {
    const { layers } = JSON.parse(fs.readFileSync(songFile, 'utf8'));
    return JSON.stringify(layers.map(({ id, gain, poly, in: i, out, length, events }) => ({ id, gain, poly, in: i, out, length, events: events.slice(0, 24) })));
  } catch {
    return '[]';
  }
}

/**
 * Asks Claude for a composition. Needs ANTHROPIC_API_KEY (or another credential
 * the Anthropic SDK can find). Returns the raw spec (checked later by buildSong).
 */
async function compose({ info, note, songFile }) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new Error('Falta instalar la librería de Claude. En la carpeta del Mezclador ejecuta: npm install');
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('Falta tu clave de Claude. Cierra el Mezclador y ábrelo con: ANTHROPIC_API_KEY=tu-clave node server.cjs');
  }
  const client = new Anthropic.default();
  const about = [
    `Link: ${info.url}`,
    info.title && `Title: ${info.title}`,
    info.artist && `Artist / channel: ${info.artist}`,
    info.description && `Description: ${info.description}`,
    note && `What the user likes about it: ${note}`,
  ].filter(Boolean).join('\n');

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: 'Reference song (song.json layers, events truncated to 24):\n' + referenceSong(songFile), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `Compose a new adaptive composition inspired by this song.\n\n${about}` }],
  });
  let message;
  try {
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      const key = process.env.ANTHROPIC_API_KEY || '';
      const hints = [];
      if (key && !key.startsWith('sk-ant-api')) hints.push('la clave debería empezar por sk-ant-api…');
      if (/^["'\s]|["'\s]$/.test(key)) hints.push('tiene comillas o espacios de más');
      if (process.env.ANTHROPIC_BASE_URL) hints.push(`ANTHROPIC_BASE_URL está puesto (${process.env.ANTHROPIC_BASE_URL}); quítalo con: unset ANTHROPIC_BASE_URL`);
      if (process.env.ANTHROPIC_AUTH_TOKEN && !key) hints.push('se está usando ANTHROPIC_AUTH_TOKEN en lugar de una clave');
      throw new Error(`Claude no aceptó la clave (ANTHROPIC_API_KEY): ${e.message}.${hints.length ? ' Revisa: ' + hints.join('; ') + '.' : ' Revisa que esté bien copiada y activa en platform.claude.com.'}`);
    }
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude está recibiendo demasiadas peticiones. Espera un minuto y vuelve a intentarlo.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude respondió con un error (${e.status}): ${e.message}`);
    throw new Error('No se pudo hablar con Claude: ' + (e.message || e));
  }
  if (message.stop_reason === 'refusal') throw new Error('Claude no quiso componer a partir de ese enlace. Prueba con otra canción.');
  if (message.stop_reason === 'max_tokens') throw new Error('La composición salió demasiado larga y se cortó. Vuelve a intentarlo.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Claude devolvió una composición que no se pudo leer. Vuelve a intentarlo.');
  }
}

// ---------------------------------------------------- 3. Check and repair

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, fb) => (typeof x === 'number' && Number.isFinite(x) ? x : fb);
const int = (x, fb, a, b) => clamp(Math.round(num(x, fb)), a, b);
const SUSTAINED = new Set(['pad', 'strings', 'waves', 'rain']);
const SOFT_CUT = new Set(['flute', 'bell', 'keys', 'pluck', 'marimba', 'riser', 'crash', 'ride']);

/** Where each group may start fading in. */
const GROUP_IN = { spa: [40, 100], ritmo: [60, 175], pico: [125, 210] };

function cleanId(raw, used) {
  let id = String(raw || 'capa').toLowerCase().normalize('NFD').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'capa';
  const base = id;
  for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
  used.add(id);
  return id;
}

/**
 * Builds a song.json-shaped object from Claude's spec. Anything out of range is
 * clamped; the RadioRun arc is enforced (something at 40 BPM, groups in order,
 * a layer that keeps playing to 220).
 * Returns { song: {meta, layers}, sounds: {sampleId: sound+note} }.
 */
function buildSong(spec, meta = {}) {
  if (!spec || !Array.isArray(spec.instruments)) throw new Error('La composición no trae instrumentos.');
  const used = new Set();
  const sounds = {};
  const layers = [];
  for (const raw of spec.instruments.slice(0, MAX_LAYERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw.sound || {};
    const type = TYPES[s.type] ? s.type : 'pluck';
    const T = TYPES[type];
    const sound = {
      type,
      brightness: clamp(num(s.brightness, 0.5), 0, 1),
      attack: clamp(num(s.attack, T.attack ?? 0.002), 0, 3),
      decay: clamp(num(s.decay, T.decay), 0.04, 13),
      chord: CHORDS[s.chord] ? s.chord : 'single',
      detune: clamp(num(s.detune, 0.3), 0, 1),
    };
    const id = cleanId(raw.id || type, used);
    const group = GROUPS.includes(raw.group) ? raw.group : 'ritmo';
    const length = LENGTHS.reduce((best, l) => (Math.abs(l - num(raw.length, 16)) < Math.abs(best - num(raw.length, 16)) ? l : best), 16);

    // Range: in, then out (or none), always in order.
    const [lo, hi] = GROUP_IN[group];
    const in0 = int(raw.in_from, lo, Math.max(MIN_BPM, lo), hi);
    const in1 = int(raw.in_full, in0, in0, Math.min(MAX_BPM, in0 + 40));
    let out = null;
    if (!raw.keeps_playing && group !== 'pico') {
      const o0 = int(raw.out_from, MAX_BPM, in1, MAX_BPM);
      const o1 = int(raw.out_to, o0, o0, MAX_BPM);
      if (o0 < MAX_BPM) out = [o0, o1];
    }

    // Events: on the grid, a limited set of notes per instrument.
    const notes = new Set();
    const events = [];
    for (const e of (Array.isArray(raw.events) ? raw.events : []).slice(0, MAX_EVENTS)) {
      if (!e || typeof e !== 'object') continue;
      const step = Math.round(num(e.step, -1));
      if (step < 0 || step >= length) continue;
      let note = T.pitched ? int(e.note, 60, 24, 96) : 60;
      if (T.pitched && !notes.has(note) && notes.size >= 12) {
        // Too many different pitches: snap to the nearest one already used.
        note = [...notes].reduce((b, n) => (Math.abs(n - note) < Math.abs(b - note) ? n : b));
      }
      notes.add(note);
      const sample = T.pitched ? `${id}-${note}` : id;
      sounds[sample] = { ...sound, note };
      events.push([step, sample, Math.round(clamp(num(e.vel, 0.8), 0.05, 1) * 100) / 100]);
    }
    if (!events.length) continue;
    events.sort((a, b) => a[0] - b[0]);

    layers.push({
      id,
      name: String(raw.name || id).slice(0, 32),
      group,
      gain: Math.round(clamp(num(raw.gain, 0.25), 0.03, 0.8) * 1000) / 1000,
      poly: int(raw.poly, 2, 1, 6),
      cut: SUSTAINED.has(type) ? 2 : SOFT_CUT.has(type) ? 0.5 : ['bass', 'tom', 'conga'].includes(type) ? 0.2 : 0.015,
      in: [in0, in1],
      out,
      floor: 0,
      length,
      events,
    });
  }
  if (layers.length < 3) throw new Error('La composición trae muy pocos instrumentos que se puedan tocar. Vuelve a intentarlo.');

  // The arc: groups in order, something at 40 BPM, something that lasts to 220.
  const order = { spa: 0, ritmo: 1, pico: 2 };
  layers.sort((a, b) => order[a.group] - order[b.group] || a.in[0] - b.in[0]);
  const spa = layers.filter((l) => l.group === 'spa');
  if (!layers.some((l) => l.in[0] === MIN_BPM)) {
    const first = spa[0] || layers[0];
    first.in = [MIN_BPM, MIN_BPM];
    if (first.out && first.out[0] < 90) first.out = [90, Math.max(110, first.out[1])];
  }
  if (!layers.some((l) => l.out === null)) {
    const last = [...layers].reverse().find((l) => l.group !== 'spa') || layers[layers.length - 1];
    last.out = null;
  }

  return {
    song: {
      meta: {
        title: String(spec.title || meta.title || 'Composición').slice(0, 80),
        inspiration: String(spec.inspiration || '').slice(0, 600),
        key: String(spec.key || '').slice(0, 40),
        ...meta,
      },
      layers,
    },
    sounds,
  };
}

// ---------------------------------------------------------------- 4. Save

function slugify(title) {
  const s = String(title).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cancion';
  return `${s}-${Date.now().toString(36).slice(-5)}`;
}

/**
 * Synthesizes one sample of a generated song into its kit/ folder, from the
 * recipe kept in song.json ("sounds"). Returns the file, or null if unknown.
 * The WAVs can always be made again, so only song.json needs to be shared.
 */
function renderSample(songDir, sounds, sample) {
  const s = sounds && Object.prototype.hasOwnProperty.call(sounds, sample) ? sounds[sample] : null;
  if (!s || !/^[a-z0-9-]+$/.test(sample)) return null;
  const kit = path.join(songDir, 'kit');
  fs.mkdirSync(kit, { recursive: true });
  const file = path.join(kit, sample + '.wav');
  fs.writeFileSync(file, toWav(render(s, s.note)));
  return file;
}

/** Writes songs/<slug>/song.json and synthesizes songs/<slug>/kit/*.wav. Returns the slug. */
function saveSong(songsDir, { song, sounds }) {
  const slug = slugify(song.meta.title);
  const dir = path.join(songsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'song.json'), JSON.stringify({ ...song, sounds }) + '\n');
  for (const sample of Object.keys(sounds)) renderSample(dir, sounds, sample);
  return slug;
}

module.exports = { readLink, compose, buildSong, saveSong, renderSample, SCHEMA, MODEL };
