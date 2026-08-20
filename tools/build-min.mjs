// Builds the minified artifacts from src/tinywebgpu.js.
//
//   npm run build:min    → dist/tinywebgpu.min.js    settings in tools/build.min.config.mjs
//   npm run build:tiny   → dist/tinywebgpu.tiny.js   settings in tools/build.tiny.config.mjs
//
// The *settings* of a build live in a config file, tools/build.<name>.config.mjs — pick one with
// a positional argument (`node tools/build-min.mjs tiny`; default `min`) or point anywhere with
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
//   4. The F_* switches drop whole entry points — the config's `features` true/false map
//      (plus --with / --without per run) says which stay; each entry carries a one-line
//      description of what it guards.
//   5. `shorthand` (a G.defines-format token table) seeds the `defines: ''` default —
//      the core's always-on G.defines expander serves the tokens at compile time — then
//      compresses the library's own WGSL template literals to the same tokens. The seeded
//      tokens are load-bearing in such a build: append to G.defines, never replace it.
//   6. `pack` rewrites repeated long WebGPU member names to bracket reads from one packed
//      string table (`packNames` picks mnemonic codes, e.g. cRP for createRenderPipeline);
//      `packComment` appends a legend naming them. Platform names can only be aliased this
//      way — the browser owns them.
//   7. `rename` (config table / --rename) truly renames the library's *own* API via esbuild's
//      mangleCache — setResources → sR, resources → rS — so a piece built against it saves the
//      bytes on both sides of every call. The build ends with a /*renamed:…*/ legend; the
//      stock artifacts keep the long names, since the demos and tests speak them.
//   8. `singleLine` escapes the raw newlines esbuild leaves inside template literals, so the
//      output file is a single line.
//   9. A terser second pass picks up what esbuild's minifier leaves behind by design: esbuild
//      removes dead code at module top level only, so a feature-gated helper folded to
//      `let helper = 0` inside the WEBGPU factory survives as an unused binding — as does an
//      unconditional one-liner whose only callers were stripped, and its body's captures in
//      turn. terser eliminates unused function-scope locals (cascading), and `pure_getters`
//      also prunes the unused entries of the `{min,max,…} = Math` destructure — safe here
//      because nothing the library reads has a side-effecting getter. ~5% off the tiny build.
//
// Errors still throw in every build. With the `msg` feature off they carry a number instead of
// a sentence; the numbers are listed in ERRORS below.
//
// Usage:
//   node tools/build-min.mjs                                  the stock build (build.min.config.mjs)
//   node tools/build-min.mjs tiny                              build.tiny.config.mjs
//   node tools/build-min.mjs tiny --with=show,blend            ...plus these features
//   node tools/build-min.mjs min --without=pingpong            ...minus one
//   node tools/build-min.mjs tiny --out=twg.js                 write somewhere else
//   node tools/build-min.mjs tiny --iife                       a plain <script>: globalThis.WEBGPU
//   node tools/build-min.mjs tiny --rename                     apply the config's RENAMES table
//   node tools/build-min.mjs tiny --rename=drawTo:dT,setResources:sR   exactly these renames
//   node tools/build-min.mjs --config=my.config.mjs            a config of your own
//   (--tiny is accepted as an alias for the tiny config.)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { minify as terserMinify } from 'terser';

// Repo paths are anchored to the root (the directory above this file), so a build behaves the
// same whatever directory you launch it from. Only --config= and --out= follow your cwd.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src/tinywebgpu.js');
const rel = p => relative(process.cwd(), p) || p;

// Switch name → what a config's `features` map (and --with/--without) calls it. `msg` is
// listed so a tiny build can keep its error text; DIAG is not, because no build ships with it.
// The per-feature descriptions live next to the true/false entries in the config files.
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

// WebGPU member names the name-table pack may alias. These are the *browser's* names — the
// library must call them verbatim, so they can only be aliased ([$a] bracket reads), never
// renamed. The library's own API names are the `rename` config's territory instead.
const CANDIDATES = [
  'beginComputePass', 'beginRenderPass', 'createShaderModule', 'getCompilationInfo',
  'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'createCommandEncoder', 'createBindGroup',
  'createRenderPipeline', 'createComputePipeline', 'getBindGroupLayout', 'setBindGroup',
  'setPipeline', 'writeBuffer', 'copyBufferToBuffer', 'copyTextureToBuffer', 'getMappedRange',
  'mapAsync', 'createView', 'createTexture', 'requestAdapter', 'requestDevice', 'writeTexture',
  'createSampler', 'getCurrentTexture', 'clearBuffer', 'destroy', 'configure',
  'getPreferredCanvasFormat', 'pushErrorScope', 'popErrorScope',
];

// Names the `rename` table must never touch: platform members the library calls (see
// CANDIDATES) and descriptor/dictionary keys it writes. mangleProps cannot tell our objects
// from a descriptor handed to the driver, so renaming any of these would corrupt the build —
// refuse loudly instead. Not exhaustive; it guards the obvious traps.
const RESERVED = new Set([
  ...CANDIDATES,
  // Platform members the library calls that are not pack candidates (aliased or single-use).
  'createBuffer', 'copyExternalImageToTexture',
  'gpu', 'queue', 'limits', 'features', 'lost', 'reason', 'message', 'device', 'format',
  'buffer', 'texture', 'view', 'sampler', 'usage', 'size', 'label', 'code', 'entries',
  'binding', 'resource', 'layout', 'module', 'entryPoint', 'targets', 'blend', 'primitive',
  'topology', 'vertex', 'fragment', 'compute', 'colorAttachments', 'depthStencilAttachment',
  'depthClearValue', 'depthLoadOp', 'depthStoreOp', 'depthWriteEnabled', 'depthCompare',
  'depthStencil', 'loadOp', 'storeOp', 'clearValue', 'requiredLimits', 'requiredFeatures',
  'width', 'height', 'origin', 'mipLevel', 'bytesPerRow', 'rowsPerImage', 'baseMipLevel',
  'mipLevelCount', 'sampleCount', 'alphaMode', 'colorSpace', 'flipY', 'premultipliedAlpha',
  'magFilter', 'minFilter', 'addressModeU', 'addressModeV', 'addressModeW', 'compare',
  'byteLength', 'byteOffset', 'messages', 'type', 'lineNum', 'linePos', 'onuncapturederror',
  'unmap', 'finish', 'end', 'draw', 'complete', 'decode', 'close', 'then', 'catch',
  'b', 'w', 'r',
]);

// What the numbered errors in a MSG=false build mean. Keep in sync with tinywebgpu.js — the
// check at the bottom fails the build if a number is used twice or a message goes unnumbered.
const ERRORS = {
  1: 'WebGPU not supported',
  2: 'No GPU adapter',
  3: '(retired — a bad module now surfaces as a pipeline-creation validation error)',
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

// `node tools/build-min.mjs tiny` picks build.tiny.config.mjs; --config=path wins; --tiny is the
// legacy spelling of `tiny`; no argument means `min`.
const name = args.find(a => !a.startsWith('--')) ?? (args.includes('--tiny') ? 'tiny' : 'min');
const configPath = flag('config')
  ? resolve(flag('config'))
  : resolve(ROOT, 'tools', `build.${name}.config.mjs`);
const config = (await import(pathToFileURL(configPath).href)).default;
// `features` is a {name: true|false} map (the stock configs annotate each entry); a plain
// array of names, meaning "these on, the rest off", is accepted too.
const cfgFeatures = config.features ?? {};
const cfgNames = Array.isArray(cfgFeatures) ? cfgFeatures : Object.keys(cfgFeatures);
const cfgOn = Array.isArray(cfgFeatures) ? cfgFeatures : cfgNames.filter(f => cfgFeatures[f]);

const unknown = [...cfgNames, ...list('with'), ...list('without')].filter(f => !(f in FEATURES));
if (unknown.length) {
  console.error(`build-min: unknown feature ${unknown.map(f => `'${f}'`).join(', ')} (${rel(configPath)} / flags).`);
  console.error(`Known: ${Object.keys(FEATURES).join(', ')}.`);
  process.exit(1);
}

// The config's enabled features, plus --with, minus --without. DIAG is off in every build.
const on = new Set([...cfgOn, ...list('with')]);
for (const f of list('without')) on.delete(f);
// Pulling a dependency back in silently would leave you wondering why the build did not shrink.
for (const f of [...on]) for (const dep of REQUIRES[f] ?? []) {
  if (!on.has(dep)) console.warn(`build-min: keeping '${dep}' — '${f}' needs it. Drop both to remove it.`);
  on.add(dep);
}

const switches = { DIAG: false };
for (const [feature, sw] of Object.entries(FEATURES)) switches[sw] = on.has(feature);

const OUT = flag('out') ? resolve(flag('out')) : resolve(ROOT, config.out);
const iife = args.includes('--iife') || (config.iife && !args.includes('--no-iife'));
const pack = args.includes('--pack') || (config.pack && !args.includes('--no-pack'));
const banner = config.banner !== false && !args.includes('--no-banner');
const scrub = config.terser !== false && !args.includes('--no-terser');

// ── the rename table: truly rename the library's own API names ────────────────────────────────
// `--rename=setResources:sR,drawTo:dT` applies exactly those pairs; bare `--rename` (or
// `rename: true` in the config) applies the config's `renames` table; `--no-rename` wins over
// both. The renamed build is a different API — the legend comment appended to the output is
// the contract — so the stock artifacts keep it off: the demos, tutorial and tests speak the
// long names.
const renames = args.includes('--no-rename') ? {}
  : flag('rename')
    ? Object.fromEntries(flag('rename').split(',')
      .map(s => s.split(':').map(t => t.trim())).filter(p => p.length === 2 && p[0] && p[1]))
    : (args.includes('--rename') || config.rename) ? (config.renames ?? {}) : {};
const renameEntries = Object.entries(renames);
{
  const bad = [], codes = new Set();
  for (const [long, short] of renameEntries) {
    if (RESERVED.has(long)) bad.push(`cannot rename '${long}' — it is a WebGPU platform name or dictionary key (the name-table pack aliases those instead).`);
    if (!/^[A-Za-z_$][\w$]*$/.test(short)) bad.push(`rename code '${short}' (for '${long}') is not a valid identifier.`);
    if (RESERVED.has(short)) bad.push(`rename code '${short}' (for '${long}') collides with a WebGPU name the library uses.`);
    if (codes.has(short)) bad.push(`rename code '${short}' is used twice.`);
    codes.add(short);
    if (short.length >= long.length) console.warn(`build-min: renaming '${long}' to '${short}' saves nothing.`);
  }
  if (bad.length) { for (const b of bad) console.error('build-min: ' + b); process.exit(1); }
}

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
const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
let source = await readFile(SRC, 'utf8');

const replaceOnce = (needle, replacement, why) => {
  const hits = source.split(needle).length - 1;
  // Fail loudly rather than silently shipping a build that still carries what the line guards.
  if (hits !== 1) {
    console.error(`build-min: expected exactly one \`${needle}\` in ${rel(SRC)}, found ${hits}.`);
    console.error(`${why} — fix the anchor before releasing.`);
    process.exit(1);
  }
  source = source.replace(needle, replacement);
};

for (const [sw, value] of Object.entries(switches)) {
  const needle = `const ${sw} = true;`;
  const hits = source.split(needle).length - 1;
  if (hits !== 1) {
    console.error(`build-min: expected exactly one \`${needle}\` in ${rel(SRC)}, found ${hits}.`);
    console.error('A switch declaration moved or changed shape — fix the anchor before releasing.');
    process.exit(1);
  }
  if (!value) source = source.replace(needle, `const ${sw} = false;`);
}

// ── shorthand: seed the G.defines default, remember the compressible tokens ──────────────────
// The table is a G.defines-format string: entries split on commas/newlines, each
// `TOKEN replacement`. The expander lives in the core now (G.defines, always on); building a
// table in just replaces the `defines: ''` default with it, normalized to one comma-joined
// string. Only tokens whose replacement is a generic type (contains `<`) are also *compressed*
// out of the library's own WGSL below — bare words like `f32` appear in regexes and messages
// too, and rewriting those would corrupt them; the runtime expander still serves them for the
// piece's WGSL. The seeded tokens are load-bearing: the library's own shaders need them at
// compile time, so a piece must append to G.defines (`+=`), never replace it.
let compressTokens = [];
if (config.shorthand) {
  const map = {};
  for (const e of config.shorthand.split(/[,\n]/)) {
    const m = /^(\S+)\s+(.+)/.exec(e.trim());
    if (m) map[m[1]] = m[2];
  }
  replaceOnce(`defines: '',`,
    `defines: ${JSON.stringify(Object.entries(map).map(([t, r]) => `${t} ${r}`).join(','))},`,
    'The defines seam moved or changed shape');
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
  // The transform API skips top-level dead-code removal by default, which left the flipped
  // `const F_X = false` declarations in the output after every *use* had been folded away.
  treeShaking: true,
  drop: ['console'],
  // The `_`-prefixed internals always mangle. A rename table widens the net to the listed API
  // names, and mangleCache pins each one to its chosen code — esbuild then rewrites the
  // property everywhere it appears (definitions, accesses, destructuring, object literals), so
  // the renamed build is internally consistent by construction.
  mangleProps: renameEntries.length
    ? new RegExp(`^_|^(?:${renameEntries.map(([long]) => escapeRe(long)).join('|')})$`)
    : /^_/,
  ...(renameEntries.length ? { mangleCache: { ...renames } } : {}),
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
    console.error(`build-min: ${what} survived into ${rel(OUT)} — the strip did not work.`);
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

// ── export shape: no intermediate alias ───────────────────────────────────────────────────────
// esbuild's minifier lowers `export let WEBGPU = () => {…}` to `let yt=()=>{…};export{yt as
// WEBGPU};` (and the --iife rewrite above to `let yt=…;globalThis.WEBGPU=yt;`). The alias name
// spends ~11 bytes to say nothing — splice it out so the artifact exports the factory directly,
// the way the source spells it. The rewritten opening is also the anchor the name-table pack
// below hangs its declaration on, which keeps $a/$b inside the factory instead of module scope.
const OPEN = iife ? 'globalThis.WEBGPU=()=>{' : 'export let WEBGPU=()=>{';
if (!packed.includes(OPEN)) {
  const alias = packed.match(iife ? /globalThis\.WEBGPU=([A-Za-z_$][\w$]*);?/ : /export\{([A-Za-z_$][\w$]*) as WEBGPU\};?/);
  const decl = alias && new RegExp(`\\b(?:let|var) ${escapeRe(alias[1])}=\\(\\)=>\\{`);
  // The alias must appear exactly twice — declaration and export/assignment — or the splice
  // would orphan a reference. Fail loudly rather than ship a broken artifact.
  const uses = alias ? (packed.match(new RegExp(`\\b${escapeRe(alias[1])}\\b`, 'g')) ?? []).length : 0;
  if (!alias || uses !== 2 || !decl.test(packed)) {
    console.error(`build-min: could not rewrite the WEBGPU export to \`${OPEN}\` — the minified export changed shape.`);
    process.exit(1);
  }
  packed = packed.replace(alias[0], '').replace(decl, OPEN);
}

// ── terser second pass: remove what esbuild leaves behind by design ──────────────────────────
// esbuild's dead-code elimination stops at module top level; inside the WEBGPU factory it
// constant-folds a stripped feature's `let helper = !F_X ? 0 : (…) => {…}` down to `helper = 0`
// (dropping the body — the real savings) but never deletes an unused local binding. terser
// does, and the removal cascades: a helper only the stripped code called goes too, then
// whatever only it referenced. `pure_getters` additionally prunes the unused entries of the
// `{min,max,…} = Math` destructure — a promise that no property the library reads has a
// side-effecting getter, which holds: its own accessors (S.device) are plain, and the WebGPU
// platform objects' getters don't observably care whether they are read. Property names are
// esbuild's territory (mangleProps/mangleCache, above) — terser's property mangling stays off.
// Sits after the export rewrite, whose `export let WEBGPU=()=>{`/`globalThis.WEBGPU=()=>{`
// shape terser preserves (an alias split back out would re-fail the splice's two-use check),
// and before the shorthand/pack/legend transforms so those see the final identifiers. The
// `/*!` banner survives terser's default comment filter. --no-terser / `terser: false` skips.
if (scrub) {
  const before = packed.length;
  const t = await terserMinify(packed, {
    module: !iife,
    compress: { passes: 3, pure_getters: true },
    mangle: true,
  });
  packed = t.code;
  if (!packed.includes(OPEN)) {
    console.error(`build-min: the terser pass rewrote the \`${OPEN}\` opening — output shape changed, refusing to continue.`);
    process.exit(1);
  }
  console.log(`  terser: unused-binding scrub (-${before - packed.length}B)`);
}

// ── shorthand compression: the library's own WGSL uses the short tokens too ──────────────────
// Template-literal text only — schema type strings and error messages are quoted strings and
// stay long-form (schema types are parsed, not compiled, so the expander never sees them).
if (compressTokens.length) {
  const before = packed.length;
  packed = mapTemplateText(packed, s => {
    for (const [token, long] of compressTokens) s = s.replaceAll(long, token);
    return s;
  });
  console.log(`  shorthand: ${compressTokens.length} token(s) compressed (-${before - packed.length}B strings, +table)`);
}

// ── name-table compression ────────────────────────────────────────────────────────────────────
// Rewrites repeated long WebGPU member names to bracket reads from one packed string table:
// `.beginComputePass(` becomes `[$a](` with `beginComputePass` spelled once in a `let[$a,…]=
// "…".split(",")` declaration at the top of the factory body. Raw bytes only — gzip would deduplicate the names anyway, but the
// inline/on-chain builds this exists for never gzip. A name is rewritten only when *every*
// occurrence in the output is a member access — one appearance as an object key or inside a
// string disqualifies it, so the rewrite can never change an API contract.
const packTable = [], prePack = packed.length;
if (pack) {
  // `packNames` in the config picks mnemonic codes for chosen names ({ createRenderPipeline:
  // 'cRP' }); everything else gets the cheapest free `$x`. A mnemonic code must be word
  // characters (the `\b` collision test below needs that) and costs its extra length once per
  // use — readability the legend comment otherwise provides for free.
  const packNames = config.packNames ?? {};
  const seen = new Set();
  for (const [n, id] of Object.entries(packNames)) {
    if (!CANDIDATES.includes(n)) { console.error(`build-min: packNames: '${n}' is not a pack candidate.`); process.exit(1); }
    if (!/^[A-Za-z_]\w*$/.test(id)) { console.error(`build-min: packNames: code '${id}' (for '${n}') must be word characters.`); process.exit(1); }
    if (seen.has(id)) { console.error(`build-min: packNames: code '${id}' is used twice.`); process.exit(1); }
    seen.add(id);
  }
  // Short identifiers guaranteed absent from the minified output.
  const ids = [];
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const id = '$' + c;
    if (!new RegExp(`\\$${c}\\b`).test(packed)) ids.push(id);
  }
  for (const name of CANDIDATES) {
    let id = packNames[name];
    if (id && new RegExp(`\\b${escapeRe(id)}\\b`).test(packed)) {
      console.warn(`build-min: packNames: '${id}' already appears in the output — using an auto id for '${name}'.`);
      id = undefined;
    }
    if (!id) { if (!ids.length) continue; id = ids[0]; }
    // \b-bounded on both sides: a plain substring count would see `dispatchWorkgroups` inside
    // `dispatchWorkgroupsIndirect` and wrongly disqualify it as a non-member occurrence.
    const total = (packed.match(new RegExp(`\\b${escapeRe(name)}\\b`, 'g')) ?? []).length;
    const uses = [...packed.matchAll(new RegExp(`(\\?\\.|\\.)${name}\\b`, 'g'))];
    if (total === 0 || uses.length !== total) continue;   // key/string appearance → unsafe, skip
    // profit: each `.name` (1+len) → `[id]` (2+id.len); `?.name` → `?.[id]` costs 2 more.
    const saved = uses.reduce((a, m) => a + name.length + 1 - (2 + id.length) - (m[1] === '?.' ? 2 : 0), 0);
    const cost = name.length + 1 + id.length + 1;         // table string entry + destructure slot
    if (saved <= cost) continue;
    if (id === ids[0]) ids.shift();
    packTable.push([name, id]);
    packed = packed.replace(new RegExp(`(\\?\\.|\\.)${name}\\b`, 'g'),
      (m, d) => (d === '?.' ? '?.[' : '[') + id + ']');
  }
  if (packTable.length) {
    const decl = `let[${packTable.map(t => t[1]).join(',')}]=${JSON.stringify(packTable.map(t => t[0]).join(','))}.split(",");`;
    // The declaration opens the factory body — every use is inside it, and the export-shape
    // rewrite above guarantees the anchor — so the ids never touch module/global scope.
    const at = packed.indexOf(OPEN) + OPEN.length;
    packed = packed.slice(0, at) + decl + packed.slice(at);
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

// The legend for the packed names, on its own line below the code — so the packed output stays
// readable without this script at hand, and the code itself stays a single line.
if (packTable.length && (config.packComment || args.includes('--pack-comment'))) {
  packed = packed.trimEnd() + `\n/*pack:${packTable.map(([n, id]) => `${id}=${n}`).join(',')}*/\n`;
}

// The renamed build is a different API, so its legend is not optional: without this comment
// nobody — including you, next month — knows what `sR` is. Only the pairs that survived into
// this build are listed — a stripped build should not pay legend bytes for renames of entry
// points it does not contain. Also on its own line, below the code.
if (renameEntries.length) {
  const applied = renameEntries.filter(([, short]) => new RegExp(`\\b${escapeRe(short)}\\b`).test(packed));
  packed = packed.trimEnd() + `\n/*renamed:${applied.map(([long, short]) => `${short}=${long}`).join(',')}*/\n`;
  console.log(`  renamed: ${applied.length} API name(s) (of ${renameEntries.length} in the table); legend comment appended`);
}

// The transforms above edit minified output textually — prove the result still parses before
// shipping it. (The real behavioral guard is the test suite, which runs against the artifacts.)
await transform(packed, { loader: 'js' }).catch(e => {
  console.error(`build-min: ${rel(OUT)} no longer parses after post-processing:\n${e.message}`);
  process.exit(1);
});

await mkdir(dirname(OUT), { recursive: true }).catch(() => { });
await writeFile(OUT, packed);

const kb = n => (n / 1024).toFixed(1) + ' KB';
const dropped = Object.keys(FEATURES).filter(f => !on.has(f));
console.log(`${rel(OUT)}  ${kb(Buffer.byteLength(packed))}  (from ${kb(Buffer.byteLength(await readFile(SRC, 'utf8')))})`
  + (dropped.length ? `\n  without: ${dropped.join(', ')}` : ''));
