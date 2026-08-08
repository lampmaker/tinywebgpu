# Changelog

All notable changes to TinyWebGPU. Semver; pre-1.0, minor versions may break API.

## Unreleased

Documentation and examples only — `tinywebgpu.js` is untouched, so there is nothing to upgrade.

**Added**

- **`tutorial.html`** — a sixteen-step guided tour, from a single coloured pixel to a particle
  system. Every code box on the page is live: it is edited in place and recompiled against the
  reader's own GPU, with animation loops stopped when a box is re-run or scrolls out of view. The
  boxes share one device (a device per box would be a lot of memory for a page you scroll), so one
  canvas demo animates at a time. `window.__runAll()` runs every box and reports what broke.
- **`examples/6_pi.html`** — Monte Carlo π. Per-thread RNG streams, a private tally published with
  a single `atomicAdd` per thread, and a density grid drawn from the same buffer the compute pass
  writes. Counters accumulate on the GPU and are sampled without ever awaiting inside the frame,
  because `.r()` stalls. Self-checks 2.1M darts against π before the first frame is presented.
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
