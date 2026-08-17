// Builds tinywebgpu.min.js — a production artifact with all diagnostics removed.
//
// Three mechanisms, because one is not enough:
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
//      nothing does, and no `_`-prefixed property appears in API.md. The two staging hooks are
//      reserved because test/layout.test.mjs stubs them by name when run against this build.
//
// Errors still throw in the minified build — only the reporting is gone.
//
// Usage: npm run build:min

import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const SRC = 'tinywebgpu.js';
const OUT = 'tinywebgpu.min.js';
const NEEDLE = 'const DIAG = true;';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const source = await readFile(SRC, 'utf8');

// Fail loudly rather than silently shipping a build that still carries the formatter.
const hits = source.split(NEEDLE).length - 1;
if (hits !== 1) {
  console.error(`build-min: expected exactly one \`${NEEDLE}\` in ${SRC}, found ${hits}.`);
  console.error('The DIAG declaration moved or changed shape — fix the anchor before releasing.');
  process.exit(1);
}

const { code, warnings } = await transform(source.replace(NEEDLE, 'const DIAG = false;'), {
  loader: 'js',
  format: 'esm',
  minify: true,
  drop: ['console'],
  mangleProps: /^_/,
  // Reserved because test/layout.test.mjs reaches for them by name when run against this build:
  // the staging pair is stubbed out, and the texel-size derivation is asserted directly.
  reserveProps: /^_(acquireStaging|releaseStaging|texelBytes)$/,
  legalComments: 'none',
  banner: `/*! TinyWebGPU ${pkg.version} | MIT | github.com/lampmaker/tinywebgpu */`,
});
for (const w of warnings) console.warn('build-min:', w.text);

// Guard against a future refactor quietly reintroducing either of them.
for (const [what, re] of [['console call', /console\s*\./], ['compile-log formatter', /WGSL Compile Log/]]) {
  if (re.test(code)) {
    console.error(`build-min: ${what} survived into ${OUT} — the strip did not work.`);
    process.exit(1);
  }
}

await writeFile(OUT, code);

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log(`${OUT}  ${kb(Buffer.byteLength(code))}  (from ${kb(Buffer.byteLength(source))})`);
