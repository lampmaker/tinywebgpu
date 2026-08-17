# TinyWebGPU — API reference

Complete surface of `tinywebgpu.js`. Pre-1.0: minor versions may still break API.

```js
import { WEBGPU } from './tinywebgpu.js';
const G = WEBGPU();
await G.init(canvas.getContext('webgpu'));
```

## Setup

### `await G.init(ctx?, opts?)`
Requests adapter + device (with the adapter's max buffer-size limits) and, if a canvas
`'webgpu'` context is passed, configures it (`preferredCanvasFormat`, `alphaMode:'opaque'`).
Omit `ctx` for compute-only use — render calls then need an explicit target view. Populates
`G.device`, `G.context`, `G.format`, `G.features`. Throws if WebGPU is unavailable.

`opts` (all optional):

| Option | Effect |
|---|---|
| `features: string[]` | Requested best-effort. Any the adapter doesn't support are dropped with a console warning instead of throwing, so asking is always safe. Check `G.features` (a `Set`) for what was actually granted. |
| `limits: {}` | Shallow-merged over the defaults, so you can raise or override individual limits. |
| `alphaMode` | Canvas alpha mode, default `'opaque'`. Use `'premultiplied'` for a transparent canvas. |
| `canvasUsage` | Usage flags for the swapchain texture, default `RENDER_ATTACHMENT`. Add `GPUTextureUsage.COPY_SRC` if you want to `readTexture`/`save` the canvas texture itself. |

```js
const G = await WEBGPU().init(ctx, { features: ['timestamp-query'] });
if (G.features.has('timestamp-query')) { /* ... */ }
```

Requesting a feature makes it *available* — the library doesn't build anything on top of it.

### `G.debug = true|false` (default false)
Enables uniform-write warnings (width overflow, non-integer into int fields). WGSL compile
checking is always on: errors throw with a pretty source-window log, warnings are logged.

### `G.pre = null | (src: string) => string` (default null)
Optional WGSL preprocessing hook, applied in `makeShader` before hashing/compiling. `null`
means user WGSL is never rewritten. Must be deterministic — the shader cache keys on the
post-`pre` source. See “WGSL preprocessing” below for the stock token expander.

### `G.onDeviceLost = null | (info: GPUDeviceLostInfo) => void` (default null)
Called if the GPU device is lost (driver reset, context crash). The library always logs the
loss; set this to rebuild/recover. Uncaptured WebGPU errors are also logged with labels
(buffers, textures, shaders and encoders carry `label`s for readable messages).

## Pipelines (the main API)

### `await G.makeRender(fragWGSL, uniforms?, resources?, { format?, blend?, targets? })`
Fullscreen pipeline. You provide a WGSL function `fn frag(uv: vec2<f32>) -> vec4<f32>`; the
toolkit generates the vertex shader (single fullscreen triangle) and the `fs_main` wrapper.
Only the uniforms you declare exist — nothing is auto-added.

`format` defaults to the canvas format — pass it explicitly when drawing to an offscreen
texture in a different format, or the pipeline won't match the attachment.

`blend` is off by default (opaque overwrite). Pass a preset name or a raw `GPUBlendState`:

| Preset | Use for |
|---|---|
| `'alpha'` | Ordinary transparency; expects straight (un-premultiplied) alpha out of `frag`. |
| `'premultiplied'` | `frag` already returns rgb scaled by a. |
| `'additive'` | Glows, accumulation, light stacking. |

```js
const overlay = await G.makeRender(frag, {}, {}, { blend: 'alpha' });
overlay.drawTo(view, 'load');        // 'load' keeps what's underneath
```

`targets` turns on **multiple render targets**. It is `{ name: format }`, and the matching
`struct FSOut { @location(i) name: vec4<f32>, … }` is generated for you in key order — so `frag`
returns `FSOut` instead of `vec4<f32>`, and `drawTo` takes an object keyed the same way:

```js
const gbuf = await G.makeRender(`
    fn frag(uv: vec2<f32>) -> FSOut {
      var o: FSOut;
      o.colour = vec4<f32>(uv, 0.0, 1.0);
      o.normal = vec4<f32>(0.0, 0.0, 1.0, 1.0);
      return o;
    }`,
  {}, {}, { targets: { colour: 'rgba8unorm', normal: 'rgba16float' } });

gbuf.drawTo({ colour: colourTex, normal: normalTex });
```

`format` is ignored when `targets` is given. A blend state, if set, applies to every target. All
attachments must share width/height/sampleCount, and the device caps both the number
(`maxColorAttachments`, usually 8) and the total bytes per sample
(`maxColorAttachmentBytesPerSample`, often 32 — two `rgba32float` targets and you are at the
ceiling).

### `await G.makeCompute(bodyWGSL, mainWGSL, uniforms?, resources?, { wg = [8,8,1] })`
Compute pipeline. `bodyWGSL` = declarations (functions, structs); `mainWGSL` = statements placed
inside the generated entry point, which receives `gid` (global), `lid` (local), `wid`
(workgroup) invocation ids. `wg` is the `@workgroup_size`.

### Schemas
- `uniforms`: `{ name: 'f32' | 'i32' | 'u32' | 'vec2/3/4<f32|u32|i32>' | 'matCxR<f32>' }` →
  generated into `struct Uniforms {...}` bound as `UB` at `@group(0) @binding(0)`. Layout
  follows WGSL uniform rules (vec3: align 16, size 12 — a following scalar packs into its tail).
  Every `matCxR` for C, R in 2..4 is supported. Pass matrices as tightly packed column-major
  values; a 3-row matrix has its columns written onto the 16-byte stride WGSL requires, so you
  hand over 9 numbers for a `mat3x3<f32>` and the padding is added for you.
- **A schema entry the shader never references is not declared at all.** It is left out of the
  generated WGSL and out of the bind group, with a console warning. Bindings are numbered over
  what remains. Unreferenced *uniforms* keep their buffer and setters — only the binding goes —
  so `p.setUniforms(...)` on a shader that ignores `UB` still works rather than throwing.
- `resources`: `{ name: <full WGSL type> }` → bound in declaration order after the uniform
  buffer. Supported forms:
  - `'array<T>'` → `var<storage, read_write>` runtime array (T may be a struct you define in
    `bodyWGSL` or inline via the struct form below)
  - `'struct Foo { ... }'` → struct emitted + bound as `var<storage, read_write> name: Foo`
  - primitive/vector/matrix → auto-wrapped in a single-field struct, bound as storage
  - `'texture_2d<f32>'`, `'texture_storage_2d<rgba32float, write>'`, … → texture binding
  - `'sampler'` / `'sampler_comparison'`

### Pipeline object (both kinds)
| Member | Meaning |
|---|---|
| `p.uniforms = {vals}` / `p.setUniforms(vals)` / `p.setUniform(name, v)` | Merge values into the CPU staging struct and upload the whole buffer. Vectors/matrices take arrays or TypedArrays (or scalars for 1-wide). A name that is not in the schema throws. |
| `p.resources = {vals}` / `p.setResources(vals)` | (Re)build the bind group. Pass buffer handles (`{b,w,r}`) or raw `GPUBuffer`s, and textures or views for textures. **Merged** into what is already bound, so partial updates are fine, and **compared by value**, so re-passing the same resources every frame is free. |
| `p.pipeline` | The raw `GPURenderPipeline`/`GPUComputePipeline`. |
| `p.uniformFields` / `p.resourceFields` | Names, in binding order. |

Compute-only:
| Member | Meaning |
|---|---|
| `p.dispatch(x=1, y=1, z=1, encoder?)` | Dispatch **workgroups**; self-submits unless a frame encoder is open or one is passed. |
| `p.run(w=1, h=1, d=1, encoder?)` | Same, but counts **items**: divides by `wg` and rounds up. Bounds-check the tail with `if (gid.x >= n) { return; }`. |
| `p.dispatchIndirect(gpuBuffer, byteOffset=0, encoder?)` | Indirect dispatch from a `[x,y,z]: 3×u32` buffer. |
| `p.use(pass?)`, `p.dispatchOn(pass?, x,y,z)`, `p.dispatchIndirectOn(pass?, buf, off)` | Chain multiple pipelines inside one compute pass (see Frame API). |

Render-only:
| Member | Meaning |
|---|---|
| `p.drawTo(view?, clear=[0,0,0,1], encoder?)` | Draw the fullscreen triangle. `view` is a `GPUTextureView` or a `GPUTexture`, defaulting to the frame view or a fresh swapchain view. With `targets`, pass `{ name: view\|texture, … }` instead. `clear` = color array or `'load'` to keep contents. |

### One-liners
- `await G.drawQuad({ frag, uniforms, resources, clear, format, blend })` → pipeline + `run(u?, view?)`
- `await G.compute2D({ body, decls, uniforms, resources, size, wg })` → `makeCompute` with a default
  `size`, so `run()` with no arguments covers the whole grid. `body` is the entry-point statements;
  `decls` is for helper functions and structs.
- `await G.show(tex, view?, opts?)` → draws a texture onto a target. `view` defaults to the canvas
  and accepts a `GPUTexture` or a view. Reads with `textureLoad`, **not** a sampler, so
  unfilterable formats (`rgba32float`, the integer formats) work — at the cost of no filtering.
  The source's first row lands on the target's first row, so images are the right way up and
  `show(a, b)` round-trips through `readTexture(b)`. `opts`: `format` (target format, default the
  canvas format), `scale`/`offset` (per-channel `value * scale + offset`, enough to look at an HDR
  or signed buffer without writing a shader), `clear`, and `flipY: true` for a bottom-up source.
  One pipeline is cached per (target format, sample type, flip). Returns the pipeline.
- `await G.save(tex, filename?, opts?)` → downloads a texture as an image file and returns the
  `Blob`. 8-bit RGBA/BGRA only — tone-map an HDR target into an `rgba8unorm` texture first (`show`
  with a `scale` will do). BGRA channels are swapped for you. `opts`: `type` (default
  `'image/png'`), `quality`, `download: false` to get the Blob without triggering a download, plus
  the `x`/`y`/`width`/`height`/`mipLevel` region keys `readTexture` takes. There is no tiling —
  render as large as `maxTextureDimension2D` allows and save once. The canvas texture is not
  saveable unless you passed `canvasUsage` with `COPY_SRC` to `init`.

## Frame API (batching)

```js
G.beginFrame();          // one encoder + one swapchain view for the whole frame
computeA.dispatch(...);  // recorded, not submitted
quad.drawTo();           // recorded
G.endFrame();            // single queue.submit
```

`G.beginCompute()` / `G.endCompute()` keep one compute pass open so chained kernels skip
per-dispatch pass overhead — use with `p.use()` + `p.dispatchOn()`. Calling plain
`p.dispatch()` (or `drawTo`) while a chained pass is open auto-closes that pass first; chained
dispatches after it need a fresh `beginCompute()`.

`beginCompute()` works with or without an enclosing frame. Inside `beginFrame()` the frame owns
the submit, as usual. **Outside one, `beginCompute()` opens its own encoder and `endCompute()`
submits it** — so a chained sequence on its own is self-contained:

```js
G.beginCompute();  a.use(); a.dispatchOn(null, 64);  b.use(); b.dispatchOn(null, 64);
G.endCompute();    // submits
```

While a frame is open, uniform writes, storage `w()` and `clear()` are **frame-ordered**: the
toolkit stages the bytes and encodes a buffer-to-buffer copy at that point in the frame, so
consecutive dispatches see the values set just before them — per-dispatch uniforms work in a
single submit. Outside a frame, writes are plain queue writes as
before. `createStorageBuffer().r()` during an open frame reads *pre-frame* data and warns —
`endFrame()` first. Staged writes go through a buffer copy, so a `w(data, byteOffset)` inside a
frame needs a 4-byte-aligned `byteOffset` (it throws saying so); outside one, any offset works.

The swapchain texture is acquired lazily on the first `drawTo()` of a frame and reused by the rest
of it, so a compute-only `beginFrame()`/`endFrame()` never touches the canvas.

A copy cannot be encoded inside a pass, so a staged write during a chained sequence closes the
compute pass and reopens it, restoring the pipeline and bind group from the last `p.use()`. Writing
uniforms between `dispatchOn()` calls is therefore fine:

```js
G.beginFrame(); G.beginCompute();
p.use();
p.setUniforms({ step: 0 }); p.dispatchOn(null, 64);
p.setUniforms({ step: 1 }); p.dispatchOn(null, 64);   // sees step = 1
G.endCompute(); G.endFrame();
```

If you interleave *two* pipelines, call `use()` again after switching — the reopened pass restores
whichever pipeline `use()` named last.

## Buffers, textures, samplers

| Call | Returns | Notes |
|---|---|---|
| `G.createUniformBuffer(bytes)` | `GPUBuffer` | UNIFORM \| COPY_DST |
| `G.createStorageBuffer(bytesOrData)` | `{ b, w(data, off?), r(nbytes?, off?, Ctor?), clear() }` | STORAGE \| COPY_SRC \| COPY_DST. Pass a byte length, or a TypedArray/ArrayBuffer to size **and** fill in one call. `r` is an async debug readback (stalls!; staging pooled). `w`/`clear` are frame-ordered inside `beginFrame()`. |
| `G.createBuffer(bytes, usage)` | `{ b, w }` | explicit usage flags; size rounded up to 4 bytes |
| `G.createDispatchIndirectBuffer()` | `{ b, w }` | 12 bytes, INDIRECT \| STORAGE \| COPY_DST |
| `G.createPingPong(bytesOrData)` | `{ read, write, swap() }` | Two storage buffers for read-one/write-the-other simulation steps. A TypedArray/ArrayBuffer seeds **both** halves, so a swap before the first step is harmless. `read`/`write` are ordinary `createStorageBuffer` handles and can be passed straight to `setResources`. |
| `G.createPingPongTexture2D(w, h, format='rgba16float', usage?)` | `{ read, write, swap() }` | The texture flavour; both halves come from `createStorageTexture2D`. Pass `usage` to add `RENDER_ATTACHMENT` for render-target ping-pong. |
| `G.pingPong(make)` | `{ read, write, swap() }` | The general form — calls `make()` twice. |
| `G.createTexture2D(w, h, format='rgba8unorm', usage?)` | `GPUTexture` | render target / sampled. Default usage is RENDER_ATTACHMENT \| TEXTURE_BINDING \| COPY_SRC \| COPY_DST, so uploads work without opting in. |
| `G.createStorageTexture2D(w, h, format='rgba32float', usage?)` | `GPUTexture` | `textureStore`/`textureLoad`. Default usage is TEXTURE_BINDING \| STORAGE_BINDING \| COPY_SRC \| COPY_DST. |
| `G.createSampler({ magFilter, minFilter, wrapU, wrapV })` | `GPUSampler` | defaults nearest/clamp |
| `G.writeTexture(tex, data, { width?, height?, x?, y?, bytesPerRow?, mipLevel? })` | `GPUTexture` | Raw pixel bytes in (LUTs, generated data). `width`/`height` default to the whole texture; `bytesPerRow` is derived from the format unless you pass it. Needs COPY_DST. |
| `await G.readTexture(tex, { x?, y?, width?, height?, mipLevel?, Ctor? })` | `Promise<TypedArray>` | Pixels back out. Rows come back **tightly packed** — the 256-byte `bytesPerRow` padding `copyTextureToBuffer` requires is stripped for you. `Ctor` defaults from the format (`*32float` → `Float32Array`, `*32uint` → `Uint32Array`, `*32sint` → `Int32Array`, else `Uint8Array`). Needs COPY_SRC — both texture creators include it. Like `.r()`, it **stalls the pipeline**, and during an open frame it reads pre-frame data and warns. |
| `G.resizeCanvas(canvas?, { dpr? })` | `{ width, height, changed }` | Sizes the canvas backing store to its CSS box × `devicePixelRatio`, clamped to `maxTextureDimension2D`. `canvas` defaults to the one `init()` configured. `changed` is false when it was already the right size, so you can gate reallocating render targets; the returned size drops straight into a `vec2<f32>` resolution uniform. |
| `await G.loadTexture(src, { texture?, format?, usage?, flipY?, premultipliedAlpha?, colorSpace? })` | `Promise<GPUTexture>` | `src` = URL string, `Blob`, `ImageBitmap`, `<img>`, `<canvas>`, `OffscreenCanvas` or `<video>`. Creates a texture sized from the source unless you pass `texture` to reuse one. |
| `G.writeUniforms(buf, typedArrayOrDataView, byteOffset?)` | — | raw write |

## Lower-level escape hatches

`G.makeShader(code)` (returns a cached promise of the compiled module; applies `G.pre`),
`G.makeRenderPipeline(vs, fs, formatOrFormats, topology?, blend?)` (an array of formats gives multiple targets), `G.makeComputePipeline(module)`,
`G.bindGroup(pipeline, groupIndex, entries)`,
`G.makeUniformsAndResources(...)` (the schema engine itself; its result carries `wgsl`, `uniformBuffer` and `uniformWrite`, plus `_`-prefixed internals the minified build renames).

## WGSL preprocessing

The core does **no rewriting by default**. `G.pre` is an optional `(src) => src` hook applied
before compile/caching. The token expander is a separate optional module
`wgsl_shorthand.js`:

```js
import { shorthand, TOKENS, SHORT_TOKENS } from './wgsl_shorthand.js';
G.pre = shorthand();                       // safe stock set: FLOAT INT VEC2/3/4 MAT4 PI TAU EPS
G.pre = shorthand(TOKENS, SHORT_TOKENS);   // + one-letter legacy aliases F V W X I U U3
G.pre = shorthand({ RAY: 'MyRay', ...TOKENS });          // custom map
G.pre = s => shorthand()(myMacros(s));                   // compose freely
```

`shorthand(...maps)` merges the maps (default `TOKENS`), compiles one word-boundary
alternation regex (longest token wins), and returns a deterministic `src => src` function.

Careful with `SHORT_TOKENS`: one-letter aliases collide with natural identifier names, so
`let F = fresnel(...)` becomes `let f32 = ...` and won't compile. They are opt-in for exactly
that reason.

## Builds

| File | Size | What it is |
|---|---|---|
| `tinywebgpu.js` | 69 KB | the source, with comments and every diagnostic. `main`/`exports` point here. |
| `tinywebgpu.min.js` | 15.7 KB (7.0 gz) | `npm run build:min`. Silent: no console output, no compile-error window, no resource validator, no debug labels. Errors still throw with their messages. |
| `tinywebgpu.tiny.js` | 10.2 KB (4.8 gz) | `npm run build:tiny`. The above, plus every optional entry point removed and error text folded to numbers. For inlining into a single file. |

`build:tiny` drops `writeTexture`, `loadTexture`, `readTexture`, buffer `.r()`, `save`, `show`,
the ping-pong helpers, `resizeCanvas` and the named blend presets. Keep any of them with
`node build-min.mjs --tiny --with=show,read`, or start from the full build and remove a few with
`--without=save,texio`. `--iife` emits a classic `<script>` assigning `globalThis.WEBGPU`.
Full table of what each switch costs: README → *Tiny build*.

Everything else is always present: `init`, `makeRender`, `makeCompute`, `drawQuad`, `compute2D`,
the schema engine, buffers, textures, samplers, the frame API and frame-ordered writes.
