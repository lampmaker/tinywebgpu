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
  const r = S.makeUniformsAndResources(uniforms);
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

  const p = await S.compute2D({
    body: 'if (gid.x < UB.n) { a[gid.x] = b[gid.x]; }',
    uniforms: { n: 'u32' }, resources: { a: 'array<f32>', b: 'array<f32>' },
    wg: [64, 1, 1],
  });
  // compute2D used to pass `body` as declarations and generate an empty main, so the shader
  // was invalid WGSL and the entry point did nothing
  check('compute2D puts the body in the entry point',
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
  await S.makeRender('fn frag(uv: vec2<f32>) -> vec4<f32> { return textureLoad(kept, vec2<i32>(0), 0); }',
    {}, { dropped: 'array<f32>', kept: 'texture_2d<f32>' });
  check('unused resource is not declared', /dropped/.test(lastCode), false);
  check('used resource keeps binding 0', /@binding\(0\) var kept/.test(lastCode), true);

  // Uniforms the shader ignores keep their buffer and setters, but not their binding.
  const q = await S.makeRender('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(uv, 0., 1.); }',
    { time: 'f32' }, {});
  check('unreferenced UB is not bound', /var<uniform>/.test(lastCode), false);
  q.setUniforms({ time: 1 });                       // must still work rather than throw
  check('unreferenced UB still accepts writes', true, true);

  // MRT: the FSOut struct and its @location order are generated from the targets schema.
  await S.makeRender('fn frag(uv: vec2<f32>) -> FSOut { var o: FSOut; return o; }',
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
