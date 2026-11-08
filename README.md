# Mezclador

Una página para decidir **en qué rango de BPM suena cada instrumento** de la música adaptativa de [RadioRun](https://github.com/cvergaraqec-blip/RadioRun-App) y con qué volumen, escuchándolo en vivo con los mismos sonidos y el mismo secuenciador que la app.

![Cada fila es un instrumento; la parte verde es el rango de BPM en que suena.](docs/mezclador.png)

## Abrirlo

Necesitas [Node.js](https://nodejs.org) (versión 18 o más nueva).

```bash
git clone https://github.com/orlandoqueb/MezcladorRR.git
cd MezcladorRR
node server.cjs
# opcional, para componer con clave de API: npm install && ANTHROPIC_API_KEY=tu-clave node server.cjs
```

En Windows (PowerShell): `$env:ANTHROPIC_API_KEY="tu-clave"; node server.cjs`. La clave se crea en [platform.claude.com](https://platform.claude.com/settings/keys); se queda en tu computadora, nunca llega a la página ni al repositorio.

Abre http://localhost:8099 en el navegador. Para cerrarlo, `Ctrl+C`.

## Usarlo

- **Mapa:** cada fila es un instrumento. La parte verde es el rango de BPM en que suena; el degradado es donde entra o sale poco a poco. Arrastra las **barras blancas** para que entre antes o después, o para que dure más o menos.
- **Instrumento:** abajo puedes escribir los BPM exactos, hacer que siga sonando hasta 220 y cambiar su volumen.
- **Play:** con **BPM fijo** (el deslizador) o en un **Recorrido** de 45 a 215 BPM en 2 min 30 s. Los cambios se oyen al momento.
- **M:** silencia una fila solo para escuchar el resto; no se guarda.
- **Tus loops:** arrastra un WAV o MP3 e indica cuántos beats dura. Sigue el BPM sin cambiar de tono, como la música de Training. Solo se escucha mientras la página está abierta: no se guarda.
- **Guardar:** escribe tu mezcla en `mix.json`. Haz commit de ese archivo para compartirla.

## Canciones nuevas desde un enlace

Arriba, en **Nueva canción desde un enlace**, pega el enlace de una canción que te guste (YouTube, Spotify, SoundCloud, Vimeo o cualquier página) y, si quieres, qué te gusta de ella. Hay dos formas de componer:

- **Gratis con claude.ai** (no necesita clave ni `npm install`): pulsa **Componer gratis con claude.ai**, copia el texto que aparece, pégalo en un chat nuevo de [claude.ai](https://claude.ai/new) (sirve una cuenta gratis), copia la respuesta completa de Claude y pégala en el paso 2. Pulsa **Crear la canción**. Si la respuesta se corta, pídele "continúa" en el chat y pega todo junto.
- **Con clave de API** (automático, se paga por uso): arranca el servidor con `ANTHROPIC_API_KEY=tu-clave node server.cjs` y pulsa **Con clave de API**. Tarda uno o dos minutos.

En los dos casos la canción nueva aparece en el selector **Escuchando**, lista para tocar y mezclar.

- **Qué hace la IA:** el Mezclador lee del enlace el título y el artista (el audio nunca se descarga) y Claude compone una canción original inspirada en ella: elige instrumentos, tonalidad, patrones, volúmenes y rangos de BPM. No copia la melodía ni la letra.
- **Siempre con la forma de RadioRun:** empieza tranquila tipo spa a 40 BPM (pads, olas, melodías suaves), el ritmo entra poco a poco (shaker, bajo, bombo, charles, palmas) y arriba de ~150 BPM se vuelve compleja e intensa (ride, lead, stabs, redobles). El servidor revisa lo que devuelve Claude y lo corrige si algo se sale de ese arco.
- **Los sonidos se crean por código**, como el kit original: 27 tipos de instrumento (pad, cuerdas, piano eléctrico, campanas, cuerda pulsada, marimba, flauta, lead, bajos, acid, stab, bombo, caja, palmas, charles, shaker, ride, platillo, toms, congas, latido, olas, lluvia, barrido…), en `synth.cjs`.
- **Dónde queda:** cada canción en `songs/<nombre>/song.json`, con la receta de cada sonido. Los WAV de `songs/<nombre>/kit/` se vuelven a crear solos si faltan, así que para compartir una canción basta con hacer commit de su `song.json` (y su `mix.json`).
- **Spotify** solo comparte el nombre de la canción, no el artista: escríbelo en "Qué te gusta de ella" para que Claude acierte con el estilo.
- **Costo:** gratis con claude.ai; con clave de API, cada canción es una llamada a Claude Opus 5.5 (alrededor de medio dólar).
- **Demo:** `songs/demo-marimba-al-atardecer/` es una canción hecha a mano con el mismo formato, para probar el selector sin clave.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La página del Mezclador |
| `server.cjs` | Servidor local: sirve la página y los sonidos, guarda `mix.json` y compone canciones nuevas |
| `composer.cjs` | Enlace → Claude → `song.json` nuevo: lee el enlace, pide la composición y la revisa |
| `synth.cjs` | Los instrumentos de las canciones nuevas, generados por código |
| `songs/` | Canciones compuestas desde un enlace (cada una con su `song.json`, `kit/` y `mix.json`) |
| `test/` | Pruebas: `npm test` (no necesitan clave) |
| `song.json` | La canción: las 18 capas, sus patrones y sus rangos de BPM originales |
| `kit/` | Los 47 sonidos de la canción (WAV) |
| `mix.json` | Tu mezcla: solo lo que cambia respecto a `song.json` (aparece al guardar) |

`song.json` y `kit/` vienen de RadioRun (`scripts/adaptive/song.cjs` y `kit.cjs`), en la versión tranquila: pad suave sin vaivén, flauta de pan en lugar de campanas y olas más bajas. Todos los sonidos son originales, generados por código; no hay grabaciones de terceros.

## Llevar la mezcla a RadioRun

`mix.json` tiene la forma `{ "flute": { "out": [145, 190] }, "air": { "gain": 0.1 } }`: por cada instrumento, solo los valores que cambiaste (`in` y `out` en BPM, `gain` de volumen). Pásale ese archivo a quien mantiene la música de la app (o a Claude) para aplicarlo en `scripts/adaptive/`.
