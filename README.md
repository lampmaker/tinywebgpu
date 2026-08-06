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
p.setResources({ data: buf.b });
p.setUniforms({ n: 1024 });
p.dispatch(Math.ceil(1024 / 64));
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

## Examples

Four single-file examples live in `examples/` — **[run them live](https://lampmaker.github.io/tinywebgpu/)**
(or serve the folder yourself and open them in a WebGPU browser):

1. `1_hello.html` — animated fullscreen shader in ~10 lines
2. `2_compute_readback.html` — compute → storage buffer → readback, no canvas
3. `3_life.html` — ping-pong compute + present (game of life), frame API
4. `4_indirect.html` — GPU-side counters → indirect dispatch (wavefront pattern)

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
| Setup | `init(ctx?)` (no ctx = compute-only) · `debug` · `pre` · `onDeviceLost` |
| Pipelines | `makeRender(frag, uniforms?, resources?, {format?})` · `makeCompute(body, main, uniforms?, resources?, {wg?})` |
| Pipeline object | `p.uniforms = {…}` / `setUniform(s)` · `p.resources = {…}` / `setResources` · `dispatch(x,y,z)` · `dispatchIndirect(buf, off)` · `drawTo(view?, clear?)` |
| One-liners | `drawQuad({frag, uniforms, …})` · `compute2D({body, size, wg, …})` |
| Frame API | `beginFrame()` / `endFrame()` · `beginCompute()` / `endCompute()` + `p.use()` / `p.dispatchOn()` for chained passes |
| Buffers | `createUniformBuffer(bytes)` · `createStorageBuffer(bytes \| data)` → `{b, w, r, clear}` · `createBuffer(bytes, usage)` · `createDispatchIndirectBuffer()` |
| Textures | `createTexture2D(w, h, format?, usage?)` · `createStorageTexture2D(w, h, format?)` · `createSampler(opts)` |
| Escape hatches | `makeShader` · `makeRenderPipeline` · `makeComputePipeline` · `bindGroup` · `makeUniformsAndResources` · `writeUniforms` |

Full reference: **[API.md](API.md)**. JSDoc types are included in the source for editor
autocomplete — no TypeScript build needed.

## Sharp edges (read once, save hours)

- **Scope**: fullscreen + compute only. No vertex buffers, no depth, no mipmaps, one bind
  group (`@group(0)`), binding order = schema key order (your ABI).
- **A schema resource the shader never references is skipped** (auto layout strips it; you get
  a console warning). Keep schema and WGSL in sync.
- **Resource rebinds compare by object reference** — pass a fresh object to force a rebind;
  prebuild and reuse objects in hot loops.
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
