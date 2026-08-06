# Changelog

All notable changes to TinyWebGPU. Semver; pre-1.0, minor versions may break API.

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
