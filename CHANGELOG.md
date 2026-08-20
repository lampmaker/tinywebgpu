# Changelog

All notable changes to TinyWebGPU. Semver; pre-1.0, minor versions may break API.

## Unreleased

**Changed — `G.pre` is gone; `G.defines` is WGSL's missing `#define`, built into the core**
(min +149 B → 15.8 KB, tiny +140 B → 8.9 KB)

The optional `G.pre` hook and the `shorthand()` expander module are folded into one always-on
mechanism. `G.defines` is a string of `TOKEN replacement` entries (commas or newlines between
entries; replacements may contain spaces, not commas), expanded whole-word, longest token
first, in every shader compiled — the default `''` rewrites nothing, so stock behavior is
unchanged. Compose by appending: `G.defines += '\nRAY MyRay'`. `wgsl_shorthand.js` is gone —
a table is just a string, so there is nothing left to import; the tutorial and API.md carry a
ready-made one. The tutorial gained a step introducing defines, and its examples now write
`FLOAT` / `VEC2` / `VEC4` instead of the angle-bracketed long forms.
`show()`/`generateMipmaps` memoize per defines *value* (a string compare — previously `G.pre`
was tracked by function identity). The build-time `shorthand` option now seeds the `defines`
default instead of splicing in a second expander; in such a build the seeded tokens are
load-bearing (the library's own WGSL ships compressed to them), so append to `G.defines`
rather than replacing it.

**Build — the artifacts export the factory directly, and shed a few more bytes**

esbuild's `let yt=…;export{yt as WEBGPU}` alias is spliced out after minifying — the artifacts
now read `export let WEBGPU=()=>{…}` (the `--iife` flavour assigns `globalThis.WEBGPU`
directly). The name-table pack's `let[$a,…]` declaration moved inside the factory body, so
nothing leaks into module or script scope. Three internal option keys that had missed the `_`
prefix (`emitUniform`, `isCompute`, `targetNames`) now mangle away, the pack no longer
miscounts `dispatchWorkgroups` inside `dispatchWorkgroupsIndirect`, and the opt-in RENAMES
table gained `pipeline`, `count`, `instances`, `wgsl`, `uniformBuffer`, `uniformWrite`.

**Changed — pipeline creation is synchronous; the shader and pipeline caches are gone**
(min −626 B → 15.7 KB, tiny −592 B → 8.8 KB)

Every WebGPU call on the pipeline path is synchronous by spec — `createShaderModule`,
`createRenderPipeline`, `createComputePipeline` — and the one `await` the library had there,
`getCompilationInfo()`, existed only to format the compile log. That log is now fire-and-forget:
the module comes back immediately and DIAG builds report warnings and errors asynchronously
with the same pretty source window, while a bad module also fails pipeline creation, which the
DIAG validation scope reports — so nothing fails silently in any build. The upshot:
`makeFrag` / `makeDraw` / `makeCompute` / `makeQuad` / `makeCompute2D` / `makeShader` / `show` /
`generateMipmaps` all **return their result directly, not a promise** — the pipeline is usable
on the next line, and pieces never await a factory. Only the genuinely async paths keep their
promises: `init` (adapter/device), `loadTexture` (fetch/decode), and the readbacks
(`.r()`, `readTexture`, `save`). Existing code that `await`s a factory keeps working — awaiting
a non-promise is a no-op — so this is a soft break; just drop the `await`s. Error 3
(“WGSL compilation failed”) is retired: you can no longer try/catch a bad shader at the call
site; the failure surfaces as the pipeline-creation validation error instead.

With the values no longer promises, the shader and pipeline caches earned their keep even less
and are **removed entirely** — along with the FNV-1a hash that keyed them. The caches only ever
deduplicated the GPU objects (the wrapper, uniform buffer and bind-group state were always
built fresh per call), so no API semantics change: pieces that create each pipeline once at
startup — all of them — see no difference, and a piece that generates evolving WGSL no longer
leaks every generation's pipeline into an unbounded cache. The one internal dependant,
`generateMipmaps`, now memoizes its blit pipeline per format itself (tracking `G.pre` by
identity, exactly like `show()`'s blit cache). `G.pre` no longer needs to be deterministic —
nothing keys on its output anymore; install a new function to change it rather than mutating
one the memos captured.

**Changed — repeated strings hoisted into shared constants** (min −101 B → 16.3 KB, tiny −35 B → 9.4 KB)

The WGSL fragments the generated shaders repeat — `vec2<f32>`, `vec4<f32>`, `vec3<u32>`,
`@builtin(` — are spelled once and interpolated; the result is byte-identical WGSL, so shader
hashes and compile-log line numbers are untouched, only the JS shrinks. Likewise `'string'`
(the typeof checks), `'clamp-to-edge'` (the sampler defaults), and the storage address space,
now composed as `` `<storage, read${ro ? '' : '_write'}>` ``. Everything else the string
profile surfaced repeats by less than a declaration costs — hoisting `'load'`, `'auto'` or
`'nearest'` would grow the build — and the remaining repeats are property names, which the
opt-in `rename`/`pack` builds already shorten. Also added `createBuffer` and
`copyExternalImageToTexture` to the rename blocklist: platform members that were not listed
because they are not pack candidates, but that a rename table must still never touch.

**Changed — the configs' `features` is a true/false map, one description line per feature**

`build.min.config.mjs` / `build.tiny.config.mjs` now spell the feature switches as
`{ msg: true, texio: true, … }` with a one-line comment on each entry saying what it guards —
flipping a feature is editing a boolean, not editing a list. `--with`/`--without` still
override per run, a plain array of names is still accepted in custom configs, and the built
artifacts are byte-identical.

**Changed — expression bodies everywhere a `return` could go** (min −266 B → 16.4 KB, tiny −143 B → 9.5 KB, on top of the repeat pass below)

The minifier merges statements into sequences but never removes a `let`, never converts a
loop, and keeps `return` whenever a body is not a single expression — so those are hand-work:
block-bodied functions became expression arrows (trailing parameters as locals, `&&`/ternary
for `if`, comma for `;`, `forEach` for `for…of`), taking the output from 35 `return`s to 16 in
the stock build and 21 to 8 in tiny. What keeps a block keeps it for a reason: `try`/`catch`
(`beginFrame`, `frame`, `endPass`, `checkSize`), string-building loops (`hash`,
`uniformWrite`, the compile-log formatter — now an IIFE so DIAG builds can strip it from
expression position), and the `WEBGPU()` factory itself. Also folded in passing: `show()` and
`makeQuad` lean on `drawTo`'s clear fallback instead of restating `[0, 0, 0, 1]`, and
`loadTexture`/`writeTexture` reuse the shared `sz(w, h)` extent helper.

**Changed — a repeat-hunting pass over the minified output** (min −775 B → 16.7 KB, tiny −552 B → 9.6 KB)

`find-repeats.mjs` (suffix-array repeat finder, now in the repo) profiled the builds; every
structural duplicate it surfaced is deduplicated *in the source*, so the readable file and the
artifacts improved together:

- The flipped `const F_X = false` switch declarations no longer ride along in the output —
  esbuild's transform API skips top-level dead-code removal by default, so every *use* was
  folded but the declaration row survived; `treeShaking: true` removes it (~0.1 KB).
- `makeFrag`/`makeDraw` now spread their options through to makePipeline instead of restating
  every default (`uniforms = {}`, `resources = {}`, `count = 3`, `topology`, …) at each layer —
  the defaults are spelled once, in makePipeline. Same public API and behavior.
- One spelling each for: the queue-write tail (buffer `w()` now funnels through
  `writeUniforms`), the dispatch plumbing (`run()` calls `dispatch()` with the workgroup
  division), the blend component shape and its shared `one-minus-src-alpha` factor, the
  `{module, entryPoint}` stage descriptor, the texture-copy destination + width/height
  defaults (`writeTexture`/`readTexture`/`save`), the `@group @binding var` prefix in
  generated WGSL, the mip-level view in `generateMipmaps`, the hash cache key, and the
  bytes-per-texel error text. `loadTexture`'s three decode paths converge on one
  `createImageBitmap` call.
- Small inlines: `GPUMapMode.READ` → its normative `1` (like the usage flags),
  `navigator.gpu` read once in `init`, `drawTo`/`makeQuad` lean on the existing
  `[0, 0, 0, 1]` clear fallback instead of restating it as a parameter default, and the
  generated `@workgroup_size(${wg})` renders as `x,y,z`.

**Changed — build settings moved into config files; single-line output; pack legend**

- Each build's settings now live in a config file — `build.min.config.mjs` and
  `build.tiny.config.mjs` — picked by name: `node build-min.mjs tiny` (default `min`;
  `--config=path` for your own; `--tiny` still accepted). `build-min.mjs` keeps only the
  machinery: the feature registry, the `ERRORS` table, and the transforms. CLI flags
  (`--out=`, `--with=`, `--without=`, `--iife`, `--pack`/`--no-pack`, `--no-banner`)
  override the config per run.
- Both artifacts are now a **single line**: the raw newlines esbuild leaves inside template
  literals (the embedded WGSL) are escaped to `\n` after minifying (`singleLine` in the
  config). Semantics unchanged — the strings are identical at runtime.
- The tiny build ends with a **pack legend** — `/*pack:$a=beginComputePass,…*/` — naming what
  the name-table pass packed (`packComment` in the config), so the packed output reads without
  the build script at hand.
- New opt-in `rename` config (and `--rename` / `--rename=name:code,…`): truly rename the
  library's *own* API in a piece build — `setResources` → `sR`, `resources` → `rS`,
  `createStorageBuffer` → `cSB` — via esbuild's mangleCache, so a piece written against the
  renamed build saves the bytes on both sides of every call (~10 B per `setResources` site; the
  library's internal savings roughly pay for the legend). The table is `RENAMES` in
  `build.tiny.config.mjs`; the `/*renamed:sR=setResources,…*/` legend appended to the output is
  the renamed build's API contract, trimmed to the names that survived the feature strip.
  Platform member names (`createRenderPipeline`, …) and WebGPU dictionary keys (`format`,
  `buffer`, …) are refused with an explanation — the browser owns those names; the name-table
  pack aliases them instead, and the new `packNames` config picks mnemonic pack codes
  (`{ createRenderPipeline: 'cRP' }` → `[cRP](`) at ~1 B per use over the `$x` defaults.
  The stock artifacts keep the long names; `npm run test:all` now also builds a renamed tiny
  and runs `test/rename.test.mjs` against it.
- New opt-in `shorthand` config: build a wgsl_shorthand token table into the library. Its own
  WGSL then ships compressed (`V` for `vec2<f32>`, …) and the piece's WGSL may use the same
  tokens without shipping `wgsl_shorthand.js` — a `const SHORTHAND = 0;` seam in the source is
  swapped for an expander that runs on every shader at compile time. Off in both stock
  configs: measured on the bare tiny build the expander costs ~145 B against 93 B of internal
  string savings, so it pays only once your own WGSL uses ~7+ tokens. Schema type strings are
  never expanded.

**Changed — `0` is the library's empty value, not `null`** (breaking only if you compared with `===`)

Every internal "nothing here" sentinel is now `0` instead of `null`: one byte instead of four in
the raw builds (the stock build drops ~0.4 KB, tiny ~0.4 KB), and every check is a plain falsy
test. Observable edges of that change:

- `G.context` / `G.format` / `G.features` are `0` before `init()`, and `G.device` is `0` after
  `destroy()`. `G.pre` and `G.onDeviceLost` default to `0` (assigning `null` still works — all
  checks are falsy tests).
- `makeSchema(...)` returns `uniformBuffer: 0` when there are no uniforms, and its internal
  `_uniformBinding` is `-1` (not `null`) when no uniform binding is emitted — `0` is a real
  binding number, so that one keeps a numeric sentinel.
- Everywhere the API *accepted* `null` (a skipped `view`, `encoder`, `blend`, `Ctor`…), `0`,
  `null` and `undefined` are all fine — pass whichever is shortest. The d.ts spells this
  `None = 0 | null | undefined`.
- If you compared against `null` (`G.device === null`, `_resolveBlend(x) === null`), switch to a
  falsy check; that is the whole breaking surface.

The same pass rewrote block-bodied arrows to expression bodies (comma sequences, trailing
parameters as locals) where a `return`/`{}` could be dropped, and replaced nullish operators
that guarded the old `null` sentinels: `??`/`??=`/`?.` do not treat `0` as empty, so those are
now `||`/`||=`/`&&`.

**Added — a build picker on every demo page**

The tutorial, the demo index and all eight examples now take `?lib=full|min|tiny` and load that
build, with a picker in the corner of each page and the choice carried across the links between
them — so every page doubles as a smoke test of the build it claims to run on. The stock tiny
build drops whole entry points, and the pages are honest about it: a page that needs a dropped
feature shows a warning strip, the picker marks the tiny option with `*` and names what is
missing, and a tutorial box whose code uses readback, `resizeCanvas`, textures or a named blend
preset says "not in tiny" instead of dying on a TypeError (the check runs against the live
editor content, so deleting the offending call makes the box runnable again). Tiny's numbered
errors are translated back to text in the tutorial's output panels. The shared logic lives in
`libselect.js`, next to the pages; the published npm package is unchanged.

**Changed — `wgsl_shorthand.js` token tables are strings** (breaking for the companion module)

`TOKENS` and `SHORT_TOKENS` are now plain strings — entries separated by commas or newlines,
each one `TOKEN replacement` — and `shorthand(defs?)` takes exactly one such string. Composing
tables is string concatenation: `shorthand(TOKENS + SHORT_TOKENS)`, custom additions are
`shorthand('RAY MyRay\n' + TOKENS)`. The old `shorthand(...maps)` object-merging form is gone;
the expansion behavior (word boundaries, longest token wins, deterministic) is unchanged.

**Changed — smaller inline builds (for on-chain / embedded pieces)**

The tiny build drops from 11.4 KB to **10.4 KB** raw (5.2 gz), the stock build from 18.3 KB to
**17.8 KB** (8.2 gz). Raw bytes are the target: the inline/on-chain use-case never gzips.

- **New switch `staging` (0.5 KB)** — the staging ring behind frame-ordered writes. Without it,
  writes inside `beginFrame()` become plain queue writes: the *last* value set before
  `endFrame()` wins for the whole frame. Pieces that set uniforms once per frame (most
  fullscreen art) never see the difference; per-dispatch uniform sequences keep the switch.
  `--tiny` drops it; `--with=staging` brings it back. Verified on-device both ways.
- **New switch `aliases` (0.1 KB)** — the long spellings (`buffer`/`write`/`read` on handles,
  `uniformFields`/`resourceFields`). The short forms (`b`/`w`/`r`) always exist.
- **`err(n, MSG && 'text')` shared-throw helper** replaces 22 inline `throw Error(MSG ? … : n)`
  sites. The `MSG &&` stays at the call site on purpose: a function argument can never be
  dead-code-eliminated, so this is the only shape that still lets a msg-less build fold every
  message string away. build-min's error-code audit now matches this shape.
- **`U8`/`AB` constructor aliases and `mkBuf`/`len` wrappers** — `Uint8Array`, `ArrayBuffer`,
  `D.createBuffer` and `.byteLength` were the most-repeated unminifiable names left.
- **Internal layout fields are `_`-prefixed** (`_binding`, `_wgslType`, `_isBuf`, …) so
  `mangleProps` renames them; the never-read `size` field is gone.
- **Name-table pass in build-min.mjs** (tiny builds by default; `--pack`/`--no-pack` override):
  repeated long WebGPU member names are rewritten to bracket reads from one packed string. A
  name is rewritten only when *every* occurrence in the output is a member access — one
  appearance as an object key or in a string disqualifies it, so API contracts cannot change.
  Honest numbers: after the source-level dedup, little repetition is left to pack (−3 B tiny,
  −33 B with `--pack` on the stock build) — the pass is kept because it is self-guarding and
  pays more as code grows. WGSL token compression was measured and rejected: expander + map
  overhead ≈ the ~120 B of remaining generated-shader text it would save.

**Added — ease of use, from the user's chair**

- **TypeScript declarations.** `tinywebgpu.d.ts` ships with the package and is wired through
  `types`/`exports`, so editors autocomplete the whole surface with inline docs — in TypeScript
  and plain-JS projects alike. Zero runtime bytes. The `GPU*` names come from TypeScript's own
  `lib.dom` (recent versions ship WebGPU); older TS setups add `@webgpu/types`.
- **Mipmaps** (`F_MIPS`, 0.5 KB; `--tiny` drops it). `createTexture(w, h, fmt, { usage, mips })`
  allocates a mip chain (`true` = full, a number = that many levels), `generateMipmaps(tex)`
  fills it from level 0 by successive linear-filtered blits in one submit, and
  `loadTexture(src, { mips: true })` does both. Verified on-device: the 1×1 tail of a
  red/green/blue/white 2×2 comes back as the exact average grey.
- **`init()` takes a canvas, an OffscreenCanvas, or a CSS selector** as well as a ready
  `'webgpu'` context — `init('#c')` replaces the `getContext` boilerplate in every first line.
  A selector that matches nothing throws saying so (error 23).
- **`buf.r(Float32Array)`** — pass the constructor as the only argument to read the whole
  buffer typed, instead of spelling out `r(nbytes, 0, Float32Array)`.
- **`G.frame(fn, opts?)`** — `beginFrame`/`endFrame` around a callback, exception-safe: the
  frame is submitted even if `fn` throws, so one bad frame cannot leave a dangling encoder.
- **`G.destroy()`** — tears the instance down: destroys the device, the staging ring, the
  readback pool and the depth textures, and empties the caches. SPAs, hot-reload dev servers
  and live-coding pages stop leaking a device per reload. Intentional destruction no longer
  logs a device-lost error or fires `onDeviceLost`.
- **`show()` infers the target format** from a `GPUTexture` target, so
  `show(hdr, floatTarget)` works without an explicit `format`.
- **`makeQuad` forwards every `makeFrag` option** — `targets` and `depth` included, not just
  `format` and `blend`.

**Fixed**

- **`setResources` with a `GPUTextureView` threw in DIAG builds.** The resource validator's
  heuristics only recognized textures; a view — explicitly documented as accepted — has no
  marker properties at all and was reported as a mismatch. Views are now recognized by
  `instanceof`. (Found because `generateMipmaps` binds per-level views.)

**Added — depth testing**

- **`makeDraw({ depth })` / `makeFrag(…, { depth })`.** `depth: true` adds a `depth24plus`
  buffer with `less` compare and depth writes on; the depth texture is created lazily, sized to
  the render target, pooled by size, and shared by every depth-enabled pipeline drawing into the
  same target, so multi-pipeline scenes depth-test against each other with nothing to wire up.
  `drawTo(view, 'load')` keeps the depth buffer along with the colour. Overridable field by
  field: `{format?, compare?, write?, texture?}` — `texture` hands over your own attachment.
  Depth state is part of the pipeline cache key. New build switch `depth` (0.6 KB); `--tiny`
  drops it. Because the auto-managed texture needs the target's size, draw to the canvas or pass
  a `GPUTexture` (not a raw view) to `drawTo`, or supply `depth.texture` — a view the library
  has never measured throws asking for one of those.

**Fixed**

- **Byte-alignment failures on real devices that the stubbed tests could not see.** WebGPU
  requires 4-byte-multiple sizes and offsets on `writeBuffer` and `copyBufferToBuffer`; four
  paths passed unaligned values straight through: `w(data)` outside a frame with an unaligned
  `byteLength` (inside a frame it already worked — the beginner path and the fast path
  disagreed), `createStorageBuffer(data)` create-and-fill with unaligned data, `w(data, offset)`
  outside a frame with an unaligned offset (staged writes already threw a clear error; the queue
  path let the driver reject it), and `.r(nbytes)` with an unaligned count. Writes and readback
  copies are now padded to 4 bytes (readbacks trimmed back to what was asked); an unaligned
  *offset* throws the same named error on both paths.
- **`makeCompute` with a partial `wg` array generated invalid WGSL** — `{wg: [64]}` interpolated
  `@workgroup_size(64, undefined, undefined)`. Missing axes now default to 1, matching what
  `run()` already assumed.
- **A schema name mentioned only in a WGSL comment counted as referenced.** `layout:'auto'`
  parses real WGSL, so the binding was emitted, stripped by the driver, and the bind group
  rejected with a validation error. Comments are stripped before the reference test, so the
  case is now impossible rather than diagnosed after the fact.
- **`setResources` with a name that is not in the schema vanished in silence** — the resource
  twin of the unknown-uniform trap fixed earlier. It now throws and lists the declared names.
  (A name that is declared but unused by the shader is still accepted silently, as before.)
- **Two concurrent builds of identical pipeline source each created a GPU pipeline.** The
  pipeline cache now stores the promise, as the shader cache always did, so they share one.
- **`show()`'s blit cache ignored `G.pre`** — swapping the preprocessing hook between calls
  could return a pipeline compiled under the previous hook. The cache entry now remembers which
  `pre` built it.
- **A mid-chain staged write reopened the `beginCompute()` pass with a bare descriptor**,
  dropping e.g. `timestampWrites`. The reopen now reuses the descriptor `beginCompute` was given.
- **`loadTexture(url)` on a failed fetch threw an opaque `createImageBitmap` decode error.** It
  now reports the HTTP status and the URL.
- **`makeCompute2D`'s `run()` dropped its `encoder` argument**, so it could not record onto a
  caller's encoder the way every other dispatch call can.
- The README's texture example sampled with the raw generated uv, which displays an image
  upside down (uv.y is 0 at the *bottom* of the screen; an image's first row is texture v = 0).
  The example flips v, and the sharp-edges list, `loadTexture` docs and example 5 now spell the
  convention out.

**Changed — performance**

- **Bind groups are cached per resource combination** (up to 8 per pipeline, keyed on resource
  identity). A ping-pong simulation used to build a fresh `GPUBindGroup` every swap, every
  frame, forever; it now builds two, total, and swaps between them.
- **`dispatchIndirect` accepts the `createIndirectBuffer()` handle** as well as a raw
  `GPUBuffer`, matching `setResources`.
- **`createSampler` forwards the full descriptor** — `mipmapFilter`, `wrapW` (→ `addressModeW`),
  `compare`, `maxAnisotropy` and the lod clamps pass through instead of being dropped, so
  comparison and anisotropic samplers no longer need `G.device.createSampler`.
- **`readTexture` types `*16float` readbacks as `Float16Array`** where the platform has it
  (raw `Uint16Array` half bits otherwise).

**Changed — source**

- **`let` everywhere** (the eight build switches stay `const` — esbuild constant-folds a
  `const` literal and not a `let`, and the dead-code elimination behind the tiny build depends
  on that fold).
- Deduplicated: one `tex2d` helper behind `createTexture`, `createStorageTexture` and the depth
  pool; one `readBack` helper behind buffer `.r()` and `readTexture`; one `oneShot`/`onEncoder`
  pair behind every self-submitting dispatch, draw, clear and readback; `asView` hoisted next to
  `viewOf` and shared by `drawTo` and the bind-group builder; `createStorageBuffer` builds on
  `createBuffer` instead of repeating it.

**Reorganized — `tinywebgpu.js` reads top-down now**

The file was one 630-line object literal with the public API, the `_`-prefixed internals and the
schema engine interleaved, and the headline pipeline builders bolted on underneath it. It is now
split in two: a `PUBLIC API` literal holding everything a user calls, ordered roughly by how often
you reach for it (device → pipelines → frames → buffers → textures → ping-pong → canvas → escape
hatches), then an `INTERNALS` half with the plumbing, the schema engine and the pipeline factory.
Internals that used to hang off the instance are closure consts, which also shaves the stock build
from 16.1 KB to 15.8 KB — a closure variable minifies to one character, `S._foo` does not.

**Renamed** (breaking; nothing is published yet)

| Was | Now | Why |
|---|---|---|
| `makeRender` | `makeFrag` | `makeRender` and `makeDraw` both render; `makeFrag` names what you supply |
| `drawQuad` | `makeQuad` | it is a factory returning `{…, run()}`, it does not draw |
| `compute2D` | `makeCompute2D` | same, and it pairs with `makeQuad` |
| `makeUniformsAndResources` | `makeSchema` | it builds the dual schema |
| `createTexture2D` | `createTexture` | no 1D/3D sibling for the suffix to distinguish |
| `createStorageTexture2D` | `createStorageTexture` | ditto |
| `createPingPongTexture2D` | `createPingPongTexture` | ditto |
| `createDispatchIndirectBuffer` | `createIndirectBuffer` | the only indirect buffer kind here |

`makeRenderPipeline` and `makeComputePipeline` are gone from the instance. They collided with
`makeFrag`/`makeCompute` by name and added nothing over `G.device.createRenderPipeline`, which is
still reachable through `G.device`.

**Changed — compute chaining is automatic**

`p.dispatch()` / `p.run()` / `p.dispatchIndirect()` now join the pass `beginCompute()` opened
instead of closing it and starting their own, and rebind only when the pass is holding a different
pipeline. `p.use()`, `p.dispatchOn()` and `p.dispatchIndirectOn()` are removed — the chained form
is just the ordinary call:

```js
G.beginCompute();
a.dispatch(64); a.dispatch(64); b.dispatch(64);   // one pass, two setPipeline calls
G.endCompute();
```

`p.bindTo(pass?)` replaces `use()` as the escape hatch for a compute pass you opened yourself.
`drawTo()` still closes an open chained pass, since a render pass cannot nest inside one.

**Fixed**

- A staged write (`setUniforms`, `w()`, `clear()`) *before* the first dispatch of a chained
  sequence left the compute pass closed for the rest of the chain: `fBound?.(fPass = …)`
  short-circuited its own argument when nothing had been bound yet, so the reopen never ran.

**Added**

- Buffer handles carry readable aliases: `createStorageBuffer` returns `{ b, w, r, clear }` plus
  `buffer`, `write` and `read` pointing at the same functions, and `createBuffer` returns `{ b, w,
  buffer, write }`. Both spellings work; the short ones are unchanged.

- **`G.show(tex, view?, opts?)`** — draw a texture onto a target. The shortest path from a compute
  result to pixels, and it reads with `textureLoad` rather than a sampler on purpose: `rgba32float`
  and the other unfilterable formats — exactly what a GPGPU pass writes — are rejected outright by
  a sampler. `scale`/`offset` tone-map on the way through. Orientation is source-row-0 to
  target-row-0, so images come out the right way up and `show(a, b)` round-trips through
  `readTexture(b)`; `flipY: true` opts back into the raw uv.
- **`G.save(tex, filename?, opts?)`** — download a texture as PNG/JPEG/WebP, or take the `Blob`
  with `download: false`. BGRA channels are swapped for you. No tiling: render as large as
  `maxTextureDimension2D` allows and save once.
- **Ping-pong pairs** — `createPingPong(bytesOrData)`, `createPingPongTexture(w, h, format?)` and
  the general `pingPong(make)`, each returning `{read, write, swap()}`. Seeding from a TypedArray
  fills both halves, so a swap before the first step is harmless.
- **Multiple render targets** — `makeFrag(frag, u, r, { targets: { name: format, … } })` generates
  the `struct FSOut` with its `@location` indices in key order, and `drawTo({ name: view, … })`
  binds them by name. A single target keeps the plain `-> vec4<f32>` contract.
- **Every `matCxR<f32>` uniform**, not just `mat4x4`. The type table became arithmetic on the type
  string, so `mat2x2` … `mat4x3` all work; a 3-row matrix has its columns written onto the 16-byte
  stride WGSL requires, so you pass 9 tightly packed numbers for a `mat3x3<f32>`.
- **`init(ctx, { canvasUsage })`** — swapchain usage flags, so adding `COPY_SRC` makes the canvas
  texture itself readable and saveable.
- **`G.makeDraw({ code, … })` — your own vertex stage.** The sibling of `makeCompute` for geometry
  that is not a fullscreen quad: `code` is complete WGSL, both `@vertex fn vs_main` and
  `@fragment fn fs_main`, and the only thing prepended is the schema, exactly as for compute. You
  keep the dual schema, `drawTo`, the frame API and the pipeline cache. `count` (vertices per
  instance), `instances` and `topology` are options and, for the first two, writable properties on
  the result — a per-frame particle count does not rebuild the pipeline. `topology` is part of the
  cache key, since two pipelines with byte-identical WGSL and different topologies are different
  pipelines. `makeFrag` is now literally this call with the fullscreen vertex stage filled in,
  which is why adding the entry point cost −113 bytes: the duplicated `FSOut` generation went.
- **`readOnly: string[]` on `makeDraw`** binds the named resources `var<storage, read>` instead of
  `read_write`. This is not a nicety: WebGPU forbids a read-write storage binding from being
  visible to the vertex stage, so *every* vertex-pulled buffer needs it, and without it pipeline
  creation fails with a bind-group layout error that does not point back at the schema. Resources
  only the fragment stage touches are unaffected.
- **Example 8, `8_heightmap.html`** — a flat-shaded 3D terrain, and the first example to draw
  something that is not a fullscreen quad. A compute pass writes heights into a storage buffer;
  `makeDraw` reads the same buffer back in the vertex stage with `readOnly`, one instance per grid
  cell and six vertices each. Every vertex rebuilds its whole facet so all three agree on the face
  normal, which is what makes the shading flat. It checks its own arithmetic on load, holding the
  GPU's heights against a JS transcription of the same function. Known limitation it works around:
  the library has no depth attachment, so cells are drawn back-to-front — exact for a height field
  as long as the camera stays outside its footprint, which the orbit guarantees.
- **No vertex buffers, deliberately.** Geometry is pulled from a storage buffer indexed by
  `@builtin(vertex_index)` / `@builtin(instance_index)`. That keeps a second layout language out
  of the library and lets a compute pass write the geometry a draw then reads with no plumbing
  between them. Cost of the whole feature: +484 bytes on both the minified and tiny builds
  (+377 threading topology/count/instances through, +107 for `readOnly`).

**Changed**

- **An unreferenced schema entry is no longer declared at all.** It used to be emitted, stripped by
  `layout:'auto'`, then detected by regex so its bind-group entry could be filtered back out. Now
  the schema is filtered before anything is generated, so the WGSL, the binding numbers and the
  bind group agree by construction. The console warning stays. Unreferenced *uniforms* keep their
  buffer and setters — only the binding goes — so `setUniforms` on a shader that ignores `UB` still
  works instead of throwing.
- **Bytes-per-texel is derived from the format name** instead of tabulated, which added
  `r16unorm`, `r16snorm`, `rg16unorm`, `rg16snorm`, `rgba16unorm`, `rgba16snorm` and `rgb10a2uint`.
  Every copyable colour format WebGPU has is now covered, so `writeTexture`/`readTexture` stop
  demanding an explicit `bytesPerRow` for them.
- **Uniform writes resolve their destination view and integer coercion once**, at layout time,
  rather than running two regexes per field on every `setUniforms()` call.
- **One pass-execution path.** `dispatch`, `run`, `dispatchIndirect` and `drawTo` all go through a
  single `runPass`, so the encoder/pass lifecycle exists in one place instead of three.
- **The minified build is smaller and strips more.** `mangleProps` renames the internal
  `_`-prefixed properties, `DIAG` now also folds away the resource validator, the buffer-size
  check and every debug `label`, and the spec-fixed usage flags are named constants the minifier
  can inline. Net of the features above: 19.0 KB → 18.2 KB raw.
- **…and smaller again, by 2.2 KB raw, for inline use.** This reverses the call recorded above.
  Binding hot paths to short locals really does buy almost nothing gzipped — the measurement
  stands, and it is repeated in the README — but the case it was rejected for was HTTP delivery.
  Inlining the library into a single HTML file, an on-chain artwork especially, is a *raw* byte
  budget, and there gzip never runs. So the frame state (`S.frame.encoder` and friends), the
  device, the shader and pipeline caches and the staging ring moved into closure variables the
  minifier renames to one character each; `createCommandEncoder` and `queue.submit` are spelled
  once, behind `mkEnc` and `submit`; `Object.entries`/`keys`/`assign`/`values` are aliased; the
  three blend presets are built from a two-argument helper instead of written out; the schema
  result's internal fields are `_`-prefixed so `mangleProps` reaches them, and `makePipeline`
  destructures the ones it reads on every dispatch. Debug `label`s went from `label: DIAG ? … :
  void 0` to a `...(DIAG && { label: … })` spread, which leaves nothing behind at all rather than
  `label: void 0`. Two validation error scopes, the `onuncapturederror` handler and the
  dropped-feature filter are now DIAG-gated too, since their entire purpose was to log.
  18.2 KB → 15.7 KB raw, 7.4 KB → 7.0 KB gzipped. No API change. (`makeDraw` above has since
  added 0.5 KB back, for 16.1 KB.)
- **`beginFrame()` no longer returns the internal frame object**, and `G.frame` is gone with it —
  the frame state is closure variables now. Neither was documented or used; `beginFrame()` returns
  nothing.
- **`makeSchema()` keeps `wgsl`, `uniformBuffer` and `uniformWrite`** on its result
  and renames the rest to `_entries`, `_uniformFields`, `_resourceFields`, `_resourceLayout` and
  `_uniformBinding`, so the minified build can shorten them. The unused `uniformVar` is dropped.
  This is the schema-engine escape hatch; the three names anything realistically reads are the
  three that stayed. `p.uniformFields` / `p.resourceFields` on a pipeline are unchanged.

**Added — build**

- **`npm run build:tiny` → `tinywebgpu.tiny.js`, 10.7 KB** (4.9 KB gzipped), for inlining into a
  single file. `tinywebgpu.js` now carries a row of `const NAME = true;` switches; `build-min.mjs`
  rewrites the ones you name to `false` and dead-code elimination removes what they guard, so the
  code is gone from the bundle rather than merely unreachable. `--tiny` drops all of them,
  `--with=` keeps named ones, `--without=` removes named ones from an otherwise full build, and a
  feature that another one depends on is kept with a warning instead of producing a build that
  throws. The optional groups are `texio`, `read`, `save`, `show`, `pingpong`, `resize`, `blend`
  and `msg`; everything else — init, the dual-schema engine, the pipelines, buffers, textures,
  samplers, the frame API and frame-ordered writes — is always in. Per-switch savings are
  tabulated in the README.
- **`--iife` and `--no-banner`.** `--iife` emits a classic script assigning `globalThis.WEBGPU`,
  for embedding contexts that cannot give you `<script type="module">`; the export is rewritten by
  hand rather than through esbuild's `globalName`, which would spend ~450 bytes on CommonJS
  interop to hand over one function. Together with `--tiny` that is 10.4 KB.
- **`--without=msg` folds every error message down to a number** (`Error: 15`), which is 1.1 KB of
  the tiny build. `--tiny` implies it. The numbers are listed in the `ERRORS` table in
  `build-min.mjs`, and the build fails if a number is reused or goes undocumented.
- **`npm run test:tiny`** builds a feature-reduced bundle and runs the suite against it, so the
  switches are covered rather than assumed. `npm run test:all` runs source, minified and tiny —
  260 assertions across the three.

**Added — tests**

- **`test/frame.test.mjs`** — the encoder/pass lifecycle, which the aliasing pass rewrote and
  which nothing was covering. The device stub records the GPU command stream in order, so each
  case asserts the *shape* of what was submitted rather than that a call returned: how many
  encoders were opened, where the passes started and ended, that a staged write lands between the
  dispatches it separates, and that a pass torn down around that write comes back with its
  pipeline rebound. The sequences mirror the examples — `beginFrame` batching (3, 7), indirect
  dispatch inside a frame (4), and `beginCompute` + `use()` + `dispatchOn` with `setUniforms`
  between the dispatches (6), which is the sharp one. The whole file passes unchanged against the
  pre-refactor library, which is what makes it a regression test and not a description of the new
  code.
- **`test/tiny.test.mjs`** — runs against a fully stripped `--tiny` bundle: the optional entry
  points really are absent, the core still dispatches and draws, and `MSG=false` throws numbers.
  A feature guard drawn one line too wide would take part of `makePipeline` with it.
- **Blend presets are asserted explicitly** in `layout.test.mjs`, since they are now built from a
  two-argument helper rather than written out.

**Fixed**

- **`makeCompute2D` never ran anything.** It passed its `body` to `makeCompute` as *declarations* and
  generated an empty entry point, so the shader was invalid WGSL (statements at module scope) and
  `main` did nothing. `body` is now the entry-point statements, as documented; helper functions
  and structs go in the new `decls` field.
- **Uniform values given as TypedArrays wrote a single `NaN`.** The packer tested `Array.isArray`,
  so a `Float32Array` mat4 out of a maths library fell into the scalar path. Arrays and TypedArrays
  are now both accepted.
- **A uniform name that is not in the schema was silently dropped.** `setUniforms({ tiem: 1 })` did
  nothing at all, in any mode. It now throws and lists the declared fields.
- **`loadTexture` could not read a `<video>`.** A video element always *has* a `width` property, and
  it is `0` until the layout attribute is set, so the `??` chain picked the zero and never reached
  `videoWidth`. Sizes now fall through on falsy.
- **In-frame buffer writes could smear stale bytes.** Staged copies round up to 4 bytes, and the
  ring's padding was left holding the previous frame's data; the tail is zeroed now. A staged write
  at a non-4-byte offset also throws with the reason instead of failing in the driver.
- **`createBuffer` did not round its size up to 4 bytes** the way `createStorageBuffer` does, so a
  storage buffer made through it with an odd size was rejected by WebGPU.

**Changed**

- **Resources merge and compare by value.** `setResources` used to compare the object by reference
  and demand every field on every call — so a fresh literal per frame rebuilt the bind group every
  frame, and mutating a reused object silently did nothing. Partial updates are now legal, repeat
  calls with the same resources are free, and buffer handles (`{b,w,r}`) may be passed directly
  instead of unwrapping `.b` by hand.
- **The swapchain texture is acquired lazily**, on the first `drawTo()` of a frame rather than in
  `beginFrame()`, so a compute-only frame no longer touches the canvas. This also unwedges a real
  hang: on a page with a canvas, `beginFrame(); dispatch(); endFrame(); await buf.r()` could never
  resolve, because the frame had acquired a swapchain texture it then never presented.
- `createStorageTexture` takes a `usage` override and includes `COPY_DST` by default, so
  `writeTexture` works on it — matching `createTexture`.

**Added**

- **`p.run(w, h, d)` on compute pipelines** — dispatch by item count, dividing by the workgroup
  size and rounding up, instead of writing `Math.ceil(n / 64)` at every call site. `p.dispatch`
  still counts workgroups.
- **Resource validation checks usage flags**: a texture bound to a `texture_storage_2d` without
  `STORAGE_BINDING`, or a buffer bound to an `array<T>` without `STORAGE`, is named in the error
  rather than producing a wall of driver text. Dispatching before `setResources` now says which
  call is missing instead of "bind group 0 is not set".
- More formats in the texel-size table (`rgb10a2unorm`, `rg11b10ufloat`, the 8/16-bit int and
  snorm variants), so `writeTexture`/`readTexture` accept them without an explicit `bytesPerRow`.

- **`tutorial.html`** — a sixteen-step guided tour, from a single coloured pixel to a particle
  system. Every code box on the page is live: it is edited in place and recompiled against the
  reader's own GPU, with animation loops stopped when a box is re-run or scrolls out of view. The
  boxes share one device (a device per box would be a lot of memory for a page you scroll), so one
  canvas demo animates at a time. `window.__runAll()` runs every box and reports what broke.
- **`examples/6_evolution.html`** — differential evolution, a gradient-free global optimizer, run
  population-parallel: one thread per individual, no communication between them, and the whole
  population advanced in a single dispatch. The population is stored dimension-major so
  neighbouring threads read neighbouring addresses, generations ping-pong between two offsets in
  one buffer so the bind group is built once rather than once per generation, and trial vectors
  are generated, scored and stored one dimension at a time so nothing per-individual sits in
  registers. Finding the best individual is a workgroup-shared-memory tree reduction, since WGSL
  has no `atomic<f32>` to `atomicMin` a float fitness with. Four standard objectives — Rastrigin,
  Ackley, Rosenbrock, Schwefel — each with the crossover rate it actually needs, measured rather
  than assumed. Self-checks hold the WGSL objectives against an independent CPU implementation and
  then confirm the search reaches Rastrigin's optimum in 32 dimensions.
- **`examples/7_particles.html`** — up to 800k particles with no vertex buffers: the simulation
  splats each one into a density grid with an `atomicAdd`, and a fullscreen pass colours it, so
  the particle count is arithmetic rather than draw calls. Fade, simulate and draw go out in one
  submit; the grid follows the window through `resizeCanvas`. Its self-check asserts an exact
  splat count rather than eyeballing the picture.

**Changed**

- Examples 1–5 now carry a viewport meta and responsive CSS, so they lay out at the device width
  on a phone instead of at 980px scaled down. Canvases take the width they are given and keep
  their aspect ratio; the text-only examples wrap instead of scrolling sideways.
- `index.html` leads with the tutorial and lists the two new examples.

## 0.4.0 — 2026-08-08

Bug-fix release with two additions. Three of the fixes change behavior — read the first two if
you use `beginCompute()`.

**Fixed**

- **`beginCompute()` outside a frame silently dropped every dispatch.** It parked its command
  encoder on the frame slot and `endCompute()` never submitted it, so the chained dispatches never
  ran — *and every later `dispatch()`/`drawTo()` stopped self-submitting too*, because they saw an
  open frame that would never end. Readbacks then reported pre-frame data. `endCompute()` now
  submits the encoder it opened. A `beginCompute()` inside `beginFrame()` is unchanged: the frame
  still owns the submit.
- **A uniform or buffer write between two chained dispatches broke the pass.** Copies cannot be
  encoded inside a pass, so the staged write had to close it; the next `dispatchOn()` then threw
  `No active compute pass`. The pass is now reopened and the pipeline/bind group from the last
  `use()` re-applied, so per-dispatch uniforms — the pattern the frame API is *for* — work.
- **The pipeline cache was keyed on the source before `G.pre` ran**, while the shader cache keyed
  on the source after. Changing `G.pre` and rebuilding the same shader handed back the pipeline
  compiled under the previous hook. `G.pre` is now applied once, before the key is computed.
- **`createStorageBuffer(byteLength)` did not round up to 4 bytes** the way the create-and-fill
  path did, so odd sizes produced a buffer WebGPU rejects.
- **A pipeline that failed validation stayed in the cache**, so the second build of the same
  source silently reused it and reported nothing. It is now evicted.
- A schema resource the shader never references is stripped from the bind group (with a warning) —
  but resource validation still demanded you pass one. It no longer does.
- `w()` on a buffer handle now throws on a plain `Array` instead of writing `d.length` bytes of
  garbage; it takes a TypedArray or ArrayBuffer.
- `drawTo()` / `drawQuad().run()` with no canvas context raised a null-deref `TypeError`; they now
  say what is wrong.
- Bind-group rebuilds reuse a memoized `createView()` per texture instead of allocating a new view
  every time.

**Added**

- **`G.readTexture(tex, opts?)`** — pixels back out of a texture, the mirror of `writeTexture` and
  the texture counterpart of `createStorageBuffer().r()`. Handles the 256-byte `bytesPerRow`
  alignment and returns tightly packed rows, typed from the format. Same caveat as `.r()`: it
  stalls the pipeline.
- **`G.resizeCanvas(canvas?, opts?)`** — sizes the backing store to the CSS box × `devicePixelRatio`,
  clamped to `maxTextureDimension2D`. Returns `{ width, height, changed }`, so it drops into a
  resolution uniform and lets you gate reallocating render targets.

## 0.3.0 — 2026-08-06

Adds a minified build. No public API change.

- **`tinywebgpu.min.js`** — 16.3 KB (6.3 KB gzipped), down from 46.8 KB / 14.5 KB. Built with
  `npm run build:min` (esbuild). **It is console-free**: every warning and the WGSL
  compile-error log are stripped. Errors still throw with their messages, including the
  bind-group validation failure — only the reporting is gone. Develop against
  `tinywebgpu.js` and switch to the minified file when shipping; `main`/`exports` still point
  at the readable source.
- Deduplicated the buffer-size limit warning shared by `createStorageBuffer` and
  `createBuffer` into one internal helper.
- The generated WGSL wrappers (fullscreen vertex shader, compute entry point, uniform struct)
  are no longer indented. That text is prepended to every shader you compile, so it was being
  hashed, compiled and line-numbered on every pipeline build.
- `test/layout.test.mjs` takes a `TWG_ENTRY` override so the same assertions run against
  either build (`npm test` / `npm run test:min`).

## 0.2.0 — 2026-08-06

Additive release — no existing call changes behavior.

- **Texture upload.** `G.writeTexture(tex, data, opts?)` for raw pixel bytes and
  `await G.loadTexture(src, opts?)` for anything the browser can decode (URL, `Blob`,
  `ImageBitmap`, `<img>`, `<canvas>`, `OffscreenCanvas`, `<video>`). Previously a texture
  could only be filled by rendering into it.
- `createTexture2D`'s default usage now includes `COPY_DST` so uploads work without opting
  in. This is a superset of the previous flags.
- **Optional device features.** `init(ctx?, opts?)` accepts `features`, `limits` and
  `alphaMode`. Features are requested best-effort — unsupported ones are dropped with a
  warning instead of throwing — and the granted set is exposed as `G.features`.
- **Blending.** `makeRender(..., { blend })` and `drawQuad({ blend })` accept `'alpha'`,
  `'premultiplied'`, `'additive'`, or a raw `GPUBlendState`. Blend is part of the pipeline
  cache key, so blend variants of identical WGSL are distinct pipelines.
- New example `5_texture.html` covering all three.

## 0.1.0 — 2026-08-06

First public release. Single-file WebGPU micro-framework: dual-schema pipelines
(uniforms + resources as plain JS objects), fullscreen render path, compute with direct and
indirect dispatch, frame batching with frame-ordered writes, shader/pipeline caching.

Notable behaviors (vs. the library's private ancestry, for the curious):

- Uniform structs follow WGSL layout rules exactly, including vec3 (align 16 / size 12).
- The core never rewrites user WGSL. Optional token shorthands live in the separate
  `wgsl_shorthand.js` module via the `G.pre` hook.
- WGSL compile errors always throw with a source-window log; warnings are logged.
- Schema resources the shader never references are skipped from the bind group with a warning
  (auto layout strips their bindings).
- Inside `beginFrame()`/`endFrame()`, uniform writes and storage-buffer writes/clears are
  frame-ordered via an internal staging ring: per-dispatch uniform values work in one submit.
- `dispatch()`/`drawTo()` auto-close an open chained compute pass instead of erroring.
- Device loss is logged and surfaced via `G.onDeviceLost`; uncaptured errors are logged;
  GPU objects carry labels.
- `init()` without a canvas context = compute-only use.
- `createStorageBuffer` takes a byte length **or** initial contents (create-and-fill).
- Readback staging buffers are pooled.
