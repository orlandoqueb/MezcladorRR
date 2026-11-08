// Mezclador: decides in which BPM range each instrument of RadioRun's adaptive
// music plays, and how loud, with a live preview.
// Run: node server.cjs   → open http://localhost:8099   (no install needed)
//
// "Guardar" writes the changes to mix.json in this folder. The server only
// listens on this computer (127.0.0.1).
//
// "Nueva canción desde un enlace" asks Claude for a new composition inspired by
// a song link (needs ANTHROPIC_API_KEY and `npm install`). Each one is saved in
// songs/<name>/ with its own song.json, kit/ and mix.json.
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const PAGE = path.join(ROOT, 'index.html');
const SONG = path.join(ROOT, 'song.json');
const MIX = path.join(ROOT, 'mix.json');
const KIT = path.join(ROOT, 'kit');
const SONGS = path.join(ROOT, 'songs');
const PORT = Number(process.env.PORT) || 8099;
const MIN_BPM = 40;
const MAX_BPM = 220;

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const isRange = (r) =>
  Array.isArray(r) && r.length === 2 && r.every((b) => Number.isInteger(b) && b >= MIN_BPM && b <= MAX_BPM) && r[0] <= r[1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Keeps only valid changes ({layerId: {in, out, gain}}) that differ from song.json. */
function cleanMix(input, layers) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const l of layers) {
    const m = input[l.id];
    if (!m || typeof m !== 'object') continue;
    const entry = {};
    if (isRange(m.in)) entry.in = [...m.in];
    if (m.out === null) entry.out = null;
    else if (isRange(m.out) && m.out[0] >= (entry.in || l.in)[1]) entry.out = [...m.out];
    if (typeof m.gain === 'number' && m.gain >= 0 && m.gain <= 1.5) entry.gain = Math.round(m.gain * 1000) / 1000;
    if ('in' in entry && same(entry.in, l.in)) delete entry.in;
    if ('out' in entry && same(entry.out, l.out)) delete entry.out;
    if ('gain' in entry && entry.gain === l.gain) delete entry.gain;
    if (Object.keys(entry).length) out[l.id] = entry;
  }
  return out;
}

/** Files of one song: '' is RadioRun's original, anything else a folder in songs/. */
function songFiles(name) {
  if (!name) return { song: SONG, mix: MIX, kit: KIT };
  if (!/^[a-z0-9-]{1,64}$/.test(name)) return null;
  const dir = path.join(SONGS, name);
  if (!fs.existsSync(path.join(dir, 'song.json'))) return null;
  return { song: path.join(dir, 'song.json'), mix: path.join(dir, 'mix.json'), kit: path.join(dir, 'kit') };
}

function listSongs() {
  const list = [{ name: '', title: 'RadioRun (original)' }];
  if (!fs.existsSync(SONGS)) return list;
  const extra = [];
  for (const name of fs.readdirSync(SONGS)) {
    const files = songFiles(name);
    if (!files) continue;
    try {
      const { meta = {} } = readJson(files.song, {});
      extra.push({ name, title: meta.title || name, source: meta.source || null, created: meta.created || '' });
    } catch {
      // A broken song.json: leave it out of the list.
    }
  }
  extra.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return list.concat(extra);
}

function readBody(req, limit, done) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > limit) req.destroy();
  });
  req.on('end', () => done(body));
}

let composing = false;
async function generate(body, res) {
  const { readLink, compose, buildSong, saveSong, MODEL } = require('./composer.cjs');
  if (composing) return send(res, 409, 'application/json', JSON.stringify({ ok: false, error: 'Ya hay una canción componiéndose. Espera a que termine.' }));
  composing = true;
  try {
    const input = JSON.parse(body || '{}');
    const note = String(input.note || '').slice(0, 600);
    const info = await readLink(input.link);
    const spec = await compose({ info, note, songFile: SONG });
    const built = buildSong(spec, { source: info, note, model: MODEL, created: new Date().toISOString() });
    const name = saveSong(SONGS, built);
    send(res, 200, 'application/json', JSON.stringify({ ok: true, name, meta: built.song.meta }));
  } catch (e) {
    send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) }));
  } finally {
    composing = false;
  }
}

/** Free mode, step 1: the prompt to paste into claude.ai. */
async function prompt(body, res) {
  const { readLink, chatPrompt } = require('./composer.cjs');
  try {
    const input = JSON.parse(body || '{}');
    const info = await readLink(input.link);
    const note = String(input.note || '').slice(0, 600);
    send(res, 200, 'application/json', JSON.stringify({ ok: true, info, prompt: chatPrompt({ info, note, songFile: SONG }) }));
  } catch (e) {
    send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}

/** Free mode, step 2: Claude's answer pasted back → a new song. */
function importAnswer(body, res) {
  const { parseAnswer, buildSong, saveSong } = require('./composer.cjs');
  try {
    const input = JSON.parse(body || '{}');
    const spec = parseAnswer(input.answer);
    const source = input.info && typeof input.info === 'object' ? { url: String(input.info.url || ''), title: String(input.info.title || ''), artist: String(input.info.artist || '') } : null;
    const built = buildSong(spec, { source, note: String(input.note || '').slice(0, 600), model: 'claude.ai (copiar y pegar)', created: new Date().toISOString() });
    const name = saveSong(SONGS, built);
    send(res, 200, 'application/json', JSON.stringify({ ok: true, name, meta: built.song.meta }));
  } catch (e) {
    send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE));
  }
  const song = url.searchParams.get('song') || '';
  if (req.method === 'GET' && url.pathname === '/api/songs') {
    return send(res, 200, 'application/json', JSON.stringify({ songs: listSongs() }));
  }
  if (req.method === 'GET' && url.pathname === '/api/song') {
    const files = songFiles(song);
    if (!files) return send(res, 404, 'application/json', JSON.stringify({ ok: false, error: 'No existe esa canción.' }));
    const { layers, meta = null } = readJson(files.song, { layers: [] });
    const kit = song ? `/songs/${song}/kit/` : '/kit/';
    return send(res, 200, 'application/json', JSON.stringify({ name: song, meta, kit, layers, mix: cleanMix(readJson(files.mix, {}), layers) }));
  }
  const kitMatch = url.pathname.match(/^\/(?:songs\/([a-z0-9-]{1,64})\/)?kit\/([a-z0-9-]+\.wav)$/);
  if (req.method === 'GET' && kitMatch) {
    const files = songFiles(kitMatch[1] || '');
    let file = files && path.join(files.kit, kitMatch[2]);
    if (file && !fs.existsSync(file) && kitMatch[1]) {
      // Generated songs keep the recipe of each sound: make the WAV again.
      file = require('./composer.cjs').renderSample(path.dirname(files.song), readJson(files.song, {}).sounds, kitMatch[2].slice(0, -4));
    }
    if (!file || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'Not found');
    return send(res, 200, 'audio/wav', fs.readFileSync(file));
  }
  if (req.method === 'POST' && url.pathname === '/api/mix') {
    const files = songFiles(song);
    if (!files) return send(res, 404, 'application/json', JSON.stringify({ ok: false, error: 'No existe esa canción.' }));
    readBody(req, 100_000, (body) => {
      try {
        const mix = cleanMix(JSON.parse(body || '{}'), readJson(files.song, { layers: [] }).layers);
        if (Object.keys(mix).length) fs.writeFileSync(files.mix, JSON.stringify(mix, null, 2) + '\n');
        else if (fs.existsSync(files.mix)) fs.rmSync(files.mix);
        send(res, 200, 'application/json', JSON.stringify({ ok: true, mix }));
      } catch (e) {
        send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && ['/api/generate', '/api/prompt', '/api/import'].includes(url.pathname)) {
    // JSON only: other web pages can't send that without the browser asking
    // first (and this server never says yes), so they can't spend your credits
    // or add songs.
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, 'text/plain', 'JSON only');
    const run = { '/api/generate': generate, '/api/prompt': prompt, '/api/import': importAnswer }[url.pathname];
    readBody(req, url.pathname === '/api/import' ? 2_000_000 : 10_000, (body) => run(body, res));
    return;
  }
  send(res, 404, 'text/plain', 'Not found');
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, '127.0.0.1', () => {
    console.log(`Mezclador: http://localhost:${PORT}  (Ctrl+C para cerrar)`);
  });
}

module.exports = { cleanMix, handle };
