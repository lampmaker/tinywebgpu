// Regression test for the build switches in build-min.mjs.
//
// layout.test.mjs runs against a build with every feature *on*, so it says nothing about what a
// stripped one does. This runs against the fully stripped `--tiny` bundle and asserts two things:
// that the optional entry points really are gone, and that the core still works without them —
// a feature guard drawn one line too wide would take a chunk of makePipeline with it and the
// suite would otherwise never notice.
//
// Usage: node build-min.mjs --tiny --out=test/.tiny.js && TWG_ENTRY=./.tiny.js node test/tiny.test.mjs

const ENTRY = process.env.TWG_ENTRY ?? './.tiny.js';
const { WEBGPU } = await import(ENTRY);

let failures = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// --- stub device -------------------------------------------------------------------------
let code = null, dispatched = null, draws = 0;
const cpass = { setPipeline() { }, setBindGroup() { }, dispatchWorkgroups: (...a) => { dispatched = a; }, end() { } };
const rpass = { setPipeline() { }, setBindGroup() { }, draw: () => { draws++; }, end() { } };

const G = WEBGPU();
let writes = 0;
G.device = {
  createBuffer: ({ size }) => ({ size }),
  createTexture: () => ({ createView: () => ({}) }),
  createShaderModule: ({ code: c }) => { code = c; return { getCompilationInfo: async () => ({ messages: [] }) }; },
  createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createBindGroup: () => ({}),
  createCommandEncoder: () => ({ beginComputePass: () => cpass, beginRenderPass: () => rpass, finish() { } }),
  queue: { submit() { }, writeBuffer() { writes++; } },
};
G.format = 'bgra8unorm';

// --- the optional groups are gone --------------------------------------------------------
check('texio / read / save / show / pingpong / resize / mips are absent',
  ['writeTexture', 'loadTexture', 'readTexture', 'save', 'show', 'pingPong', 'createPingPong',
    'createPingPongTexture', 'resizeCanvas', 'generateMipmaps'].filter(k => G[k] !== undefined), []);

// --- ...and the core is not ---------------------------------------------------------------
const buf = G.createStorageBuffer(Float32Array.from([1, 2, 3, 4]));
check('createStorageBuffer still sizes and fills', buf.b.size, 16);
check('the readback helper went with F_READ', [buf.r, buf.read], [undefined, undefined]);
check('write and clear stayed', [typeof buf.w, typeof buf.clear], ['function', 'function']);
check('the long aliases went with F_ALIASES',
  [buf.buffer, buf.write, buf.read], [undefined, undefined, undefined]);

buf.b.usage = 128;                    // GPUBufferUsage.STORAGE
buf.b.mapAsync = () => { };

const c = await G.makeCompute('', 'if (gid.x < UB.n) { out[gid.x] = 1.0; }',
  { n: 'u32' }, { out: 'array<f32>' }, { wg: [64, 1, 1] });
c.setResources({ out: buf });
c.setUniforms({ n: 4 });
c.run(1000);
check('compute dispatches, item count divided by wg', dispatched, [16, 1, 1]);
check('the uniform struct is still generated', /var<uniform> UB: Uniforms/.test(code), true);

const r = await G.makeFrag('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(uv, 0., 1.); }');
r.drawTo({});
check('render draws the fullscreen triangle', [draws, /fn vs_main/.test(code)], [1, true]);

G.beginFrame(); c.run(64); G.endFrame();
check('the frame API records and submits', dispatched, [1, 1, 1]);

// Without F_STAGING an in-frame uniform write falls back to a plain queue write (last value
// set before endFrame wins for the whole frame) instead of a staged copy.
writes = 0;
G.beginFrame(); c.setUniforms({ n: 9 }); c.run(64); G.endFrame();
check('without staging, an in-frame uniform write is a queue write', writes, 1);
check('field getters went with F_ALIASES', [c.uniformFields, c.resourceFields], [undefined, undefined]);

// --- error text folded to numbers ----------------------------------------------------------
// drawTo with no view and no canvas context is error 7; see the ERRORS table in build-min.mjs.
let threw = '';
try { r.drawTo(); } catch (e) { threw = e.message; }
check('MSG off throws the numbered error', threw, '7');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall tiny-build tests passed');
