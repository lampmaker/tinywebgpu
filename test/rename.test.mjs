// Regression test for the `rename` build option in build-min.mjs.
//
// Runs against a tiny build with the RENAMES table from tools/build.tiny.config.mjs applied, and
// asserts three things: the long API names are really gone, the short codes drive the same
// behavior the other suites pin down under the long names, and the /*renamed:…*/ legend in the
// output documents the whole table — the legend is the renamed build's API contract.
//
// Usage: node tools/build-min.mjs tiny --with=msg --rename --out=test/.tiny-renamed.js &&
//        TWG_ENTRY=./.tiny-renamed.js node test/rename.test.mjs

import { readFile } from 'node:fs/promises';

const ENTRY = process.env.TWG_ENTRY ?? './.tiny-renamed.js';
const { WEBGPU } = await import(ENTRY);
const { RENAMES } = await import('../tools/build.tiny.config.mjs');

let failures = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// --- stub device (same shape as tiny.test.mjs) -------------------------------------------
let code = null, dispatched = null, draws = 0, writes = 0;
const cpass = { setPipeline() { }, setBindGroup() { }, dispatchWorkgroups: (...a) => { dispatched = a; }, end() { } };
const rpass = { setPipeline() { }, setBindGroup() { }, draw: () => { draws++; }, end() { } };

const G = WEBGPU();
G.device = {
  createBuffer: ({ size }) => ({ size }),
  createShaderModule: ({ code: c }) => { code = c; return { getCompilationInfo: async () => ({ messages: [] }) }; },
  createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createBindGroup: () => ({}),
  createCommandEncoder: () => ({ beginComputePass: () => cpass, beginRenderPass: () => rpass, finish() { } }),
  queue: { submit() { }, writeBuffer() { writes++; } },
};
G.format = 'bgra8unorm';

// --- the long names are gone from the instance -------------------------------------------
check('no long name from the table survives on G',
  Object.keys(RENAMES).filter(k => G[k] !== undefined), []);

// --- ...and the short codes do the same work ---------------------------------------------
const buf = G.cSB(Float32Array.from([1, 2, 3, 4]));                    // createStorageBuffer
check('cSB sizes and fills like createStorageBuffer', buf.b.size, 16);
buf.b.usage = 128;                    // GPUBufferUsage.STORAGE
buf.b.mapAsync = () => { };

const c = await G.mC('', 'if (gid.x < UB.n) { out[gid.x] = 1.0; }',    // makeCompute
  { n: 'u32' }, { out: 'array<f32>' }, { wg: [64, 1, 1] });
check('mC still generates the uniform struct', /var<uniform> UB: Uniforms/.test(code), true);
check('setResources/setUniforms are gone from the pipeline', [c.setResources, c.setUniforms], [undefined, undefined]);
c.sR({ out: buf });                                                    // setResources
c.sU({ n: 4 });                                                        // setUniforms
c.run(1000);
check('sR + sU + run dispatch as before', dispatched, [16, 1, 1]);
writes = 0;
c.uS = { n: 9 };                                                       // the `uniforms` setter
check('the uS setter still uploads', writes, 1);

const r = await G.mF('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(uv, 0., 1.); }');  // makeFrag
r.dT({});                                                              // drawTo
check('mF + dT draw the fullscreen triangle', [draws, /fn vs_main/.test(code)], [1, true]);

// --- the legend is the contract -----------------------------------------------------------
// The legend lists only the pairs that survived into this build (stripped features drop their
// renames with them), so: everything it lists must come from the table, and everything this
// test exercised must be listed.
const text = await readFile(new URL(ENTRY, import.meta.url), 'utf8');
const legend = /\/\*renamed:([^*]*)\*\//.exec(text)?.[1] ?? '';
check('every legend pair comes from the RENAMES table',
  legend.split(',').filter(p => { const [short, long] = p.split('='); return RENAMES[long] !== short; }), []);
check('the exercised codes are in the legend',
  ['mF', 'mC', 'cSB', 'sR', 'sU', 'uS', 'dT'].filter(s => !legend.includes(`${s}=`)), []);
check('one line of code; only legend comments on the lines below',
  text.trimEnd().split('\n').filter((l, i) => i > 0 && !/^\/\*.*\*\/$/.test(l)), []);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall renamed-build tests passed');
