// Builds the minified artifacts from tinywebgpu.js.
//
//   npm run build:min    → tinywebgpu.min.js    DIAG off, everything else on
//   npm run build:tiny   → tinywebgpu.tiny.js   DIAG + MSG + the optional features off
//
// The library is one file with `const NAME = true;` switches at the top; this script rewrites
// those lines and lets esbuild's dead-code elimination take out whatever they guard. That is why
// the switches are plain top-level consts rather than options: an option is read at runtime and
// has to stay in the bundle, a const folds away.
//
// Four mechanisms, because one is not enough:
//   1. esbuild `drop: ['console']` deletes every console.* call *including its arguments*,
//      which is what removes the ~2 KB of warning text. (This is also why the library calls
//      console directly instead of going through a logging helper — a helper would hide the
//      calls from esbuild and keep every message string in the bundle.)
//   2. Flipping DIAG to false lets dead-code elimination drop what drop:console cannot: the WGSL
//      compile-log formatter (it builds a string with .split/.padStart, and esbuild has to assume
//      those might have side effects), the bind-group resource validator, the buffer-size check,
//      and every debug `label:`. All four are diagnostics — the driver still validates.
//   3. `mangleProps: /^_/` renames the internal properties. A minifier will not touch `obj.foo`
//      on its own, since something outside might read it by name; the regex is the promise that
//      nothing does, and no `_`-prefixed property appears in API.md. A handful are reserved
//      because the tests reach for them by name when run against this build.
//   4. The F_* switches drop whole entry points. Only `build:tiny` touches them, and only the
//      ones you say — see --with / --without below.
//
// Errors still throw in every build. In the tiny build they carry a number instead of a sentence
// (MSG=false); the numbers are listed in ERRORS below.
//
// Usage:
//   node build-min.mjs                                  the stock minified build
//   node build-min.mjs --tiny                            everything optional removed
//   node build-min.mjs --tiny --with=show,blend          ...except these
//   node build-min.mjs --tiny --without=pingpong         keep the defaults, drop one more
//   node build-min.mjs --tiny --out=dist/twg.js          write somewhere else
//   node build-min.mjs --tiny --iife                     a plain <script>: globalThis.WEBGPU
//   node build-min.mjs --tiny --no-banner                drop the 63-byte MIT header

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { transform } from 'esbuild';

const SRC = 'tinywebgpu.js';

// Switch name → what --with/--without calls it. `msg` is listed here so a tiny build can keep
// its error text; DIAG is not, because no build ships with it on.
const FEATURES = {
  msg: 'MSG',
  texio: 'F_TEXIO',
  read: 'F_READ',
  save: 'F_SAVE',
  show: 'F_SHOW',
  pingpong: 'F_PINGPONG',
  resize: 'F_RESIZE',
  blend: 'F_BLEND',
};

// A feature that cannot stand on its own. Asking for the key implies the values.
const REQUIRES = { save: ['read'] };

// What the numbered errors in a MSG=false build mean. Keep in sync with tinywebgpu.js — the
// check at the bottom fails the build if a number is used twice or a message goes unnumbered.
const ERRORS = {
  1: 'WebGPU not supported',
  2: 'No GPU adapter',
  3: 'WGSL compilation failed',
  4: 'unknown blend preset',
  5: 'buffer write: not a TypedArray or ArrayBuffer',
  6: 'buffer write: byteOffset must be a multiple of 4 inside beginFrame()',
  7: 'no render target — init() had no canvas context and no view was passed',
  8: 'resizeCanvas: no canvas',
  9: 'writeTexture: unknown bytes-per-texel, pass bytesPerRow',
  10: 'loadTexture: could not determine source dimensions',
  11: 'readTexture: unknown bytes-per-texel',
  12: 'unknown uniform type',
  13: 'unknown uniform name',
  14: 'bind group resource validation failed (DIAG builds only)',
  15: 'no resources bound — call setResources() first',
  16: '(retired — dispatch() joins an open chained pass instead of throwing)',
  17: 'no active compute pass — call beginCompute() first',
  18: 'drawTo: no view for a named target',
  19: 'save: needs an 8-bit RGBA texture',
};

// ── argv ──────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const list = name => (flag(name) ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const tiny = args.includes('--tiny');

const unknown = [...list('with'), ...list('without')].filter(f => !(f in FEATURES));
if (unknown.length) {
  console.error(`build-min: unknown feature ${unknown.map(f => `'${f}'`).join(', ')}.`);
  console.error(`Known: ${Object.keys(FEATURES).join(', ')}.`);
  process.exit(1);
}

// A tiny build starts with everything off and adds back what --with names; a normal build starts
// with everything on and removes what --without names. DIAG is off either way.
const on = new Set(tiny ? list('with') : Object.keys(FEATURES));
for (const f of list('without')) on.delete(f);
// Pulling a dependency back in silently would leave you wondering why the build did not shrink.
for (const f of [...on]) for (const dep of REQUIRES[f] ?? []) {
  if (!on.has(dep)) console.warn(`build-min: keeping '${dep}' — '${f}' needs it. Drop both to remove it.`);
  on.add(dep);
}

const switches = { DIAG: false };
for (const [feature, name] of Object.entries(FEATURES)) switches[name] = on.has(feature);

const OUT = flag('out') ?? (tiny ? 'tinywebgpu.tiny.js' : 'tinywebgpu.min.js');

// ── flip the switches ─────────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
let source = await readFile(SRC, 'utf8');

for (const [name, value] of Object.entries(switches)) {
  const needle = `const ${name} = true;`;
  const hits = source.split(needle).length - 1;
  // Fail loudly rather than silently shipping a build that still carries what the switch guards.
  if (hits !== 1) {
    console.error(`build-min: expected exactly one \`${needle}\` in ${SRC}, found ${hits}.`);
    console.error('A switch declaration moved or changed shape — fix the anchor before releasing.');
    process.exit(1);
  }
  if (!value) source = source.replace(needle, `const ${name} = false;`);
}

// An inline <script> cannot be a module without `type="module"`, which some embedding contexts
// do not give you. --iife hands back a classic script that assigns globalThis.WEBGPU instead.
// The export is rewritten by hand rather than via esbuild's `globalName`, which would add ~450
// bytes of CommonJS interop boilerplate to hand over a single function.
const iife = args.includes('--iife');
if (iife) {
  source = source.replace('export const WEBGPU', 'const WEBGPU') + '\nglobalThis.WEBGPU = WEBGPU;\n';
}

const { code, warnings } = await transform(source, {
  loader: 'js',
  format: iife ? 'iife' : 'esm',
  minify: true,
  drop: ['console'],
  mangleProps: /^_/,
  // Reserved because test/layout.test.mjs reaches for them by name when run against this build:
  // the staging pair is stubbed out, and the texel-size derivation and blend presets are
  // asserted directly.
  reserveProps: /^_(acquireStaging|releaseStaging|texelBytes|resolveBlend)$/,
  legalComments: 'none',
  ...(args.includes('--no-banner')
    ? {}
    : { banner: `/*! TinyWebGPU ${pkg.version} | MIT | github.com/lampmaker/tinywebgpu */` }),
});
for (const w of warnings) console.warn('build-min:', w.text);

// ── guard against a future refactor quietly reintroducing what a switch is meant to remove ────
const guards = [
  ['console call', /console\s*\./, true],
  ['compile-log formatter', /WGSL Compile Log/, true],
  ['error text', /No resources bound/, !switches.MSG],
  ['save()', /convertToBlob/, !switches.F_SAVE],
  ['show()', /textureDimensions/, !switches.F_SHOW],
  ['loadTexture()', /createImageBitmap/, !switches.F_TEXIO],
  ['readTexture()', /copyTextureToBuffer/, !switches.F_READ],
  ['resizeCanvas()', /devicePixelRatio/, !switches.F_RESIZE],
  ['blend presets', /one-minus-src-alpha/, !switches.F_BLEND],
];
for (const [what, re, shouldBeGone] of guards) {
  if (shouldBeGone && re.test(code)) {
    console.error(`build-min: ${what} survived into ${OUT} — the strip did not work.`);
    process.exit(1);
  }
}

// Every numbered throw must have an entry in ERRORS, and no number may be used twice.
const used = [...source.matchAll(/MSG \?[\s\S]*?: (\d+)\)/g)].map(m => +m[1]);
const dupes = used.filter((n, i) => used.indexOf(n) !== i);
const undocumented = used.filter(n => !(n in ERRORS));
if (dupes.length || undocumented.length) {
  if (dupes.length) console.error(`build-min: error code(s) ${[...new Set(dupes)].join(', ')} used more than once.`);
  if (undocumented.length) console.error(`build-min: error code(s) ${undocumented.join(', ')} missing from the ERRORS table.`);
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true }).catch(() => { });
await writeFile(OUT, code);

const kb = n => (n / 1024).toFixed(1) + ' KB';
const dropped = Object.keys(FEATURES).filter(f => !on.has(f));
console.log(`${OUT}  ${kb(Buffer.byteLength(code))}  (from ${kb(Buffer.byteLength(await readFile(SRC, 'utf8')))})`
  + (dropped.length ? `\n  without: ${dropped.join(', ')}` : ''));
