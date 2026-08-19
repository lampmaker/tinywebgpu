// Builds the minified artifacts from tinywebgpu.js.
//
//   npm run build:min    → tinywebgpu.min.js    settings in build.min.config.mjs
//   npm run build:tiny   → tinywebgpu.tiny.js   settings in build.tiny.config.mjs
//
// The *settings* of a build live in a config file, build.<name>.config.mjs — pick one with a
// positional argument (`node build-min.mjs tiny`; default `min`) or point anywhere with
// --config=path. What lives here is the *machinery*: the feature registry (FEATURES /
// REQUIRES), the numbered-error table (ERRORS), and the transforms. CLI flags override the
// chosen config per run: --out=, --with=, --without=, --iife, --pack / --no-pack, --no-banner.
//
// The library is one file with `const NAME = true;` switches at the top; this script rewrites
// those lines and lets esbuild's dead-code elimination take out whatever they guard. That is why
// the switches are plain top-level consts rather than options: an option is read at runtime and
// has to stay in the bundle, a const folds away.
//
// The mechanisms, because one is not enough:
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
//   4. The F_* switches drop whole entry points — the config's `features` list (plus --with /
//      --without) says which stay.
//   5. `shorthand` (a token table, wgsl_shorthand.js format) swaps the `const SHORTHAND = 0;`
//      seam in the source for an expander that runs on every shader at compile time, then
//      compresses the library's own WGSL template literals to the same tokens.
//   6. `pack` rewrites repeated long WebGPU member names to bracket reads from one packed
//      string table; `packComment` appends a legend naming them.
//   7. `singleLine` escapes the raw newlines esbuild leaves inside template literals, so the
//      output file is a single line.
//
// Errors still throw in every build. With the `msg` feature off they carry a number instead of
// a sentence; the numbers are listed in ERRORS below.
//
// Usage:
//   node build-min.mjs                                  the stock build (build.min.config.mjs)
//   node build-min.mjs tiny                              build.tiny.config.mjs
//   node build-min.mjs tiny --with=show,blend            ...plus these features
//   node build-min.mjs min --without=pingpong            ...minus one
//   node build-min.mjs tiny --out=dist/twg.js            write somewhere else
//   node build-min.mjs tiny --iife                       a plain <script>: globalThis.WEBGPU
//   node build-min.mjs --config=my.config.mjs            a config of your own
//   (--tiny is accepted as an alias for the tiny config.)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

const SRC = 'tinywebgpu.js';

// Switch name → what a config's `features` list (and --with/--without) calls it. `msg` is
// listed so a tiny build can keep its error text; DIAG is not, because no build ships with it.
const FEATURES = {
  msg: 'MSG',
  texio: 'F_TEXIO',
  read: 'F_READ',
  save: 'F_SAVE',
  show: 'F_SHOW',
  pingpong: 'F_PINGPONG',
  resize: 'F_RESIZE',
  blend: 'F_BLEND',
  depth: 'F_DEPTH',
  mips: 'F_MIPS',
  staging: 'F_STAGING',
  aliases: 'F_ALIASES',
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
  6: 'buffer write: byteOffset must be a multiple of 4',
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
  20: 'loadTexture: the fetch for a URL source failed (HTTP status in the message build)',
  21: 'depth: target size unknown — pass a GPUTexture to drawTo, or supply depth.texture',
  22: 'unknown resource name in setResources',
  23: 'init: the CSS selector matched nothing',
};

// ── argv & config ─────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const list = name => (flag(name) ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// `node build-min.mjs tiny` picks build.tiny.config.mjs; --config=path wins; --tiny is the
// legacy spelling of `tiny`; no argument means `min`.
const name = args.find(a => !a.startsWith('--')) ?? (args.includes('--tiny') ? 'tiny' : 'min');
const configPath = flag('config') ?? `build.${name}.config.mjs`;
const config = (await import(pathToFileURL(resolve(configPath)).href)).default;
const cfgFeatures = config.features ?? [];

const unknown = [...cfgFeatures, ...list('with'), ...list('without')].filter(f => !(f in FEATURES));
if (unknown.length) {
  console.error(`build-min: unknown feature ${unknown.map(f => `'${f}'`).join(', ')} (${configPath} / flags).`);
  console.error(`Known: ${Object.keys(FEATURES).join(', ')}.`);
  process.exit(1);
}

// The config's feature list, plus --with, minus --without. DIAG is off in every build.
const on = new Set([...cfgFeatures, ...list('with')]);
for (const f of list('without')) on.delete(f);
// Pulling a dependency back in silently would leave you wondering why the build did not shrink.
for (const f of [...on]) for (const dep of REQUIRES[f] ?? []) {
  if (!on.has(dep)) console.warn(`build-min: keeping '${dep}' — '${f}' needs it. Drop both to remove it.`);
  on.add(dep);
}

const switches = { DIAG: false };
for (const [feature, sw] of Object.entries(FEATURES)) switches[sw] = on.has(feature);

const OUT = flag('out') ?? config.out;
const iife = args.includes('--iife') || (config.iife && !args.includes('--no-iife'));
const pack = args.includes('--pack') || (config.pack && !args.includes('--no-pack'));
const banner = config.banner !== false && !args.includes('--no-banner');

// ── shared helper: walk minified JS, applying `fn` to template-literal text spans ─────────────
// Both the shorthand compression and the single-line escape need to touch only the *text* of
// template literals (the parts outside ${…}). Minified output has no comments, and none of the
// library's regex literals contain quotes, backticks or newlines, so strings are the only
// context that needs tracking: '…', "…", `…`, and ${…} nesting (a number = its brace depth).
const mapTemplateText = (code, fn) => {
  let out = '', run = '', stack = [], i = 0;
  const flush = () => { out += fn(run); run = ''; };
  while (i < code.length) {
    const ch = code[i], t = stack[stack.length - 1];
    if (t === '`') {
      if (ch === '\\') { run += ch + (code[i + 1] ?? ''); i += 2; continue; }
      if (ch === '`') { flush(); stack.pop(); out += ch; i++; continue; }
      if (ch === '$' && code[i + 1] === '{') { flush(); stack.push(0); out += '${'; i += 2; continue; }
      run += ch; i++; continue;
    }
    if (t === "'" || t === '"') {
      if (ch === '\\') { out += ch + (code[i + 1] ?? ''); i += 2; continue; }
      if (ch === t) stack.pop();
      out += ch; i++; continue;
    }
    // plain code, or a ${…} expression (t is its brace depth)
    if (ch === "'" || ch === '"' || ch === '`') stack.push(ch);
    else if (typeof t === 'number') {
      if (ch === '{') stack[stack.length - 1] = t + 1;
      else if (ch === '}') {
        if (t === 0) { stack.pop(); out += ch; i++; continue; }   // back into the template text
        stack[stack.length - 1] = t - 1;
      }
    }
    out += ch; i++;
  }
  return out;
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── flip the switches ─────────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
let source = await readFile(SRC, 'utf8');

const replaceOnce = (needle, replacement, why) => {
  const hits = source.split(needle).length - 1;
  // Fail loudly rather than silently shipping a build that still carries what the line guards.
  if (hits !== 1) {
    console.error(`build-min: expected exactly one \`${needle}\` in ${SRC}, found ${hits}.`);
    console.error(`${why} — fix the anchor before releasing.`);
    process.exit(1);
  }
  source = source.replace(needle, replacement);
};

for (const [sw, value] of Object.entries(switches)) {
  const needle = `const ${sw} = true;`;
  const hits = source.split(needle).length - 1;
  if (hits !== 1) {
    console.error(`build-min: expected exactly one \`${needle}\` in ${SRC}, found ${hits}.`);
    console.error('A switch declaration moved or changed shape — fix the anchor before releasing.');
    process.exit(1);
  }
  if (!value) source = source.replace(needle, `const ${sw} = false;`);
}

// ── shorthand: swap the SHORTHAND seam for an expander, remember the compressible tokens ──────
// The table is a wgsl_shorthand.js-format string: entries split on commas/newlines, each
// `TOKEN replacement`. The expander built from it runs in compileShader on every shader.
// Only tokens whose replacement is a generic type (contains `<`) are also *compressed* out of
// the library's own WGSL below — bare words like `f32` appear in regexes and messages too, and
// rewriting those would corrupt them; the expander still serves them for the piece's WGSL.
let compressTokens = [];
if (config.shorthand) {
  const map = {};
  for (const e of config.shorthand.split(/[,\n]/)) {
    const m = /^(\S+)\s+(.+)/.exec(e.trim());
    if (m) map[m[1]] = m[2];
  }
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  replaceOnce('const SHORTHAND = 0;',
    `const SHORTHAND = s => s.replace(/\\b(?:${keys.map(escapeRe).join('|')})\\b/g, t => (${JSON.stringify(map)})[t]);`,
    'The SHORTHAND seam moved or changed shape');
  compressTokens = Object.entries(map).filter(([, v]) => v.includes('<'))
    .sort((a, b) => b[1].length - a[1].length);
}

// An inline <script> cannot be a module without `type="module"`, which some embedding contexts
// do not give you. --iife hands back a classic script that assigns globalThis.WEBGPU instead.
// The export is rewritten by hand rather than via esbuild's `globalName`, which would add ~450
// bytes of CommonJS interop boilerplate to hand over a single function.
if (iife) {
  source = source.replace('export let WEBGPU', 'let WEBGPU') + '\nglobalThis.WEBGPU = WEBGPU;\n';
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
  ...(banner ? { banner: `/*! TinyWebGPU ${pkg.version} | MIT | github.com/lampmaker/tinywebgpu */` } : {}),
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
  ['depth support', /depthStencil/, !switches.F_DEPTH],
  ['mipmaps', /baseMipLevel/, !switches.F_MIPS],
  ['staging ring', /262144|1<<18/, !switches.F_STAGING],
  ['long aliases', /uniformFields/, !switches.F_ALIASES],
];
for (const [what, re, shouldBeGone] of guards) {
  if (shouldBeGone && re.test(code)) {
    console.error(`build-min: ${what} survived into ${OUT} — the strip did not work.`);
    process.exit(1);
  }
}

// Every numbered throw must have an entry in ERRORS, and no number may be used twice.
const used = [...source.matchAll(/\berr\((\d+), MSG &&/g)].map(m => +m[1]);
const dupes = used.filter((n, i) => used.indexOf(n) !== i);
const undocumented = used.filter(n => !(n in ERRORS));
if (dupes.length || undocumented.length) {
  if (dupes.length) console.error(`build-min: error code(s) ${[...new Set(dupes)].join(', ')} used more than once.`);
  if (undocumented.length) console.error(`build-min: error code(s) ${undocumented.join(', ')} missing from the ERRORS table.`);
  process.exit(1);
}

let packed = code;

// ── shorthand compression: the library's own WGSL uses the short tokens too ──────────────────
// Template-literal text only — schema type strings and error messages are quoted strings and
// stay long-form (schema types are parsed, not compiled, so the expander never sees them).
if (compressTokens.length) {
  const before = packed.length;
  packed = mapTemplateText(packed, s => {
    for (const [token, long] of compressTokens) s = s.replaceAll(long, token);
    return s;
  });
  console.log(`  shorthand: ${compressTokens.length} token(s) compressed (-${before - packed.length}B strings, +expander)`);
}

// ── name-table compression ────────────────────────────────────────────────────────────────────
// Rewrites repeated long WebGPU member names to bracket reads from one packed string table:
// `.beginComputePass(` becomes `[$a](` with `beginComputePass` spelled once in a `let[$a,…]=
// "…".split(",")` prelude. Raw bytes only — gzip would deduplicate the names anyway, but the
// inline/on-chain builds this exists for never gzip. A name is rewritten only when *every*
// occurrence in the output is a member access — one appearance as an object key or inside a
// string disqualifies it, so the rewrite can never change an API contract.
const packTable = [], prePack = packed.length;
if (pack) {
  const CANDIDATES = [
    'beginComputePass', 'beginRenderPass', 'createShaderModule', 'getCompilationInfo',
    'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'createCommandEncoder', 'createBindGroup',
    'createRenderPipeline', 'createComputePipeline', 'getBindGroupLayout', 'setBindGroup',
    'setPipeline', 'writeBuffer', 'copyBufferToBuffer', 'copyTextureToBuffer', 'getMappedRange',
    'mapAsync', 'createView', 'createTexture', 'requestAdapter', 'requestDevice', 'writeTexture',
    'createSampler', 'getCurrentTexture', 'clearBuffer', 'destroy', 'configure',
    'getPreferredCanvasFormat', 'pushErrorScope', 'popErrorScope',
  ];
  // Short identifiers guaranteed absent from the minified output.
  const ids = [];
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const id = '$' + c;
    if (!new RegExp(`\\$${c}\\b`).test(packed)) ids.push(id);
  }
  for (const name of CANDIDATES) {
    if (!ids.length) break;
    const total = packed.split(name).length - 1;
    const uses = [...packed.matchAll(new RegExp(`(\\?\\.|\\.)${name}\\b`, 'g'))];
    if (total === 0 || uses.length !== total) continue;   // key/string appearance → unsafe, skip
    const id = ids[0];
    // profit: each `.name` (1+len) → `[id]` (2+id.len); `?.name` → `?.[id]` costs 2 more.
    const saved = uses.reduce((a, m) => a + name.length + 1 - (2 + id.length) - (m[1] === '?.' ? 2 : 0), 0);
    const cost = name.length + 1 + id.length + 1;         // table string entry + destructure slot
    if (saved <= cost) continue;
    ids.shift();
    packTable.push([name, id]);
    packed = packed.replace(new RegExp(`(\\?\\.|\\.)${name}\\b`, 'g'),
      (m, d) => (d === '?.' ? '?.[' : '[') + id + ']');
  }
  if (packTable.length) {
    const decl = `let[${packTable.map(t => t[1]).join(',')}]=${JSON.stringify(packTable.map(t => t[0]).join(','))}.split(",");`;
    // keep the /*! banner */ first if present
    const m = packed.match(/^\/\*![^]*?\*\/\n?/);
    packed = m ? m[0] + decl + packed.slice(m[0].length) : decl + packed;
    console.log(`  name-table: ${packTable.length} names packed (${prePack - packed.length >= 0 ? '-' : '+'}${Math.abs(prePack - packed.length)}B)`);
  }
}

// ── single line ───────────────────────────────────────────────────────────────────────────────
// esbuild leaves raw newlines inside template literals (quoted strings already carry \n
// escapes); escape those, then splice out what little remains between lines — the newline the
// banner adds, and the trailing one. Joining is guarded: if a removed newline would fuse two
// word characters, a space goes in instead, so the transform can never change meaning.
if (config.singleLine !== false) {
  packed = mapTemplateText(packed, s => s.replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
  const parts = packed.split('\n').filter(Boolean);
  if (parts.length > 2) console.warn(`build-min: ${parts.length} line(s) outside strings before the single-line join — unexpected, but joined safely.`);
  packed = parts.reduce((a, p) => a + (/\w$/.test(a) && /^\w/.test(p) ? ' ' : '') + p) + '\n';
}

// The legend for the packed names, as one inline comment at the end of the file — so the packed
// output stays readable without this script at hand.
if (packTable.length && (config.packComment || args.includes('--pack-comment'))) {
  packed = packed.trimEnd() + `/*pack:${packTable.map(([n, id]) => `${id}=${n}`).join(',')}*/\n`;
}

// The transforms above edit minified output textually — prove the result still parses before
// shipping it. (The real behavioral guard is the test suite, which runs against the artifacts.)
await transform(packed, { loader: 'js' }).catch(e => {
  console.error(`build-min: ${OUT} no longer parses after post-processing:\n${e.message}`);
  process.exit(1);
});

await mkdir(dirname(OUT), { recursive: true }).catch(() => { });
await writeFile(OUT, packed);

const kb = n => (n / 1024).toFixed(1) + ' KB';
const dropped = Object.keys(FEATURES).filter(f => !on.has(f));
console.log(`${OUT}  ${kb(Buffer.byteLength(packed))}  (from ${kb(Buffer.byteLength(await readFile(SRC, 'utf8')))})`
  + (dropped.length ? `\n  without: ${dropped.join(', ')}` : ''));
