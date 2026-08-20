# TinyWebGPU — API reference

Complete surface of `src/tinywebgpu.js`. Pre-1.0: minor versions may still break API.

```js
import { WEBGPU } from './tinywebgpu.js';
const G = WEBGPU();
await G.init(canvas);        // or a 'webgpu' context, or a CSS selector
```

## Setup

### `await G.init(ctx?, opts?)`
Requests adapter + device (with the adapter's max buffer-size limits) and configures the canvas.
`ctx` can be a canvas `'webgpu'` context, a canvas element / OffscreenCanvas, or a CSS selector
for one — `init('#c')` works. Omit it for compute-only use — render calls then need an explicit
target view. Populates `G.device`, `G.context`, `G.format`, `G.features`. Throws if WebGPU is
unavailable.

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

### `G.destroy()`
Tears the instance down: destroys the device and every pooled GPU resource (staging ring,
readback pool, depth textures) and empties the memos. For SPA teardown, hot-reload dev servers
and live-coding pages — the environments that otherwise leak a device per reload. Intentional
destruction does not fire `onDeviceLost`. The instance is not reusable afterwards.

### TypeScript
`src/tinywebgpu.d.ts` ships with the package and is wired through `types`/`exports`, so editors
autocomplete the whole surface with inline docs — in TypeScript *and* plain JavaScript projects.
The `GPU*` names come from TypeScript's own `lib.dom`; on an older TS add `@webgpu/types`.

### `G.debug = true|false` (default false)
Enables uniform-write warnings (width overflow, non-integer into int fields). WGSL compile
reporting is always on in the source build: errors and warnings are logged asynchronously with
a pretty source-window log, and a bad module also fails pipeline creation (reported through the
validation scope), so nothing fails silently.

### `G.defines = ''` (string)
WGSL's missing `#define`: a string of `TOKEN replacement` entries separated by commas or
newlines, expanded in every shader compiled. Empty (the default) rewrites nothing. `show()`
and `generateMipmaps` memoize their blit pipelines per `defines` value, so changing the table
recompiles them on next use. See “WGSL defines” below for the format and the stock tables.

### `G.onDeviceLost = 0 | (info: GPUDeviceLostInfo) => void` (default 0)
Called if the GPU device is lost (driver reset, context crash). The library always logs the
loss; set this to rebuild/recover. Uncaptured WebGPU errors are also logged with labels
(buffers, textures, shaders and encoders carry `label`s for readable messages).

## Pipelines (the main API)

### `G.makeFrag(fragWGSL, uniforms?, resources?, { format?, blend?, targets?, depth? })`
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
const overlay = G.makeFrag(frag, {}, {}, { blend: 'alpha' });
overlay.drawTo(view, 'load');        // 'load' keeps what's underneath
```

`targets` turns on **multiple render targets**. It is `{ name: format }`, and the matching
`struct FSOut { @location(i) name: vec4<f32>, … }` is generated for you in key order — so `frag`
returns `FSOut` instead of `vec4<f32>`, and `drawTo` takes an object keyed the same way:

```js
const gbuf = G.makeFrag(`
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

### `G.makeDraw({ code, uniforms?, resources?, readOnly?, count?, instances?, topology?, format?, blend?, targets?, depth? })`
Render pipeline with **your own vertex stage**. `code` is complete WGSL — both
`@vertex fn vs_main` and `@fragment fn fs_main` — and the only thing prepended is the schema
(the `UB` struct and the `@group`/`@binding` declarations), exactly as for compute. You keep the
dual schema, `drawTo` and the frame API. `makeFrag` is this call with the
fullscreen vertex stage filled in.

| Option | Default | Notes |
|---|---|---|
| `readOnly: string[]` | `[]` | Resources bound `var<storage, read>` instead of `read_write`. **Required for anything the vertex stage reads** — see below. |
| `count` | `3` | Vertices per instance, passed to `draw()`. |
| `instances` | `1` | Instance count. |
| `topology` | `'triangle-list'` | Any `GPUPrimitiveTopology`: `'triangle-strip'`, `'line-list'`, `'line-strip'`, `'point-list'`. |
| `depth` | off | `true` for depth testing with the defaults (`depth24plus`, `less`, writes on, an auto-managed depth texture), or `{format?, compare?, write?, texture?}` to override. See below. |
| `format`, `blend`, `targets` | — | Exactly as `makeFrag`. |

`count` and `instances` are also plain properties on the result, so a per-frame count
(`p.instances = alive`) does not rebuild the pipeline.

**No vertex buffers, by design.** Pull geometry from a storage buffer indexed by
`@builtin(vertex_index)` / `@builtin(instance_index)`, so a compute pass can write the geometry a
draw then reads with nothing in between.

**`readOnly` is mandatory for vertex-visible buffers.** WebGPU forbids a read-write storage
binding from being visible to the vertex stage ("if an entry's `visibility` includes
`GPUShaderStage.VERTEX` … its `type` is not `"storage"`"), and `read_write` is what the schema
emits by default. Omit it and pipeline creation fails with a bind-group layout error that does
not point back here. Resources only the fragment stage touches need nothing.

```js
const p = G.makeDraw({
  code: vsAndFsWGSL,
  uniforms: { size: 'f32' }, resources: { parts: 'array<vec4<f32>>' },
  readOnly: ['parts'],
  count: 4, instances: N, topology: 'triangle-strip', blend: 'additive',
});
p.setResources({ parts });
p.drawTo();
```

**Depth testing.** `depth: true` gives overlapping geometry a real depth buffer: a
`depth24plus` texture is created lazily, sized to the render target, pooled by size, and shared
by every depth-enabled pipeline drawing into the same target — so multiple pipelines in a frame
depth-test against each other with nothing to wire up. `drawTo(view, 'load')` keeps the depth
buffer along with the colour; a clear resets it to 1.0. Overrides: `format` (any depth format),
`compare` (default `'less'`), `write` (default `true`, set `false` for e.g. transparents tested
against opaque depth), `texture` (your own depth texture — you manage its size). The
auto-managed texture needs the target's size, which the library knows for the canvas and for any
`GPUTexture` passed to `drawTo`; handing `drawTo` a raw `GPUTextureView` it has never seen makes
it throw and ask for a texture or `depth.texture`.

### `G.makeCompute(bodyWGSL, mainWGSL, uniforms?, resources?, { wg = [8,8,1] })`
Compute pipeline. `bodyWGSL` = declarations (functions, structs); `mainWGSL` = statements placed
inside the generated entry point, which receives `gid` (global), `lid` (local), `wid`
(workgroup) invocation ids. `wg` is the `@workgroup_size`; missing axes default to 1, so
`wg: [64]` means `[64, 1, 1]`.

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
| `p.resources = {vals}` / `p.setResources(vals)` | (Re)build the bind group. Pass buffer handles (`{b,w,r}`) or raw `GPUBuffer`s, and textures or views for textures. **Merged** into what is already bound, so partial updates are fine, and **compared by value**, so re-passing the same resources every frame is free. Bind groups are cached per resource combination (up to 8), so a ping-pong that alternates two states builds two groups total, not one per swap. A name that is not in the schema throws, like `setUniforms`. |
| `p.pipeline` | The raw `GPURenderPipeline`/`GPUComputePipeline`. |
| `p.uniformFields` / `p.resourceFields` | Names, in binding order. |

Compute-only:
| Member | Meaning |
|---|---|
| `p.dispatch(x=1, y=1, z=1, encoder?)` | Dispatch **workgroups**. Joins the pass `beginCompute()` opened, if one is open; otherwise opens a pass of its own and self-submits unless a frame encoder is open or one is passed. |
| `p.run(w=1, h=1, d=1, encoder?)` | Same, but counts **items**: divides by `wg` and rounds up. Bounds-check the tail with `if (gid.x >= n) { return; }`. |
| `p.dispatchIndirect(buf, byteOffset=0, encoder?)` | Indirect dispatch from a `[x,y,z]: 3×u32` buffer — a raw `GPUBuffer` or a `createIndirectBuffer()` handle. |
| `p.bindTo(pass?)` | Escape hatch: bind this pipeline to a compute pass you opened yourself, then dispatch on it with the raw WebGPU calls. Not needed for `beginCompute()` chains. |

Render-only:
| Member | Meaning |
|---|---|
| `p.drawTo(view?, clear=[0,0,0,1], encoder?)` | Draw `p.count` vertices × `p.instances` instances — the fullscreen triangle unless `makeDraw` said otherwise. `view` is a `GPUTextureView` or a `GPUTexture`, defaulting to the frame view or a fresh swapchain view. With `targets`, pass `{ name: view\|texture, … }` instead. `clear` = color array or `'load'` to keep contents. |
| `p.count` / `p.instances` | Vertices per instance and instance count, writable. `3` / `1` for `makeFrag`. Change either per frame without rebuilding the pipeline. |

### One-liners
- `G.makeQuad({ frag, uniforms, resources, clear, ...makeFragOpts })` → pipeline + `run(u?, view?)`.
  Every `makeFrag` option (`format`, `blend`, `targets`, `depth`) passes through.
- `G.makeCompute2D({ body, decls, uniforms, resources, size, wg })` → `makeCompute` with a default
  `size`, so `run()` with no arguments covers the whole grid. `body` is the entry-point statements;
  `decls` is for helper functions and structs.
- `G.show(tex, view?, opts?)` → draws a texture onto a target. `view` defaults to the canvas
  and accepts a `GPUTexture` or a view. Reads with `textureLoad`, **not** a sampler, so
  unfilterable formats (`rgba32float`, the integer formats) work — at the cost of no filtering.
  The source's first row lands on the target's first row, so images are the right way up and
  `show(a, b)` round-trips through `readTexture(b)`. `opts`: `format` (target format; inferred from a
  `GPUTexture` target, else the canvas format), `scale`/`offset` (per-channel `value * scale + offset`, enough to look at an HDR
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

`G.frame(fn, opts?)` is the same pair wrapped around a callback, exception-safe: the frame is
submitted even if `fn` throws, so one bad frame cannot leave a dangling encoder behind. It
returns `fn`'s result.

`G.beginCompute()` / `G.endCompute()` keep one compute pass open so chained kernels skip
per-dispatch pass overhead. There is nothing extra to call: while that pass is open,
`dispatch`, `run` and `dispatchIndirect` record into it, and rebind only when the pipeline
actually changes. `drawTo()` closes it first, since a render pass cannot nest.

`beginCompute()` works with or without an enclosing frame. Inside `beginFrame()` the frame owns
the submit, as usual. **Outside one, `beginCompute()` opens its own encoder and `endCompute()`
submits it** — so a chained sequence on its own is self-contained:

```js
G.beginCompute();  a.dispatch(64); a.dispatch(64); b.dispatch(64);
G.endCompute();    // one pass, two setPipeline calls, one submit
```

While a frame is open, uniform writes, storage `w()` and `clear()` are **frame-ordered**: the
toolkit stages the bytes and encodes a buffer-to-buffer copy at that point in the frame, so
consecutive dispatches see the values set just before them — per-dispatch uniforms work in a
single submit. (Builds without the `staging` switch trade this away: in-frame writes become
plain queue writes and the last value set before `endFrame()` wins for the whole frame.) Outside a frame, writes are plain queue writes as
before. `createStorageBuffer().r()` during an open frame reads *pre-frame* data and warns —
`endFrame()` first. `w(data, byteOffset)` needs a 4-byte-aligned `byteOffset` inside a frame and
out (it throws saying so — WebGPU demands it on both write paths). A `data` whose byte length is
not a multiple of 4 is fine: the write is padded with zeros to the alignment WebGPU requires,
which the rounded-up buffer size always has room for.

The swapchain texture is acquired lazily on the first `drawTo()` of a frame and reused by the rest
of it, so a compute-only `beginFrame()`/`endFrame()` never touches the canvas.

A copy cannot be encoded inside a pass, so a staged write during a chained sequence closes the
compute pass and reopens it, restoring whichever pipeline was bound. Writing uniforms between
dispatches is therefore fine:

```js
G.beginFrame(); G.beginCompute();
p.setUniforms({ step: 0 }); p.dispatch(64);
p.setUniforms({ step: 1 }); p.dispatch(64);   // sees step = 1
G.endCompute(); G.endFrame();
```

Interleaving two pipelines needs nothing special either — each `dispatch` rebinds if the pass is
holding someone else's pipeline.

## Buffers, textures, samplers

| Call | Returns | Notes |
|---|---|---|
| `G.createUniformBuffer(bytes)` | `GPUBuffer` | UNIFORM \| COPY_DST |
| `G.createStorageBuffer(bytesOrData)` | `{ b, w, r, clear }` (aliases: `buffer`, `write`, `read`) | STORAGE \| COPY_SRC \| COPY_DST. Pass a byte length, or a TypedArray/ArrayBuffer to size **and** fill in one call. `r` is an async debug readback (stalls!; staging pooled) — `r(nbytes?, byteOffset?, Ctor?)`, or `r(Float32Array)` to read the whole buffer typed. `w`/`clear` are frame-ordered inside `beginFrame()`. |
| `G.createBuffer(bytes, usage)` | `{ b, w }` (aliases: `buffer`, `write`) | explicit usage flags; size rounded up to 4 bytes |
| `G.createIndirectBuffer()` | `{ b, w }` | 12 bytes, INDIRECT \| STORAGE \| COPY_DST |
| `G.createPingPong(bytesOrData)` | `{ read, write, swap() }` | Two storage buffers for read-one/write-the-other simulation steps. A TypedArray/ArrayBuffer seeds **both** halves, so a swap before the first step is harmless. `read`/`write` are ordinary `createStorageBuffer` handles and can be passed straight to `setResources`. |
| `G.createPingPongTexture(w, h, format='rgba16float', usage?)` | `{ read, write, swap() }` | The texture flavour; both halves come from `createStorageTexture`. Pass `usage` to add `RENDER_ATTACHMENT` for render-target ping-pong. |
| `G.pingPong(make)` | `{ read, write, swap() }` | The general form — calls `make()` twice. |
| `G.createTexture(w, h, format='rgba8unorm', usage \| {usage, mips}?)` | `GPUTexture` | render target / sampled. Default usage is RENDER_ATTACHMENT \| TEXTURE_BINDING \| COPY_SRC \| COPY_DST, so uploads work without opting in. `mips: true` allocates the full mip chain (a number allocates that many levels) — fill it with `generateMipmaps`. |
| `G.generateMipmaps(tex)` | `GPUTexture` | Fills the smaller mip levels from level 0 by successive linear-filtered blits. Needs TEXTURE_BINDING + RENDER_ATTACHMENT (the defaults) and a filterable, renderable format. Call after `writeTexture`, or whenever level 0 changed. |
| `G.createStorageTexture(w, h, format='rgba32float', usage?)` | `GPUTexture` | `textureStore`/`textureLoad`. Default usage is TEXTURE_BINDING \| STORAGE_BINDING \| COPY_SRC \| COPY_DST. |
| `G.createSampler({ magFilter, minFilter, wrapU, wrapV, wrapW, ...rest })` | `GPUSampler` | defaults nearest/clamp. `wrapU/V/W` map to `addressModeU/V/W`; anything else (`mipmapFilter`, `compare`, `maxAnisotropy`, lod clamps) passes straight through. |
| `G.writeTexture(tex, data, { width?, height?, x?, y?, bytesPerRow?, mipLevel? })` | `GPUTexture` | Raw pixel bytes in (LUTs, generated data). `width`/`height` default to the whole texture; `bytesPerRow` is derived from the format unless you pass it. Needs COPY_DST. |
| `await G.readTexture(tex, { x?, y?, width?, height?, mipLevel?, Ctor? })` | `Promise<TypedArray>` | Pixels back out. Rows come back **tightly packed** — the 256-byte `bytesPerRow` padding `copyTextureToBuffer` requires is stripped for you. `Ctor` defaults from the format (`*32float` → `Float32Array`, `*32uint`/`*32sint` → `Uint32Array`/`Int32Array`, `*16float` → `Float16Array` where the platform has it (raw `Uint16Array` half bits otherwise), `*16uint`/`*16sint` → `Uint16Array`/`Int16Array`, else `Uint8Array`). Needs COPY_SRC — both texture creators include it. Like `.r()`, it **stalls the pipeline**, and during an open frame it reads pre-frame data and warns. |
| `G.resizeCanvas(canvas?, { dpr? })` | `{ width, height, changed }` | Sizes the canvas backing store to its CSS box × `devicePixelRatio`, clamped to `maxTextureDimension2D`. `canvas` defaults to the one `init()` configured. `changed` is false when it was already the right size, so you can gate reallocating render targets; the returned size drops straight into a `vec2<f32>` resolution uniform. |
| `await G.loadTexture(src, { texture?, format?, usage?, flipY?, premultipliedAlpha?, colorSpace? })` | `Promise<GPUTexture>` | `src` = URL string, `Blob`, `ImageBitmap`, `<img>`, `<canvas>`, `OffscreenCanvas` or `<video>`. Creates a texture sized from the source unless you pass `texture` to reuse one. `mips: true` allocates and builds the mip chain in the same call. A URL fetch that fails throws with the HTTP status instead of an opaque decode error. To *display* a loaded image with the generated uv, sample `vec2(uv.x, 1.0 - uv.y)` — uv.y is 0 at the bottom of the screen and the image's first row is v = 0. |
| `G.writeUniforms(buf, typedArrayOrDataView, byteOffset?)` | — | raw write |

## Lower-level escape hatches

`G.makeShader(code)` (compiles and returns the module synchronously; applies `G.defines`),
`G.bindGroup(pipeline, groupIndex, entries)`,
`G.makeSchema(uniforms, resources, opts?)` (the schema engine itself; its result carries `wgsl`,
`uniformBuffer` and `uniformWrite`, plus `_`-prefixed internals the minified build renames).
For anything lower than that, `G.device` is the raw `GPUDevice`.

## WGSL defines

WGSL has no `#define`; `G.defines` is one. It is **one string**: entries separated by commas
or newlines, each one `TOKEN replacement` (tokens are identifier-like words; replacements may
contain spaces, not commas — they are the entry separator). Every shader the instance compiles
is expanded against it — whole words only, longest token first. The default is `''`, which
rewrites nothing. Composing tables is string concatenation:

```js
G.defines = `
  FLOAT f32,  INT i32,  UINT u32
  VEC2 vec2<f32>,  VEC3 vec3<f32>,  VEC4 vec4<f32>,  MAT4 mat4x4<f32>
  PI 3.141592653589793,  TAU 6.283185307179586`;
G.defines += '\nRAY MyRay';              // custom additions
```

Schema *type strings* are never expanded (they are parsed, not compiled); spell those out.

Careful with one-letter tokens (`F f32`, `V vec2<f32>`, …): they collide with natural
identifier names, so `let F = fresnel(...)` becomes `let f32 = ...` and won't compile. Prefer
the longer spellings above.

## Builds

| File | Size | What it is |
|---|---|---|
| `src/tinywebgpu.js` | 91 KB | the source, with comments and every diagnostic. `main`/`exports` point here. |
| `dist/tinywebgpu.min.js` | 15.7 KB (7.7 gz) | `npm run build:min`. Silent: no console output, no compile-error window, no resource validator, no debug labels. Errors still throw with their messages. |
| `dist/tinywebgpu.tiny.js` | 8.8 KB (4.6 gz) | `npm run build:tiny`. The above, plus every optional entry point removed and error text folded to numbers. For inlining into a single file. |

`build:tiny` drops `writeTexture`, `loadTexture`, `readTexture`, buffer `.r()`, `save`, `show`,
the ping-pong helpers, `resizeCanvas`, depth support, mipmaps, the staging ring (in-frame writes become plain queue writes — last value per frame wins), the long aliases, and the named blend presets. Tiny builds also pack repeated WebGPU member names into a string table (`--no-pack` to skip). Keep any of them with
`node tools/build-min.mjs --tiny --with=show,read`, or start from the full build and remove a few with
`--without=save,texio`. `--iife` emits a classic `<script>` assigning `globalThis.WEBGPU`.
Full table of what each switch costs: README → *Tiny build*.

Everything else is always present: `init`, `makeFrag`, `makeDraw`, `makeCompute`, `makeQuad`,
`makeCompute2D`, the schema engine, buffers, textures, samplers, the frame API and frame-ordered
writes.
