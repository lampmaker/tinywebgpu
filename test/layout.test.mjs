// Regression tests for the uniform packer and the WGSL shorthand module.
// Runs in plain node — the GPU device is stubbed, only the JS-side layout logic is tested.
// Usage: node test/layout.test.mjs
//        TWG_ENTRY=<path> node test/layout.test.mjs   ← run against another build
// The entry is overridable so the same assertions can be run against the minified build.

const ENTRY = process.env.TWG_ENTRY ?? '../tinywebgpu.js';
const { WEBGPU } = await import(ENTRY);
import { shorthand, TOKENS, SHORT_TOKENS } from '../wgsl_shorthand.js';

let failures = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// --- stub device: capture uniform-buffer sizes and writes -------------------
globalThis.GPUBufferUsage ??= { UNIFORM: 64, STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256, MAP_READ: 1 };
globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
const S = WEBGPU();
let lastWrite = null;
S.device = {
  createBuffer: ({ size }) => ({ size }),
  queue: { writeBuffer: (buf, off, ab) => { lastWrite = ab.slice(0); } },
};

const layoutOf = uniforms => {
  const r = S.makeSchema(uniforms);
  return { byteSize: r.uniformBuffer.size, wgsl: r.wgsl, write: r.uniformWrite };
};

// --- scalar packs into a vec3 tail (offset 12, not 16) ---------------
{
  const { byteSize, write } = layoutOf({ pos: 'vec3<f32>', t: 'f32' });
  check('vec3+f32 struct size', byteSize, 16);
  write({ pos: [1, 2, 3], t: 9 });
  check('vec3+f32 written floats', [...new Float32Array(lastWrite)], [1, 2, 3, 9]);
}

// --- mixed struct: f32, vec3, f32, vec2 → WGSL offsets 0,16,28,32, size 48 --
{
  const { byteSize, write } = layoutOf({ a: 'f32', b: 'vec3<f32>', c: 'f32', d: 'vec2<f32>' });
  check('f32+vec3+f32+vec2 struct size', byteSize, 48);
  write({ a: 1, b: [2, 3, 4], c: 5, d: [6, 7] });
  check('f32+vec3+f32+vec2 floats',
    [...new Float32Array(lastWrite)],
    [1, 0, 0, 0, 2, 3, 4, 5, 6, 7, 0, 0]);
}

// --- mat4 after scalar: mat aligns to 16 bytes, total 80 --------------------
{
  const { byteSize, write } = layoutOf({ s: 'f32', m: 'mat4x4<f32>' });
  check('f32+mat4 struct size', byteSize, 80);
  const m = Array.from({ length: 16 }, (_, i) => i + 1);
  write({ s: 42, m });
  const f = [...new Float32Array(lastWrite)];
  check('f32+mat4 scalar at 0', f[0], 42);
  check('f32+mat4 matrix at float 4', f.slice(4, 20), m);
}

// --- u32 vec3 packs the same way -------------------------------------------
{
  const { byteSize, write } = layoutOf({ seed: 'vec3<u32>', n: 'u32' });
  check('vec3<u32>+u32 struct size', byteSize, 16);
  write({ seed: [10, 20, 30], n: 7 });
  check('vec3<u32>+u32 written uints', [...new Uint32Array(lastWrite)], [10, 20, 30, 7]);
}

// --- createStorageBuffer: size vs create-and-fill -------------------
{
  const bySize = S.createStorageBuffer(64);
  check('createStorageBuffer(bytes) sizes the buffer', bySize.b.size, 64);

  lastWrite = null;
  const data = Float32Array.from([1, 2, 3, 4]);
  const filled = S.createStorageBuffer(data);
  check('createStorageBuffer(data) sizes from byteLength', filled.b.size, 16);
  check('createStorageBuffer(data) fills in one call', [...new Float32Array(lastWrite)], [1, 2, 3, 4]);

  const odd = S.createStorageBuffer(new Uint8Array(6));
  check('createStorageBuffer(data) rounds size up to 4 bytes', odd.b.size, 8);

  // the byte-length path used to skip the rounding the data path did, producing a size
  // WebGPU rejects for a STORAGE buffer
  check('createStorageBuffer(bytes) rounds size up to 4 bytes', S.createStorageBuffer(6).b.size, 8);

  // a plain Array has no byteLength; the old `?? d.length` fallback wrote 3 bytes of garbage
  let threw = '';
  try { bySize.w([1, 2, 3]); } catch (e) { threw = e.message; }
  check('w() rejects plain Arrays', /TypedArray or ArrayBuffer/.test(threw), true);
}

// --- uniform writes: typed arrays and unknown names ------------------------
{
  const { write } = layoutOf({ m: 'mat4x4<f32>' });
  // a Float32Array out of a maths library used to hit the scalar path and write one NaN
  write({ m: Float32Array.from({ length: 16 }, (_, i) => i + 1) });
  check('uniform write accepts a TypedArray', [...new Float32Array(lastWrite)].slice(0, 5), [1, 2, 3, 4, 5]);

  const { write: w2 } = layoutOf({ time: 'f32' });
  let threw = '';
  try { w2({ tiem: 1 }); } catch (e) { threw = e.message; }
  check('uniform write rejects an unknown name', /Unknown uniform 'tiem'/.test(threw), true);
}

// --- pipeline: generated entry point, dispatch sizing, resource binding -----
{
  let lastCode = null, dispatched = null;
  const pass = { setPipeline: () => { }, setBindGroup: () => { }, dispatchWorkgroups: (...a) => { dispatched = a; }, end: () => { } };
  let bindGroups = 0;
  Object.assign(S.device, {
    createShaderModule: ({ code }) => { lastCode = code; return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => { bindGroups++; return {}; },
    createCommandEncoder: () => ({ beginComputePass: () => pass, finish: () => { } }),
    pushErrorScope: () => { }, popErrorScope: async () => null,
  });
  S.device.queue.submit = () => { };

  const p = await S.makeCompute2D({
    body: 'if (gid.x < UB.n) { a[gid.x] = b[gid.x]; }',
    uniforms: { n: 'u32' }, resources: { a: 'array<f32>', b: 'array<f32>' },
    wg: [64, 1, 1],
  });
  // makeCompute2D used to pass `body` as declarations and generate an empty main, so the shader
  // was invalid WGSL and the entry point did nothing
  check('makeCompute2D puts the body in the entry point',
    /\{\nif \(gid\.x < UB\.n\) \{ a\[gid\.x\] = b\[gid\.x\]; \}\n\}/.test(lastCode), true);

  const A = S.createStorageBuffer(16), B = S.createStorageBuffer(16);
  A.b.usage = B.b.usage = GPUBufferUsage.STORAGE;
  A.b.mapAsync = B.b.mapAsync = () => { };
  p.setResources({ a: A, b: B });                 // handles, not .b
  check('setResources unwraps buffer handles', bindGroups, 1);
  p.setResources({ a: A, b: B });
  check('setResources compares by value, not reference', bindGroups, 1);
  p.setResources({ b: A });                        // partial update merges over what is bound
  check('setResources merges partial updates', bindGroups, 2);

  p.run(1000);
  check('run() divides item count by the workgroup size', dispatched, [16, 1, 1]);
  p.dispatch(1000);
  check('dispatch() still counts workgroups', dispatched, [1000, 1, 1]);
}

// --- readTexture: rows come back tightly packed, without the 256-byte padding -------------
{
  globalThis.GPUMapMode ??= { READ: 1 };
  const W = 2, H = 2, tight = W * 4, padded = 256;          // rgba8unorm, one 256-byte row each
  const mapped = new Uint8Array(padded * H);
  for (let y = 0; y < H; y++)
    for (let i = 0; i < tight; i++) mapped[y * padded + i] = y * tight + i + 1;

  S.device.createCommandEncoder = () => ({ copyTextureToBuffer: () => { }, finish: () => { } });
  S.device.queue.submit = () => { };
  S._acquireStaging = () => ({ mapAsync: async () => { }, getMappedRange: () => mapped.buffer, unmap: () => { } });
  S._releaseStaging = () => { };

  const px = await S.readTexture({ format: 'rgba8unorm', width: W, height: H });
  check('readTexture strips row padding', [...px], Array.from({ length: tight * H }, (_, i) => i + 1));
}

// --- matCxR: columns of a 3-row matrix sit on a 16-byte stride --------------
{
  // mat3x3 is 3 columns of vec3, each occupying a vec4's worth of space. The caller passes 9
  // tight floats and the packer scatters them; the whole type used to throw.
  const { byteSize, write } = layoutOf({ m: 'mat3x3<f32>' });
  check('mat3x3 struct size', byteSize, 48);
  write({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  check('mat3x3 pads each column', [...new Float32Array(lastWrite)],
    [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);

  // 2- and 4-row columns are tight, so they write straight through
  const m22 = layoutOf({ m: 'mat2x2<f32>' });
  check('mat2x2 struct size', m22.byteSize, 16);
  m22.write({ m: [1, 2, 3, 4] });
  check('mat2x2 writes tightly', [...new Float32Array(lastWrite)], [1, 2, 3, 4]);

  check('mat3x2 struct size', layoutOf({ m: 'mat3x2<f32>' }).byteSize, 32);   // 24, rounded to 16
  check('mat2x4 struct size', layoutOf({ m: 'mat2x4<f32>' }).byteSize, 32);
}

// --- bytes-per-texel is derived from the format name, not tabulated ---------
{
  const b = S._texelBytes;
  check('texel bytes: rgba8unorm', b('rgba8unorm'), 4);
  check('texel bytes: bgra8unorm-srgb', b('bgra8unorm-srgb'), 4);
  check('texel bytes: r16float', b('r16float'), 2);
  check('texel bytes: rg32float', b('rg32float'), 8);
  check('texel bytes: rgba32float', b('rgba32float'), 16);
  check('texel bytes: packed rgb10a2unorm', b('rgb10a2unorm'), 4);
  check('texel bytes: packed rg11b10ufloat', b('rg11b10ufloat'), 4);
  // formats the old fixed table rejected outright
  check('texel bytes: rgba16snorm (was unknown)', b('rgba16snorm'), 8);
  check('texel bytes: rgb10a2uint (was unknown)', b('rgb10a2uint'), 4);
  // depth formats stay unknown on purpose — no single bytes-per-texel for copies
  check('texel bytes: depth24plus stays unknown', b('depth24plus'), undefined);
}

// --- blend presets ----------------------------------------------------------
{
  // The three presets are built from a two-argument helper rather than written out, on the
  // observation that they all add and all leave alpha's source at `one`. Spelled out here so
  // that shortcut cannot drift: these are the exact states example 5 and the docs promise.
  const add = (srcFactor, dstFactor) => ({ srcFactor, dstFactor, operation: 'add' });
  check('blend: alpha', S._resolveBlend('alpha'),
    { color: add('src-alpha', 'one-minus-src-alpha'), alpha: add('one', 'one-minus-src-alpha') });
  check('blend: premultiplied', S._resolveBlend('premultiplied'),
    { color: add('one', 'one-minus-src-alpha'), alpha: add('one', 'one-minus-src-alpha') });
  check('blend: additive', S._resolveBlend('additive'),
    { color: add('one', 'one'), alpha: add('one', 'one') });

  check('blend: null is opaque', S._resolveBlend(null), null);
  const raw = { color: { srcFactor: 'zero', dstFactor: 'one', operation: 'subtract' } };
  check('blend: a raw GPUBlendState passes straight through', S._resolveBlend(raw), raw);

  let threw = '';
  try { S._resolveBlend('glow'); } catch (e) { threw = e.message; }
  check('blend: an unknown preset names the ones that exist',
    /Unknown blend preset 'glow'.*'alpha', 'premultiplied', 'additive'/.test(threw), true);
}

// --- ping-pong pairs --------------------------------------------------------
{
  const seed = Float32Array.from([1, 2, 3, 4]);
  const pp = S.createPingPong(seed);
  check('pingPong seeds both halves', [pp.read.b.size, pp.write.b.size], [16, 16]);
  const [r0, w0] = [pp.read, pp.write];
  pp.swap();
  check('pingPong swap exchanges read and write', [pp.read === w0, pp.write === r0], [true, true]);
}

// --- render pipelines: unused schema entries, and multiple render targets ----
{
  let lastCode = null, lastTargets = null;
  Object.assign(S.device, {
    createShaderModule: ({ code }) => { lastCode = code; return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createRenderPipeline: d => { lastTargets = d.fragment.targets; return { getBindGroupLayout: () => ({}) }; },
  });
  S.format = 'bgra8unorm';

  // A resource the shader never mentions is left out of the generated WGSL entirely, so
  // layout:'auto' has nothing to strip and the remaining bindings stay dense.
  await S.makeFrag('fn frag(uv: vec2<f32>) -> vec4<f32> { return textureLoad(kept, vec2<i32>(0), 0); }',
    {}, { dropped: 'array<f32>', kept: 'texture_2d<f32>' });
  check('unused resource is not declared', /dropped/.test(lastCode), false);
  check('used resource keeps binding 0', /@binding\(0\) var kept/.test(lastCode), true);

  // Uniforms the shader ignores keep their buffer and setters, but not their binding.
  const q = await S.makeFrag('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(uv, 0., 1.); }',
    { time: 'f32' }, {});
  check('unreferenced UB is not bound', /var<uniform>/.test(lastCode), false);
  q.setUniforms({ time: 1 });                       // must still work rather than throw
  check('unreferenced UB still accepts writes', true, true);

  // MRT: the FSOut struct and its @location order are generated from the targets schema.
  await S.makeFrag('fn frag(uv: vec2<f32>) -> FSOut { var o: FSOut; return o; }',
    {}, {}, { targets: { colour: 'rgba8unorm', normal: 'rgba16float' } });
  check('MRT generates FSOut',
    /struct FSOut \{@location\(0\) colour: vec4<f32>, @location\(1\) normal: vec4<f32>\};/.test(lastCode), true);
  check('MRT entry point returns FSOut', /fn fs_main\(vs: VSOut\) -> FSOut/.test(lastCode), true);
  check('MRT declares one target per key', lastTargets, [{ format: 'rgba8unorm' }, { format: 'rgba16float' }]);

  // show(): the generated uv has 0 at the *bottom* of the target, so a blit written the naive way
  // (textureSample with a raw uv) comes out upside down and show(a,b)+readTexture(b) stops
  // round-tripping. Verified against a real GPU when this was written; asserted here so a future
  // refactor cannot quietly flip it back.
  const renderPass = { setPipeline: () => { }, setBindGroup: () => { }, draw: () => { }, end: () => { } };
  S.device.createCommandEncoder = () => ({ beginRenderPass: () => renderPass, finish: () => { } });
  S.device.queue.submit = () => { };
  const tex = { format: 'rgba8unorm', width: 2, height: 2, usage: GPUTextureUsage.TEXTURE_BINDING, createView: () => ({}) };
  await S.show(tex, {});
  check('show() flips uv.y so row 0 stays row 0', /1\.0 - uv\.y/.test(lastCode), true);
  check('show() reads with textureLoad, not a sampler',
    /textureLoad/.test(lastCode) && !/textureSample/.test(lastCode), true);
  await S.show(tex, {}, { flipY: true });
  check('show({flipY}) opts back into the raw uv', /1\.0 - uv\.y/.test(lastCode), false);
}

// --- makeDraw: your own vertex stage ----------------------------------------
{
  let lastCode = null, lastDesc = null, drew = null;
  const renderPass = { setPipeline: () => { }, setBindGroup: () => { }, draw: (...a) => { drew = a; }, end: () => { } };
  Object.assign(S.device, {
    createShaderModule: ({ code }) => { lastCode = code; return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createRenderPipeline: d => { lastDesc = d; return { getBindGroupLayout: () => ({}) }; },
    createCommandEncoder: () => ({ beginRenderPass: () => renderPass, finish: () => { } }),
  });
  S.device.queue.submit = () => { };

  const vsfs = `struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec3<f32> };
@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VSOut {
  var o: VSOut; o.pos = vec4<f32>(parts[i].xy, 0., 1.) * UB.size; o.col = vec3<f32>(1.); return o;
}
@fragment fn fs_main(vs: VSOut) -> @location(0) vec4<f32> { return vec4<f32>(vs.col, 1.); }`;

  const p = await S.makeDraw({
    code: vsfs,
    uniforms: { size: 'f32' }, resources: { parts: 'array<vec4<f32>>' },
    readOnly: ['parts'], count: 4, instances: 500, topology: 'triangle-strip',
  });

  // Captured now: every later makeDraw in this block overwrites lastCode/lastDesc.
  const pCode = lastCode, pDesc = lastDesc;

  // The fullscreen prelude is makeFrag's, not makePipeline's — makeDraw must not add one.
  check('makeDraw does not prepend a vertex shader',
    (pCode.match(/@vertex/g) || []).length, 1);
  check('makeDraw still generates the uniform struct', /var<uniform> UB: Uniforms/.test(pCode), true);

  // WebGPU rejects a read_write storage binding that is visible to the vertex stage, so a
  // resource the vertex shader reads has to be bound `read`. This is the whole reason readOnly
  // exists; without it the pipeline is invalid on a real device and fine on this stub.
  check('readOnly binds storage as read, not read_write',
    /@binding\(1\) var<storage, read> parts:/.test(pCode), true);
  check('resources not named in readOnly stay read_write', await (async () => {
    await S.makeDraw({ code: vsfs, uniforms: { size: 'f32' }, resources: { parts: 'array<vec4<f32>>' } });
    return /var<storage, read_write> parts:/.test(lastCode);
  })(), true);

  check('makeDraw passes topology through', pDesc.primitive.topology, 'triangle-strip');

  const pts = S.createStorageBuffer(64);
  pts.b.usage = GPUBufferUsage.STORAGE;
  pts.b.mapAsync = () => { };
  p.setResources({ parts: pts });
  p.setUniforms({ size: 1 });
  p.drawTo({});
  check('drawTo draws count vertices × instances', drew, [4, 500, 0, 0]);

  // A per-frame instance count must not need a new pipeline.
  p.instances = 12;
  p.drawTo({});
  check('instances is settable per frame', drew, [4, 12, 0, 0]);

  // Two pipelines whose WGSL is byte-identical but whose topology differs are different
  // pipelines. The cache keys on the source, so without topology in the key the second call
  // hands back the first one — silently drawing triangles where lines were asked for.
  const args = { code: vsfs, uniforms: { size: 'f32' }, resources: { parts: 'array<vec4<f32>>' }, readOnly: ['parts'] };
  const tri = await S.makeDraw({ ...args, topology: 'triangle-list' });
  const triAgain = await S.makeDraw({ ...args, topology: 'triangle-list' });
  const line = await S.makeDraw({ ...args, topology: 'line-strip' });
  check('identical pipelines are still cached', tri.pipeline === triAgain.pipeline, true);
  check('topology is part of the pipeline cache key', tri.pipeline === line.pipeline, false);
  check('and it reaches the descriptor', lastDesc.primitive.topology, 'line-strip');

  // makeFrag is makeDraw with the fullscreen stage filled in — it must still behave.
  await S.makeFrag('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(uv, 0., 1.); }');
  check('makeFrag still generates its fullscreen vertex stage',
    /@vertex fn vs_main\(@builtin\(vertex_index\)/.test(lastCode), true);
  drew = null;
  const q = await S.makeFrag('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.); }');
  q.drawTo({});
  check('makeFrag still draws the 3-vertex triangle', drew, [3, 1, 0, 0]);
}

// --- workgroup sizes: missing axes default to 1 ------------------------------
{
  let lastCode = null;
  Object.assign(S.device, {
    createShaderModule: ({ code }) => { lastCode = code; return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
  });
  // wg: [64] used to interpolate `undefined` straight into the WGSL
  await S.makeCompute('', 'let i = gid.x;', {}, {}, { wg: [64] });
  check('a partial wg array fills missing axes with 1',
    /@workgroup_size\(64, 1, 1\)/.test(lastCode), true);
  check('no undefined leaks into the generated WGSL', /undefined/.test(lastCode), false);
}

// --- write alignment: unaligned sizes are padded, unaligned offsets throw ----
{
  let lastWriteSize = null, lastCopy = null;
  S.device.queue.writeBuffer = (buf, off, data, dataOff, size) => { lastWriteSize = size; };
  S.device.createCommandEncoder = () => ({
    copyBufferToBuffer: (...a) => { lastCopy = a; }, finish: () => ({}),
  });
  S.device.queue.submit = () => { };

  const buf = S.createStorageBuffer(64);
  buf.w(new Uint8Array(6));              // writeBuffer demands size % 4 == 0
  check('an unaligned write outside a frame is padded to 4 bytes', lastWriteSize, 8);

  // create-and-fill with unaligned data goes through the same padding
  lastWriteSize = null;
  S.createStorageBuffer(new Uint8Array(6));
  check('createStorageBuffer pads an unaligned init write', lastWriteSize, 8);

  let threw = '';
  try { buf.w(new Uint32Array(1), 2); } catch (e) { threw = e.message; }
  check('an unaligned byteOffset throws outside a frame too', /multiple of 4/.test(threw), true);

  // r() with an unaligned byte count: the copy is padded, the result trimmed back
  S._acquireStaging = () => ({ mapAsync: async () => { }, getMappedRange: () => new ArrayBuffer(8), unmap: () => { } });
  S._releaseStaging = () => { };
  const px = await buf.r(6);
  check('r() pads the copy to 4 bytes', lastCopy[4], 8);
  check('r() trims the result back to what was asked', px.length, 6);
}

// --- schema filtering ignores comments ---------------------------------------
{
  let lastCode = null;
  Object.assign(S.device, {
    createShaderModule: ({ code }) => { lastCode = code; return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
  });
  // `ghost` appears only in comments. layout:'auto' parses real WGSL, so emitting a binding for
  // it used to produce a bind group the driver rejects.
  await S.makeFrag(`// ghost is not used here
    /* neither is ghost here */
    fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(kept[0], 0., 0., 1.); }`,
    {}, { ghost: 'array<f32>', kept: 'array<f32>' });
  check('a name only mentioned in comments is not declared', /binding\(\d+\) var<storage[^;]*ghost/.test(lastCode), false);
  check('the used resource still is', /var<storage, read_write> kept/.test(lastCode), true);
}

// --- setResources: unknown names throw, declared-but-unused names are ignored -
{
  let bindGroups = 0;
  Object.assign(S.device, {
    createShaderModule: ({ code }) => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => { bindGroups++; return {}; },
  });
  const p = await S.makeCompute('', 'a[gid.x] = 1.0; // b is unused', {}, { a: 'array<f32>', b: 'array<f32>' }, { wg: [64, 1, 1] });
  const A = S.createStorageBuffer(16);
  A.b.usage = GPUBufferUsage.STORAGE; A.b.mapAsync = () => { };

  let threw = '';
  try { p.setResources({ tpyo: A }); } catch (e) { threw = e.message; }
  check('setResources rejects an unknown name like setUniforms does',
    /Unknown resource 'tpyo'.*a, b/s.test(threw), true);

  p.setResources({ a: A, b: A });        // b is declared but unused — ignored, not an error
  check('a declared-but-unused resource is accepted silently', bindGroups, 1);
}

// --- bind groups are cached: a ping-pong swap does not rebuild forever --------
{
  let bindGroups = 0;
  Object.assign(S.device, {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => { bindGroups++; return {}; },
  });
  const p = await S.makeCompute('', 'dst[gid.x] = src[gid.x]; // v2', {}, { src: 'array<f32>', dst: 'array<f32>' }, { wg: [64, 1, 1] });
  const g = S.createPingPong(16);
  for (const h of [g.read, g.write]) { h.b.usage = GPUBufferUsage.STORAGE; h.b.mapAsync = () => { }; }

  for (let i = 0; i < 6; i++) {          // three full swap cycles
    p.setResources({ src: g.read, dst: g.write });
    g.swap();
  }
  check('a swapping ping-pong builds exactly two bind groups, not one per frame', bindGroups, 2);
}

// --- pipeline cache dedupes concurrent builds ---------------------------------
{
  let pipelines = 0;
  Object.assign(S.device, {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipeline: () => { pipelines++; return { getBindGroupLayout: () => ({}) }; },
  });
  const frag = 'fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(0.123); }';
  const [p1, p2] = await Promise.all([S.makeFrag(frag), S.makeFrag(frag)]);
  check('two concurrent builds of the same source share one pipeline',
    [pipelines, p1.pipeline === p2.pipeline], [1, true]);
}

// --- createSampler passes the rest of the descriptor through ------------------
{
  S.device.createSampler = d => d;
  const d = S.createSampler({ magFilter: 'linear', wrapU: 'repeat', wrapW: 'repeat', mipmapFilter: 'linear', maxAnisotropy: 4 });
  check('createSampler maps wrapU/V/W and forwards the rest',
    [d.magFilter, d.minFilter, d.addressModeU, d.addressModeW, d.mipmapFilter, d.maxAnisotropy],
    ['linear', 'nearest', 'repeat', 'repeat', 'linear', 4]);
}

// --- loadTexture: a failed fetch names the status, not a decode error ---------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  let threw = '';
  try { await S.loadTexture('missing.png'); } catch (e) { threw = e.message; }
  globalThis.fetch = realFetch;
  check('loadTexture reports the HTTP status of a failed fetch', /HTTP 404.*missing\.png/.test(threw), true);
}

// --- makeCompute2D forwards an explicit encoder --------------------------------
{
  let dispatched = null, submits = 0;
  const pass = { setPipeline: () => { }, setBindGroup: () => { }, dispatchWorkgroups: (...a) => { dispatched = a; }, end: () => { } };
  Object.assign(S.device, {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({ beginComputePass: () => pass, finish: () => ({}) }),
  });
  S.device.queue.submit = () => { submits++; };
  const p = await S.makeCompute2D({ body: 'let j = gid.x; // enc passthrough', wg: [8, 1, 1], size: [32, 1] });
  const myEnc = { beginComputePass: () => pass };
  p.run(32, 1, 1, myEnc);                // used to drop the encoder argument on the floor
  check('makeCompute2D run() forwards the encoder and does not self-submit',
    [dispatched, submits], [[4, 1, 1], 0]);
}

// --- depth: pipeline state, cache key, and the auto-managed attachment --------
{
  let lastDesc = null, lastPass = null, made = [];
  const rp = { setPipeline: () => { }, setBindGroup: () => { }, draw: () => { }, end: () => { } };
  Object.assign(S.device, {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipeline: d => { lastDesc = d; return { getBindGroupLayout: () => ({}) }; },
    createTexture: d => { made.push(d); return { ...d.size, format: d.format, createView: () => ({ depthOf: d.size }) }; },
    createCommandEncoder: () => ({ beginRenderPass: d => { lastPass = d; return rp; }, finish: () => ({}) }),
  });
  S.device.queue.submit = () => { };

  const code = `@vertex fn vs_main(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(0.); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.); }`;
  const flat = await S.makeDraw({ code, format: 'rgba8unorm' });
  const deep = await S.makeDraw({ code, format: 'rgba8unorm', depth: true });
  check('depth is part of the pipeline cache key', flat.pipeline === deep.pipeline, false);
  check('depth: true sets the depthStencil state',
    lastDesc.depthStencil, { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' });

  const target = { width: 32, height: 16, format: 'rgba8unorm', createView: () => ({}) };
  deep.drawTo(target);
  check('drawTo creates a depth texture sized to the target',
    made.some(d => d.size.width === 32 && d.size.height === 16 && d.format === 'depth24plus'), true);
  check('the pass carries the depth attachment',
    [!!lastPass.depthStencilAttachment, lastPass.depthStencilAttachment?.depthLoadOp], [true, 'clear']);

  const before = made.length;
  deep.drawTo(target, 'load');
  check('the depth pool reuses the texture for the same size', made.length, before);
  check("'load' keeps the depth buffer too", lastPass.depthStencilAttachment.depthLoadOp, 'load');

  let threw = '';
  try { deep.drawTo({ label: 'a raw view the library never measured' }); } catch (e) { threw = e.message; }
  check('a raw view of unknown size asks for a texture or depth.texture', /size unknown/.test(threw), true);

  // compare/write/format overrides reach the descriptor
  await S.makeDraw({ code: code + '// v2', format: 'rgba8unorm', depth: { compare: 'less-equal', write: false } });
  check('depth overrides reach the descriptor',
    lastDesc.depthStencil, { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' });
}

// --- wgsl_shorthand ---------------------------------------------------------
{
  const full = shorthand(TOKENS, SHORT_TOKENS);
  check('shorthand expands long tokens', full('fn f(a: VEC3) -> FLOAT'), 'fn f(a: vec3<f32>) -> f32');
  check('shorthand expands short tokens', full('var x: X = X(F(1), 2., 3., PI);'),
    'var x: vec4<f32> = vec4<f32>(f32(1), 2., 3., 3.14159265359);');
  check('U3 wins over U', full('var a: U3; var b: U;'), 'var a: vec3<u32>; var b: u32;');
  check('identifiers untouched', full('let Fresnel = myF + PIx;'), 'let Fresnel = myF + PIx;');
  const safe = shorthand();
  check('default set leaves one-letter names alone', safe('let F = 1.0; let v: VEC2;'),
    'let F = 1.0; let v: vec2<f32>;');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall tests passed');
