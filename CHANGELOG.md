# Changelog

All notable changes to TinyWebGPU. Semver; pre-1.0, minor versions may break API.

## Unreleased

**Added**

- **`G.show(tex, view?, opts?)`** — draw a texture onto a target. The shortest path from a compute
  result to pixels, and it reads with `textureLoad` rather than a sampler on purpose: `rgba32float`
  and the other unfilterable formats — exactly what a GPGPU pass writes — are rejected outright by
  a sampler. `scale`/`offset` tone-map on the way through. Orientation is source-row-0 to
  target-row-0, so images come out the right way up and `show(a, b)` round-trips through
  `readTexture(b)`; `flipY: true` opts back into the raw uv.
- **`G.save(tex, filename?, opts?)`** — download a texture as PNG/JPEG/WebP, or take the `Blob`
  with `download: false`. BGRA channels are swapped for you. No tiling: render as large as
  `maxTextureDimension2D` allows and save once.
- **Ping-pong pairs** — `createPingPong(bytesOrData)`, `createPingPongTexture2D(w, h, format?)` and
  the general `pingPong(make)`, each returning `{read, write, swap()}`. Seeding from a TypedArray
  fills both halves, so a swap before the first step is harmless.
- **Multiple render targets** — `makeRender(frag, u, r, { targets: { name: format, … } })` generates
  the `struct FSOut` with its `@location` indices in key order, and `drawTo({ name: view, … })`
  binds them by name. A single target keeps the plain `-> vec4<f32>` contract.
- **Every `matCxR<f32>` uniform**, not just `mat4x4`. The type table became arithmetic on the type
  string, so `mat2x2` … `mat4x3` all work; a 3-row matrix has its columns written onto the 16-byte
  stride WGSL requires, so you pass 9 tightly packed numbers for a `mat3x3<f32>`.
- **`init(ctx, { canvasUsage })`** — swapchain usage flags, so adding `COPY_SRC` makes the canvas
  texture itself readable and saveable.

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
  can inline. Net of the features above: 19.0 KB → 18.2 KB raw. A caveat worth recording — the
  classic tricks that were considered and rejected (packing API names into strings, binding hot
  methods to short locals) move raw bytes but not gzipped ones: rebinding every hot call site
  measured −992 raw and **−65 gzipped**, because gzip already deduplicates across the file.

**Fixed**

- **`compute2D` never ran anything.** It passed its `body` to `makeCompute` as *declarations* and
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
- `createStorageTexture2D` takes a `usage` override and includes `COPY_DST` by default, so
  `writeTexture` works on it — matching `createTexture2D`.

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
