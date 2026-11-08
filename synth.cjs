// Instrument synthesizer for generated compositions.
// Every sound is made by code (no recordings), like RadioRun's own kit.
// render(sound, note) → Float32Array; toWav(samples, rate) → Buffer (16-bit mono).
'use strict';

const RATE = 22050; // like most of kit/; bright cymbals use HI_RATE
const HI_RATE = 44100;

/** Instrument types the composer may use. `pitched` types get one sample per MIDI note. */
const TYPES = {
  // Melodic
  pad: { pitched: true, about: 'slow, warm chord pad (renders a chord on the note)', attack: 1.6, decay: 9 },
  strings: { pitched: true, about: 'bowed string ensemble, slow swell (chord on the note)', attack: 0.9, decay: 6 },
  keys: { pitched: true, about: 'soft electric piano', attack: 0.004, decay: 2.2 },
  bell: { pitched: true, about: 'glassy bell / celesta', attack: 0.002, decay: 3 },
  pluck: { pitched: true, about: 'plucked string, harp or guitar-like', attack: 0.001, decay: 1.6 },
  marimba: { pitched: true, about: 'wooden mallet (marimba, kalimba)', attack: 0.001, decay: 1.0 },
  flute: { pitched: true, about: 'breathy flute / pan flute', attack: 0.08, decay: 1.8 },
  lead: { pitched: true, about: 'synth lead (square/saw)', attack: 0.01, decay: 0.6 },
  bass: { pitched: true, about: 'round sub bass', attack: 0.01, decay: 1.6 },
  synthbass: { pitched: true, about: 'short punchy synth bass for rolling lines', attack: 0.002, decay: 0.25 },
  acid: { pitched: true, about: 'squelchy resonant acid line', attack: 0.002, decay: 0.2 },
  stab: { pitched: true, about: 'short chord stab (chord on the note)', attack: 0.003, decay: 0.5 },
  // Drums and textures (pitch is ignored unless noted)
  kick: { pitched: false, about: 'four-on-the-floor kick drum', decay: 0.42 },
  snare: { pitched: false, about: 'snare drum', decay: 0.25 },
  clap: { pitched: false, about: 'hand clap', decay: 0.3 },
  rim: { pitched: false, about: 'rim shot / woodblock click', decay: 0.08 },
  hat: { pitched: false, about: 'closed hi-hat', decay: 0.07 },
  openhat: { pitched: false, about: 'open hi-hat', decay: 0.35 },
  shaker: { pitched: false, about: 'shaker', decay: 0.12 },
  ride: { pitched: false, about: 'ride cymbal', decay: 0.9 },
  crash: { pitched: false, about: 'crash cymbal for accents', decay: 2.0 },
  tom: { pitched: true, about: 'tom drum (uses the note for pitch)', decay: 0.4 },
  conga: { pitched: true, about: 'hand percussion / conga (uses the note)', decay: 0.22 },
  heartbeat: { pitched: false, about: 'soft low double heartbeat thump', decay: 0.45 },
  waves: { pitched: false, about: 'ocean / wind noise swell (ambient texture)', attack: 2, decay: 6.5 },
  rain: { pitched: false, about: 'soft rain / vinyl crackle texture', decay: 4 },
  riser: { pitched: false, about: 'noise sweep that builds up', attack: 1.5, decay: 1.8 },
};

const CHORDS = {
  single: [0], fifth: [0, 7], maj: [0, 4, 7], min: [0, 3, 7], sus2: [0, 2, 7], sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], add9: [0, 4, 7, 14], min9: [0, 3, 7, 14],
};
const CHORDED = new Set(['pad', 'strings', 'stab']);

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Small seeded random, so the same composition always renders the same sounds. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function hash(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Attack / exponential decay envelope; tail fades to silence at the end. */
function env(i, n, rate, attack, decay) {
  const t = i / rate;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  const d = Math.exp(-Math.max(0, t - attack) / Math.max(0.001, decay / 4.6));
  const tail = Math.min(1, (n - i) / (rate * 0.02));
  return a * a * (3 - 2 * a) * d * tail;
}
/** Envelope for sustained sounds: attack, hold, then release over the last third. */
function swell(i, n, rate, attack) {
  const t = i / rate;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  const rel = n * 0.35;
  const r = i > n - rel ? (n - i) / rel : 1;
  return a * a * (3 - 2 * a) * r * r;
}

/** State-variable low-pass filter (cutoff can change every sample). */
function svf() {
  let low = 0, band = 0;
  return (x, cutoff, rate, q = 0.7) => {
    const damp = 1 / Math.max(0.5, q);
    // Chamberlin SVF is stable while f² + 2·f·damp < 4; keep a margin.
    const f = Math.min(2 * Math.sin(Math.PI * Math.min(cutoff, rate * 0.24) / rate), Math.sqrt(damp * damp + 3.8) - damp);
    low += f * band;
    const high = x - low - damp * band;
    band += f * high;
    return { low, band, high };
  };
}
const onepoleHP = () => { let px = 0, py = 0; return (x, a = 0.98) => { py = a * (py + x - px); px = x; return py; }; };

function normalize(out, peak = 0.85) {
  let m = 0;
  for (const v of out) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < out.length; i++) out[i] *= peak / m;
  return out;
}

/** Band-limited-ish saw by summing harmonics (keeps it soft at low sample rates). */
function saw(phase, f, rate, maxH = 24) {
  const n = Math.max(1, Math.min(maxH, Math.floor(rate / 2 / f)));
  let s = 0;
  for (let k = 1; k <= n; k++) s += Math.sin(phase * k) / k;
  return s * 0.6;
}

/**
 * Renders one sample.
 * sound: { type, brightness 0..1, attack s, decay s, chord, detune 0..1 }
 */
function render(sound, note = 60) {
  const type = TYPES[sound.type] ? sound.type : 'pluck';
  const T = TYPES[type];
  const rate = ['hat', 'openhat', 'shaker', 'ride', 'crash'].includes(type) ? HI_RATE : RATE;
  const bright = clamp(sound.brightness ?? 0.5, 0, 1);
  const attack = clamp(sound.attack ?? T.attack ?? 0.002, 0, 4);
  const decay = clamp(sound.decay ?? T.decay, 0.03, 14);
  const detune = clamp(sound.detune ?? 0.3, 0, 1);
  const n = Math.max(64, Math.round(rate * (decay + (CHORDED.has(type) || type === 'waves' ? 0 : attack))));
  const out = new Float32Array(n);
  const rand = rng(hash(type + ':' + note + ':' + bright + ':' + decay));
  const noise = () => rand() * 2 - 1;
  const f0 = hz(note);
  const intervals = CHORDED.has(type) ? CHORDS[sound.chord] || CHORDS[type === 'stab' ? 'min7' : 'maj'] : [0];
  const tau = 2 * Math.PI;

  switch (type) {
    case 'pad':
    case 'strings': {
      const lp = svf();
      const voices = intervals.flatMap((iv) => [-1, 1].map((d) => ({ f: hz(note + iv) * (1 + d * 0.004 * (0.3 + detune)), p: rand() * tau })));
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let s = 0;
        const vib = type === 'strings' ? 1 + 0.003 * Math.sin(tau * 5.2 * t) : 1;
        for (const v of voices) { v.p += (tau * v.f * vib) / rate; s += type === 'pad' ? saw(v.p, v.f, rate, 10) * 0.6 + Math.sin(v.p) * 0.5 : saw(v.p, v.f, rate, 16); }
        const cut = (type === 'pad' ? 500 : 900) + bright * 2600 + 300 * Math.sin(tau * 0.15 * t);
        out[i] = lp(s, cut, rate, 0.6).low * swell(i, n, rate, attack);
      }
      break;
    }
    case 'keys': {
      let p = 0, m = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const idx = (0.6 + bright * 2.2) * Math.exp(-t * 3);
        m += (tau * f0 * 1) / rate; p += (tau * f0) / rate;
        const tine = Math.sin(tau * f0 * 7 * t) * 0.08 * Math.exp(-t * 30) * bright;
        out[i] = (Math.sin(p + idx * Math.sin(m)) + tine) * env(i, n, rate, attack, decay) * (1 + 0.04 * Math.sin(tau * 4 * t));
      }
      break;
    }
    case 'bell': {
      const partials = [[1, 1, 1], [2.76, 0.5, 0.6], [5.4, 0.25 * (0.4 + bright), 0.35], [8.93, 0.12 * bright, 0.2]];
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let s = 0;
        for (const [r, a, d] of partials) s += Math.sin(tau * f0 * r * t) * a * Math.exp(-t / (decay * d / 4.6 + 0.001));
        out[i] = s * Math.min(1, t / Math.max(0.0005, attack));
      }
      break;
    }
    case 'pluck': {
      // Karplus-Strong string
      const len = Math.max(2, Math.round(rate / f0));
      const buf = new Float32Array(len);
      for (let k = 0; k < len; k++) buf[k] = noise();
      let lpPrev = 0;
      const fb = 0.996 - (1 - Math.min(1, decay / 3)) * 0.01;
      const smooth = 0.25 + bright * 0.5;
      for (let i = 0, k = 0; i < n; i++, k = (k + 1) % len) {
        const nx = buf[k];
        const nk = buf[(k + 1) % len];
        const v = (smooth * nx + (1 - smooth) * nk) * fb;
        lpPrev = v;
        buf[k] = v;
        out[i] = lpPrev * env(i, n, rate, attack, decay * 1.5);
      }
      break;
    }
    case 'marimba': {
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const s = Math.sin(tau * f0 * t) + 0.35 * bright * Math.sin(tau * f0 * 3.93 * t) * Math.exp(-t * 18) + 0.15 * Math.sin(tau * f0 * 9.2 * t) * Math.exp(-t * 60);
        out[i] = s * env(i, n, rate, attack, decay);
      }
      break;
    }
    case 'flute': {
      const lp = svf();
      let p = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const vib = 1 + 0.006 * Math.sin(tau * 5 * t) * Math.min(1, t / 0.4);
        p += (tau * f0 * vib) / rate;
        const breath = lp(noise(), f0 * 2.5, rate, 2).band * (0.15 + 0.35 * bright);
        const tone = Math.sin(p) + 0.12 * Math.sin(2 * p) + 0.05 * bright * Math.sin(3 * p);
        out[i] = (tone + breath) * env(i, n, rate, attack, decay);
      }
      break;
    }
    case 'lead': {
      const lp = svf();
      let p1 = 0, p2 = rand() * tau;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        p1 += (tau * f0) / rate; p2 += (tau * f0 * (1 + 0.006 * (0.2 + detune))) / rate;
        const sq = Math.sign(Math.sin(p1)) * 0.5 + saw(p2, f0, rate, 20) * 0.6;
        out[i] = lp(sq, 700 + bright * 4000 * Math.exp(-t * 4) + 400, rate, 1.2).low * env(i, n, rate, attack, decay);
      }
      break;
    }
    case 'bass': {
      let p = 0;
      for (let i = 0; i < n; i++) {
        p += (tau * f0) / rate;
        out[i] = (Math.sin(p) + 0.18 * bright * Math.sin(2 * p) + 0.06 * bright * Math.sin(3 * p)) * env(i, n, rate, attack, decay);
      }
      break;
    }
    case 'synthbass':
    case 'acid': {
      const lp = svf();
      let p = 0;
      const q = type === 'acid' ? 4 + bright * 6 : 1.1;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        p += (tau * f0) / rate;
        const src = type === 'acid' ? saw(p, f0, rate, 30) : saw(p, f0, rate, 12) * 0.7 + Math.sin(p) * 0.6;
        const cut = f0 * 1.5 + (type === 'acid' ? 2600 : 900) * (0.3 + bright) * Math.exp(-t * (type === 'acid' ? 18 : 22));
        out[i] = Math.tanh(lp(src, cut, rate, q).low * 1.6) * env(i, n, rate, attack, decay);
      }
      break;
    }
    case 'stab': {
      const lp = svf();
      const vs = intervals.flatMap((iv) => [-1, 1].map((d) => ({ f: hz(note + iv) * (1 + d * 0.005 * (0.3 + detune)), p: rand() * tau })));
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let s = 0;
        for (const v of vs) { v.p += (tau * v.f) / rate; s += saw(v.p, v.f, rate, 14); }
        out[i] = lp(s, 600 + (1500 + bright * 3500) * Math.exp(-t * 9), rate, 1.4).low * env(i, n, rate, attack, decay);
      }
      break;
    }
    case 'kick': {
      let p = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const f = 48 + 110 * Math.exp(-t * 32);
        p += (tau * f) / rate;
        const click = noise() * Math.exp(-t * 400) * 0.3 * bright;
        out[i] = Math.tanh((Math.sin(p) + click) * 1.4) * env(i, n, rate, 0, decay);
      }
      break;
    }
    case 'snare':
    case 'clap':
    case 'rim': {
      const bp = svf();
      let p = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let s;
        if (type === 'snare') { p += (tau * (190 - 30 * t)) / rate; s = Math.sin(p) * Math.exp(-t * 30) * 0.6 + bp(noise(), 1800 + bright * 2500, rate, 0.8).high * Math.exp(-t / (decay / 4.6)); }
        else if (type === 'clap') { const burst = t < 0.03 ? (Math.floor(t / 0.0085) % 2 === 0 ? 1 : 0.35) : 0.8 * Math.exp(-(t - 0.03) / (decay / 4.6)); s = bp(noise(), 1200 + bright * 1000, rate, 1.4).band * burst; }
        else { p += (tau * (1700 + bright * 900)) / rate; s = (Math.sin(p) * 0.8 + bp(noise(), 3000, rate, 2).band * 0.5) * Math.exp(-t * 70); }
        out[i] = s * Math.min(1, (n - i) / (rate * 0.01));
      }
      break;
    }
    case 'hat':
    case 'openhat':
    case 'shaker':
    case 'ride':
    case 'crash': {
      const hp = onepoleHP();
      const bp = svf();
      const metal = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => ({ f: f * (type === 'ride' ? 1.9 : 4.1), p: rand() * tau }));
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let m = 0;
        if (type !== 'shaker') for (const v of metal) { v.p += (tau * v.f) / rate; m += Math.sign(Math.sin(v.p)); }
        const src = type === 'shaker' ? bp(noise(), 5500 + bright * 3000, rate, 1).band * 2 : m * 0.12 + noise() * (type === 'ride' ? 0.25 : 0.6);
        const shape = type === 'shaker' ? Math.sin(Math.PI * Math.min(1, t / decay)) ** 1.5 : env(i, n, rate, type === 'crash' ? 0.003 : 0, decay);
        const ping = type === 'ride' ? Math.sin(tau * 3300 * t) * 0.25 * Math.exp(-t * 6) : 0;
        out[i] = (hp(src, 0.9 - 0.15 * (1 - bright)) + ping) * shape;
      }
      break;
    }
    case 'tom':
    case 'conga': {
      let p = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const f = f0 * (1 + (type === 'tom' ? 0.5 : 0.25) * Math.exp(-t * 25));
        p += (tau * f) / rate;
        const slap = noise() * Math.exp(-t * 300) * 0.25 * bright;
        out[i] = (Math.sin(p) + 0.2 * Math.sin(2.3 * p) * Math.exp(-t * 30) + slap) * env(i, n, rate, 0, decay);
      }
      break;
    }
    case 'heartbeat': {
      let p = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const hit = (t0, a) => (t >= t0 ? a * Math.exp(-(t - t0) * 18) : 0);
        p += (tau * (55 + 25 * Math.exp(-t * 20))) / rate;
        out[i] = Math.sin(p) * (hit(0, 1) + hit(0.17, 0.7)) * Math.min(1, (n - i) / (rate * 0.02));
      }
      break;
    }
    case 'waves':
    case 'rain':
    case 'riser': {
      const lp = svf();
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const x = t / (n / rate);
        let s;
        if (type === 'waves') s = lp(noise(), 300 + bright * 1400 * Math.sin(Math.PI * x) + 200, rate, 0.6).low * Math.sin(Math.PI * x) ** 2;
        else if (type === 'rain') s = (rand() < 0.002 * (1 + bright) ? noise() * 0.8 : 0) + lp(noise(), 3500, rate, 0.5).high * 0.06;
        else s = lp(noise(), 300 + 6000 * (0.3 + bright) * x * x, rate, 3).band * x * Math.min(1, (n - i) / (rate * 0.05));
        out[i] = s * (type === 'rain' ? Math.min(1, t / 0.5, (n - i) / (rate * 0.5)) : 1);
      }
      break;
    }
    default:
      break;
  }
  return { rate, data: normalize(out, T.pitched || type === 'kick' ? 0.85 : 0.75) };
}

/** 16-bit mono PCM WAV. */
function toWav({ rate, data }) {
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) buf.writeInt16LE(Math.round(clamp(data[i], -1, 1) * 32767), 44 + i * 2);
  return buf;
}

module.exports = { TYPES, CHORDS, render, toWav };
