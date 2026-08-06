# Changelog

All notable changes to TinyWebGPU. Semver; pre-1.0, minor versions may break API.

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
