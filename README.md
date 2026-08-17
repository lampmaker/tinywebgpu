# TinyWebGPU

One file. No dependencies. No build step. The shortest path from a WGSL string to pixels.

TinyWebGPU is a WebGPU micro-framework for shader-first work — SDF tracers, GPGPU
experiments, shadertoy-style pieces — for when raw WebGPU is too verbose and a full engine is
far too much. It wraps the error-prone parts (struct layouts, binding indices, buffer offsets,
pass/submit plumbing) and stays out of the way of your WGSL.

```html
<canvas id="c" width="800" height="450"></canvas>
<script type="module">
  import { WEBGPU } from './tinywebgpu.js';

  const G = await WEBGPU().init(document.getElementById('c').getContext('webgpu'));
  const quad = await G.drawQuad({
    frag: `fn frag(uv: vec2<f32>) -> vec4<f32> {
      return vec4<f32>(0.5 + 0.5 * cos(UB.time + uv.xyx * 4.0 + vec3<f32>(0.0, 2.0, 4.0)), 1.0);
    }`,
    uniforms: { time: 'f32' },
  });
  const loop = t => { quad.run({ time: t * 0.001 }); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
</script>
```

## The core idea: dual schemas

The most error-prone part of raw WebGPU is keeping three things in sync by hand — WGSL struct
layout, binding indices, and JS ArrayBuffer offsets. TinyWebGPU makes one JS object the single
source of truth and generates the rest:

```js
const p = await G.makeCompute(/* declarations */ '', /* main body */ `
    let i = gid.x;
    if (i < UB.n) { data[i] = f32(i) * f32(i); }
  `,
  { n: 'u32' },                 // uniforms → generated WGSL struct `UB`, typed setters
  { data: 'array<f32>' },       // resources → generated @group/@binding declarations
  { wg: [64, 1, 1] });

const buf = G.createStorageBuffer(1024 * 4);
p.setResources({ data: buf });
p.setUniforms({ n: 1024 });
p.run(1024);                     // items, not workgroups — run() divides by wg for you
console.log(await buf.r(64, 0, Float32Array));   // debug readback
```

Uniform structs follow WGSL layout rules exactly (yes, including vec3). Resources take full
WGSL types: `array<Ray>`, `struct Foo {...}`, `texture_storage_2d<rgba32float, write>`,
`sampler` — bound in declaration order.

## Frame batching

```js
G.beginFrame();               // one encoder, one submit for the whole frame
sim.uniforms = { dt };        // frame-ordered: each dispatch sees the values set before it
sim.dispatch(x, y);
draw.drawTo();
G.endFrame();
```

Uniform and storage-buffer writes inside a frame are staged and copied at their point in the
frame, so per-dispatch uniform values work within a single submit. Outside a frame, every
`dispatch()`/`drawTo()` self-submits — the beginner path and the fast path are the same API.

Compute can also go indirect, with workgroup counts computed on the GPU:

```js
prep.dispatch(1);                       // writes [x,y,z] into a 3×u32 buffer
work.dispatchIndirect(indirect.b, 0);   // no CPU round-trip
```

## Tutorial

**[tutorial.html](https://lampmaker.github.io/tinywebgpu/tutorial.html)** is the guided path:
sixteen steps from one coloured pixel to a particle system, and every code box on the page is
live — edit it and it recompiles against your GPU. It covers uniforms and the schema, compute and
dispatch sizing, ping-pong buffers, the frame API, atomics and reduction, indirect dispatch,
textures, and the sharp edges worth knowing before you hit them.

## Examples

Seven single-file examples live in `examples/` — **[run them live](https://lampmaker.github.io/tinywebgpu/)**
(or serve the folder yourself and open them in a WebGPU browser):

1. `1_hello.html` — animated fullscreen shader in ~10 lines
2. `2_compute_readback.html` — compute → storage buffer → readback, no canvas
3. `3_life.html` — ping-pong compute + present (game of life), frame API
4. `4_indirect.html` — GPU-side counters → indirect dispatch (wavefront pattern)
5. `5_texture.html` — image upload (`writeTexture` / `loadTexture`) + alpha blending
6. `6_evolution.html` — differential evolution: a gradient-free global optimizer with one
   thread per individual, a workgroup-shared-memory reduction to find the best, and a swappable
   objective — the four here are the standard hard cases
7. `7_particles.html` — a few hundred thousand particles with no vertex buffers: each one splats
   into a density grid with an `atomicAdd`, and a fullscreen pass colours it

Every page is laid out for a phone as much as a desktop, and examples 5, 6 and 7 check their own
arithmetic on load rather than asking you to judge it by eye — example 6 holds its WGSL objectives
against an independent CPU implementation and then proves the search reaches a known optimum.

## Textures

Get pixels in from raw bytes, or from anything the browser can decode:

```js
// raw bytes — LUTs, generated data
const tex = G.createTexture2D(2, 2);
G.writeTexture(tex, new Uint8Array([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]));

// or an image: URL, Blob, ImageBitmap, <img>, <canvas>, <video>
const photo = await G.loadTexture('image.png');

// and back out again — rows tightly packed, typed from the format
const pixels = await G.readTexture(photo);          // Uint8Array, 4 bytes per texel

const quad = await G.drawQuad({
  frag: `fn frag(uv: vec2<f32>) -> vec4<f32> { return textureSample(photo, samp, uv); }`,
  resources: { photo: 'texture_2d<f32>', samp: 'sampler' },
});
quad.setResources({ photo, samp: G.createSampler({ magFilter: 'linear' }) });
quad.run();
```

Draw translucent passes over what's already there with `blend` — `'alpha'`,
`'premultiplied'`, `'additive'`, or a raw `GPUBlendState`:

```js
const glow = await G.makeRender(frag, {}, {}, { blend: 'additive' });
glow.drawTo(view, 'load');           // 'load' keeps the existing contents
```

## Seeing it, saving it, ping-ponging it

`show()` is the shortest path from a texture to pixels — the call you want when a compute pass
produced something and you just want to look at it:

```js
G.show(result);                                  // onto the canvas
G.show(hdr, null, { scale: [0.25, 0.25, 0.25, 1] });   // tone-map an HDR buffer on the way
G.show(depth, myTarget.createView());            // or into a texture you own
```

It reads with `textureLoad`, not a sampler, which is the whole point: `rgba32float` and the other
unfilterable formats — exactly the ones a GPGPU pass writes — are *rejected* by a sampler. The
source's first row lands on the target's first row, so images come out the right way up and
`show(a, b)` round-trips through `readTexture(b)`.

`save()` writes a texture to an image file:

```js
await G.save(frame, 'render.png');               // 8-bit RGBA/BGRA only
await G.save(frame, 'render.jpg', { type: 'image/jpeg', quality: 0.92 });
const blob = await G.save(frame, '', { download: false });   // just the Blob
```

Render big and save once — there is no tiling, because `maxTextureDimension2D` (8192–16384) is a
long way past a canvas. To capture the canvas itself, `init(ctx, { canvasUsage })` with `COPY_SRC`
included; a swapchain is `RENDER_ATTACHMENT` only by default.

Ping-pong pairs cover the read-one-write-the-other pattern every simulation needs:

```js
const grid = G.createPingPong(W * H * 4);        // or seed both halves from a TypedArray
step.resources = { src: grid.read, dst: grid.write };
step.run(W, H);
grid.swap();
```

`createPingPongTexture2D(w, h, format?)` is the texture flavour, and `pingPong(make)` wraps any
factory you like.

## Multiple render targets

Name your targets and the `FSOut` struct is generated for you, `@location` indices and all — the
part that is easy to get silently wrong by hand:

```js
const gbuf = await G.makeRender(`
    fn frag(uv: vec2<f32>) -> FSOut {
      var o: FSOut;
      o.colour = vec4<f32>(uv, 0.0, 1.0);
      o.normal = vec4<f32>(0.0, 0.0, 1.0, 1.0);
      return o;
    }`,
  {}, {}, { targets: { colour: 'rgba8unorm', normal: 'rgba16float' } });

gbuf.drawTo({ colour: colourTex, normal: normalTex });   // keyed by name, not position
```

All attachments must share a size, and the device caps both the count (`maxColorAttachments`,
usually 8) and the total bytes per sample (`maxColorAttachmentBytesPerSample`, often 32 — so two
`rgba32float` targets is the ceiling). A single target keeps the plain `-> vec4<f32>` contract.

## Your own vertex stage

`makeRender` generates a fullscreen triangle, which is the right answer for a shader-first
toolkit right up until you want *geometry*. `makeDraw` is the sibling of `makeCompute` for that:
you write both stages, and the schema, `drawTo`, the frame API and the pipeline cache all still
apply.

```js
const N = 100_000;
const parts = G.createStorageBuffer(N * 16);          // xy = position, zw = colour

const points = await G.makeDraw({
  code: `
    struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec3<f32> };

    @vertex fn vs_main(@builtin(vertex_index) v: u32,
                       @builtin(instance_index) i: u32) -> VSOut {
      let quad = array<vec2<f32>,4>(vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.), vec2(1.,1.))[v];
      let p = parts[i];
      var o: VSOut;
      o.pos = vec4<f32>(p.xy + quad * UB.size, 0.0, 1.0);
      o.col = vec3<f32>(p.zw, 1.0);
      return o;
    }
    @fragment fn fs_main(vs: VSOut) -> @location(0) vec4<f32> { return vec4<f32>(vs.col, 1.0); }`,
  uniforms:  { size: 'f32' },
  resources: { parts: 'array<vec4<f32>>' },
  readOnly:  ['parts'],                    // ← see below; this one matters
  count: 4, instances: N, topology: 'triangle-strip', blend: 'additive',
});

points.setResources({ parts });
points.setUniforms({ size: 0.004 });
points.drawTo();

points.instances = alive;                  // per-frame count, same pipeline
```

**There are no vertex buffers, on purpose.** Pull geometry out of a storage buffer indexed by
`@builtin(vertex_index)` / `@builtin(instance_index)`. That is one less layout language to
describe, it costs nothing on a modern GPU, and it means a compute pass can write the geometry a
draw then reads with no plumbing in between.

**`readOnly` is not optional when the vertex stage reads a resource.** The schema binds buffers
`var<storage, read_write>` by default, and WebGPU forbids a read-write storage binding from being
visible to the vertex stage:

> If an entry's `visibility` includes `GPUShaderStage.VERTEX`: if its resource layout object is a
> `buffer`, its `type` is not `"storage"`.

Naming it in `readOnly` binds it `var<storage, read>`, which is allowed. Leave it out and the
pipeline is rejected at creation with a bind-group layout error that does not obviously point
here. Resources only the *fragment* stage touches need nothing.

`count` is vertices per instance (default 3), `instances` defaults to 1, and `topology` is any
`GPUPrimitiveTopology` — `'triangle-list'`, `'triangle-strip'`, `'line-list'`, `'line-strip'`,
`'point-list'`. Both counts are plain properties on the result, so changing them per frame does
not rebuild anything. `targets` and `blend` work exactly as they do on `makeRender`.

`makeRender` is now literally `makeDraw` with the fullscreen vertex stage filled in.

## Minified build

`tinywebgpu.min.js` — **16.1 KB** (7.1 KB gzipped), versus 72 KB for the source. Rebuild it with
`npm run build:min` (esbuild is the only dev dependency; consumers still install nothing).

It is a **production artifact and it is silent**: every `console` warning is stripped, and so are
the WGSL compile-error log with its source window and caret, the schema resource validator, the
validation error scopes, and the debug `label`s on every GPU object. Failures still *throw*, with
their messages intact — you just get no diagnostics on the way there, and a bad resource surfaces
as the driver's own bind-group error rather than a line naming the field.

So: develop against `tinywebgpu.js`, switch to the minified file when you ship. `main` and
`exports` point at the readable source on purpose, so you never get the silent build by
accident.

## Tiny build (inline / on-chain embedding)

When the library has to be *inlined* — a single self-contained HTML file, an on-chain generative
artwork with a hard byte budget — 16.1 KB of it is still mostly features you are not using. A
procedural piece renders from a shader and never touches image loading, readback, or PNG export.

`npm run build:tiny` produces **`tinywebgpu.tiny.js` — 10.7 KB** (4.9 KB gzipped) by dropping
every optional entry point, and adding `--iife --no-banner` gets it to **10.4 KB** as a classic
`<script>` that assigns `globalThis.WEBGPU`.

```
npm run build:tiny                                  everything optional removed
node build-min.mjs --tiny --with=show,blend         ...except these
node build-min.mjs --without=save,read,texio        start from the full build instead
node build-min.mjs --tiny --iife --no-banner --out=dist/twg.js
```

What each switch is worth, measured against the 16.1 KB build:

| `--without=` | Removes | Saves |
|---|---|---|
| `texio` | `writeTexture`, `loadTexture` | 1.1 KB |
| `msg` | error *text* — throws carry a number instead | 1.1 KB |
| `save` | `save()` (PNG download) | 0.8 KB |
| `show` | `show()`, the one-call texture blit | 0.7 KB |
| `read` | `readTexture`, buffer `.r()`, the staging pool — **`save` needs it** | 1.2 KB¹ |
| `resize` | `resizeCanvas()` | 0.4 KB |
| `pingpong` | `pingPong`, `createPingPong`, `createPingPongTexture2D` | 0.3 KB |
| `blend` | the named presets; a raw `GPUBlendState` still works | 0.1 KB |

¹ on top of `save`; `--without=read,save` is 2.0 KB together. The build warns and keeps a
dependency rather than producing something that throws at runtime.

What is never optional: `init`, the dual-schema engine, `makeRender`/`makeDraw`/`makeCompute`
and their one-liners, buffers, textures, samplers, the frame API and frame-ordered writes.

**Errors in a tiny build.** `--without=msg` (which `--tiny` implies) replaces every message with
a number — `Error: 15` instead of `No resources bound. Call setResources({ … })`. The numbers are
listed in the `ERRORS` table at the top of `build-min.mjs`. Debug against `tinywebgpu.js` and
build tiny last; if you want the sentences back, `--tiny --with=msg`.

**How it works, and why it is a build switch and not an option.** The library is one file with a
row of `const NAME = true;` declarations at the top. `build-min.mjs` rewrites the ones you named
to `false`, and esbuild's dead-code elimination removes everything they guard — the code is gone
from the bundle, not merely unreachable. A runtime option could not do that: it would have to
stay in the file to be read.

**On raw versus gzipped.** Most classic minification tricks — aliasing `Object.entries`, moving
`S.frame.encoder` into a closure variable the minifier can rename to one character — move *raw*
bytes and barely touch the gzipped size, because gzip already deduplicates across the whole file.
The aliasing pass in 0.5.0 took the stock build from 18.2 KB to 15.7 KB raw but only 7.4 KB to
7.0 KB gzipped (`makeDraw` has since added 0.5 KB back). Chase raw size when you inline; if you are served over HTTP with compression,
only dropping features moves the needle.

## Optional WGSL shorthands

The core never rewrites your WGSL. If you want token expansion, opt in with the companion
module (or plug in any `(src) => src` function):

```js
import { shorthand, TOKENS, SHORT_TOKENS } from './wgsl_shorthand.js';
G.pre = shorthand();                      // FLOAT INT VEC2/3/4 MAT4 PI TAU EPS
G.pre = shorthand(TOKENS, SHORT_TOKENS);  // + one-letter aliases F V W X I U U3
G.pre = shorthand({ RAY: 'MyRay', ...TOKENS });
```

## API at a glance

| | |
|---|---|
| Setup | `init(ctx?)` (no ctx = compute-only) · `resizeCanvas()` · `debug` · `pre` · `onDeviceLost` |
| Pipelines | `makeRender(frag, uniforms?, resources?, {format?, blend?, targets?})` · `makeDraw({code, uniforms?, resources?, readOnly?, count?, instances?, topology?, …})` · `makeCompute(body, main, uniforms?, resources?, {wg?})` |
| Pipeline object | `p.uniforms = {…}` / `setUniform(s)` · `p.resources = {…}` / `setResources` · `run(w,h,d)` (items) · `dispatch(x,y,z)` (workgroups) · `dispatchIndirect(buf, off)` · `drawTo(view?, clear?)` |
| One-liners | `drawQuad({frag, uniforms, …})` · `compute2D({body, size, wg, …})` · `show(tex, view?, opts?)` · `save(tex, filename?, opts?)` |
| Frame API | `beginFrame()` / `endFrame()` · `beginCompute()` / `endCompute()` + `p.use()` / `p.dispatchOn()` for chained passes |
| Buffers | `createUniformBuffer(bytes)` · `createStorageBuffer(bytes \| data)` → `{b, w, r, clear}` · `createBuffer(bytes, usage)` · `createDispatchIndirectBuffer()` |
| Ping-pong | `createPingPong(bytes \| data)` · `createPingPongTexture2D(w, h, format?)` · `pingPong(make)` → `{read, write, swap()}` |
| Textures | `createTexture2D(w, h, format?, usage?)` · `createStorageTexture2D(w, h, format?)` · `createSampler(opts)` · `writeTexture(tex, data)` · `loadTexture(src)` · `readTexture(tex, opts?)` |
| Escape hatches | `makeShader` · `makeRenderPipeline` · `makeComputePipeline` · `bindGroup` · `makeUniformsAndResources` · `writeUniforms` |

Full reference: **[API.md](API.md)**. JSDoc types are included in the source for editor
autocomplete — no TypeScript build needed.

## Sharp edges (read once, save hours)

- **Scope**: fullscreen + compute only. No vertex buffers, no depth, no mipmaps, one bind
  group (`@group(0)`), binding order = schema key order (your ABI).
- **`show()` is a texel blit, not a sampler** — no filtering, so it stretches 1:1 over the target.
  That is what lets it display `rgba32float` and friends, which a sampler rejects outright.
- **A schema entry the shader never references is not declared at all** — it is left out of the
  generated WGSL and the bind group, and you get a console warning. Bindings are numbered over
  what remains, so keep schema and WGSL in sync if you care about the ABI.
- **Resources merge and compare by value** — `setResources({grid})` updates just that one and
  leaves the rest bound, and re-passing identical resources does not rebuild anything.
- **A staged write inside a chained compute pass closes and reopens it** (copies can't be encoded
  in a pass). The last `p.use()` is restored automatically — but if you interleave two pipelines,
  call `use()` again after switching.
- **`p.uniforms = {…}` merges into a CPU staging struct and uploads the whole buffer.**
- **Readback (`.r()`) is a debug tool**: it stalls the pipeline, and during an open frame it
  reads pre-frame data (and warns).
- **Int uniform fields truncate** (`1.9` → `1`); `debug` mode warns.
- **Caches are unbounded and keyed on WGSL content** — put changing values in uniforms, not in
  generated code.
- **Buffer limits vary wildly across GPUs** (128 MB mobile … GBs desktop). Size buffers from
  `G.device.limits`. Device loss is reported via `G.onDeviceLost`; recovery is up to you.

## Browser support

WebGPU requires a current browser (Chrome/Edge 113+, Firefox 141+ on Windows, Safari 26+) and
a secure context (https or localhost). No WebGL fallback — this is a WebGPU tool.

## License

MIT.
