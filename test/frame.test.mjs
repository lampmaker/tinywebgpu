// Regression tests for the encoder/pass lifecycle — the part the examples lean on hardest and
// the part a stubbed layout test says nothing about.
//
// The device stub here records the GPU command stream in order, so each case can assert the
// *shape* of what was submitted: how many encoders were opened, where the passes started and
// ended, that a staged write lands between the dispatches it is supposed to separate, and that a
// pass torn down around that write comes back with its pipeline rebound. Those are invariants the
// frame API promises and that no amount of "it returned without throwing" would catch.
//
// The call sequences mirror the examples: 3_life and 7_particles (beginFrame batching),
// 4_indirect (indirect dispatch inside a frame), 6_evolution (beginCompute chaining with
// setUniforms between the dispatches).
//
// Usage: node test/frame.test.mjs
//        TWG_ENTRY=../tinywebgpu.min.js node test/frame.test.mjs

const ENTRY = process.env.TWG_ENTRY ?? '../tinywebgpu.js';
const { WEBGPU } = await import(ENTRY);

let failures = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// --- recording device stub ------------------------------------------------------------------
// Every call appends a tag to `log`, so a test can assert the whole stream rather than a count.
let log = [];
let encoders = 0;
const G = WEBGPU();

const makePass = kind => ({
  setPipeline: () => log.push(`${kind}:setPipeline`),
  setBindGroup: () => log.push(`${kind}:setBindGroup`),
  dispatchWorkgroups: (...a) => log.push(`dispatch(${a})`),
  dispatchWorkgroupsIndirect: b => log.push(b?.b ? 'dispatchIndirect:handle-not-unwrapped' : 'dispatchIndirect'),
  draw: () => log.push('draw'),
  end: () => log.push(`${kind}:end`),
});

G.device = {
  destroy: () => log.push('deviceDestroy'),
  createBuffer: ({ size }) => ({ size, usage: 128, mapAsync: () => { }, destroy: () => log.push('bufDestroy') }),
  createTexture: () => ({ createView: () => ({}) }),
  createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
  createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createBindGroup: () => ({}),
  createCommandEncoder: () => {
    const id = ++encoders;
    log.push(`encoder${id}`);
    return {
      beginComputePass: (o = {}) => { log.push('cpass' + (o.tag ? `[${o.tag}]` : '')); return makePass('cpass'); },
      beginRenderPass: () => { log.push('rpass'); return makePass('rpass'); },
      copyBufferToBuffer: () => log.push('copyB2B'),
      clearBuffer: () => log.push('clearBuffer'),
      finish: () => `cmd${id}`,
    };
  },
  queue: {
    submit: () => log.push('submit'),
    writeBuffer: () => log.push('writeBuffer'),
  },
  // DIAG builds wrap pipeline and bind-group creation in a validation scope.
  pushErrorScope: () => { },
  popErrorScope: async () => null,
};
G.format = 'bgra8unorm';

const reset = () => { log = []; encoders = 0; };

// --- pipelines ---------------------------------------------------------------------------------
const buf = G.createStorageBuffer(1024);
const indirect = G.createIndirectBuffer();

const sim = await G.makeCompute('', 'if (gid.x < UB.n) { data[gid.x] = UB.step; }',
  { n: 'u32', step: 'f32' }, { data: 'array<f32>' }, { wg: [64, 1, 1] });
sim.setResources({ data: buf });

// A second pipeline, so the chain can be checked for rebinding when the pipeline changes.
const other = await G.makeCompute('', 'data[gid.x] = 1.0;', {}, { data: 'array<f32>' }, { wg: [64, 1, 1] });
other.setResources({ data: buf });

const draw = await G.makeFrag('fn frag(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(uv, 0., 1.); }');

// --- outside a frame, every call submits on its own ----------------------------------------
reset();
sim.dispatch(4);
check('bare dispatch: own encoder, own pass, own submit',
  log, ['encoder1', 'cpass', 'cpass:setPipeline', 'cpass:setBindGroup', 'dispatch(4,1,1)', 'cpass:end', 'submit']);

reset();
sim.setUniforms({ n: 8 });
check('bare uniform write is a plain queue write', log, ['writeBuffer']);

// --- beginFrame batching: examples 3, 4, 7 ---------------------------------------------------
reset();
G.beginFrame();
sim.dispatch(2);
sim.dispatchIndirect(indirect.b, 0);
draw.drawTo({});
G.endFrame();
check('beginFrame: one encoder and one submit for three passes',
  [log.filter(l => l.startsWith('encoder')).length, log.filter(l => l === 'submit').length], [1, 1]);
check('beginFrame: passes run in call order, each opened and closed',
  log.filter(l => /^[cr]pass(:end)?$|^dispatch|^draw/.test(l)),
  ['cpass', 'dispatch(2,1,1)', 'cpass:end', 'cpass', 'dispatchIndirect', 'cpass:end', 'rpass', 'draw', 'rpass:end']);

// --- in-frame writes are staged and flushed before the submit ------------------------------
reset();
G.beginFrame();
sim.setUniforms({ n: 16 });          // staged: copied inside the frame encoder
sim.dispatch(1);
buf.clear();                          // also frame-ordered
G.endFrame();
check('in-frame uniform write becomes a copy, not a queue write',
  log.indexOf('copyB2B') >= 0 && log.indexOf('copyB2B') < log.indexOf('dispatch(1,1,1)'), true);
check('in-frame clear() is encoded, not self-submitted',
  log.filter(l => l === 'clearBuffer' || l === 'submit'), ['clearBuffer', 'submit']);
check('the staging ring is flushed before the frame is submitted',
  log.indexOf('writeBuffer') >= 0 && log.indexOf('writeBuffer') < log.lastIndexOf('submit'), true);

// --- beginCompute chaining: dispatches join the open pass and bind at most once --------------
reset();
G.beginCompute();
sim.dispatch(1);
sim.dispatch(1);
G.endCompute();
check('chained dispatches share one pass and bind once',
  log, ['encoder1', 'cpass', 'cpass:setPipeline', 'cpass:setBindGroup',
    'dispatch(1,1,1)', 'dispatch(1,1,1)', 'cpass:end', 'submit']);

// Switching pipelines mid-chain has to rebind; switching back has to rebind again.
reset();
G.beginCompute();
sim.dispatch(1);
other.dispatch(1);
other.dispatch(1);
sim.dispatch(1);
G.endCompute();
check('a chain rebinds only when the pipeline actually changes',
  log.filter(l => l === 'cpass:setPipeline' || l.startsWith('dispatch')),
  ['cpass:setPipeline', 'dispatch(1,1,1)', 'cpass:setPipeline', 'dispatch(1,1,1)',
    'dispatch(1,1,1)', 'cpass:setPipeline', 'dispatch(1,1,1)']);

// --- a staged write mid-chain: example 6 ----------------------------------------------------
// This is the sharp one. A copy cannot be encoded inside a pass, so setUniforms between two
// dispatches has to close the pass, encode the copy, reopen it and rebind the pipeline —
// otherwise the second dispatch runs against no pipeline, or against the previous frame's values.
reset();
G.beginCompute();
sim.setUniforms({ step: 0 });
sim.dispatch(4);
sim.setUniforms({ step: 1 });
sim.dispatch(4);
G.endCompute();
check('beginCompute outside a frame opens one encoder and submits it once',
  [log.filter(l => l.startsWith('encoder')).length, log.filter(l => l === 'submit').length], [1, 1]);
check('a mid-chain write closes the pass, copies, reopens and rebinds',
  log,
  ['encoder1', 'cpass',
    // first setUniforms: nothing bound yet, so the reopened pass is left for dispatch to bind
    'cpass:end', 'copyB2B', 'cpass',
    'cpass:setPipeline', 'cpass:setBindGroup', 'dispatch(4,1,1)',
    // second setUniforms: torn down again, and this time the reopen restores the binding
    'cpass:end', 'copyB2B', 'cpass', 'cpass:setPipeline', 'cpass:setBindGroup',
    'dispatch(4,1,1)',
    'cpass:end', 'writeBuffer', 'submit']);

// --- beginCompute inside a frame: the frame owns the submit ---------------------------------
reset();
G.beginFrame();
G.beginCompute();
sim.dispatch(2);
G.endCompute();
check('endCompute inside a frame does not submit', log.filter(l => l === 'submit'), []);
G.endFrame();
check('the enclosing frame submits once', log.filter(l => l === 'submit'), ['submit']);

// --- drawTo while a chained pass is open closes it: a render pass cannot nest -----------------
reset();
G.beginFrame();
G.beginCompute();
sim.dispatch(1);
draw.drawTo({});
G.endFrame();
check('drawTo mid-chain closes the compute pass rather than nesting',
  log.filter(l => /^[cr]pass(:end)?$/.test(l)), ['cpass', 'cpass:end', 'rpass', 'rpass:end']);

// --- bindTo is the escape hatch for a pass you opened yourself --------------------------------
reset();
const pass = G.beginCompute();
sim.bindTo(pass);
check('bindTo binds the pipeline to the given pass',
  log, ['encoder1', 'cpass', 'cpass:setPipeline', 'cpass:setBindGroup']);
G.endCompute();

// --- beginCompute options survive a mid-chain reopen ------------------------------------------
// A staged write closes and reopens the chained pass; the reopened pass must carry the same
// descriptor (think timestampWrites), not a bare {}.
reset();
G.beginCompute({ tag: 'q' });
sim.setUniforms({ step: 2 });          // staged: closes the pass, copies, reopens it
sim.dispatch(1);
G.endCompute();
check('a mid-chain reopen keeps the beginCompute descriptor',
  log.filter(l => l === 'cpass[q]').length, 2);

// --- dispatchIndirect accepts the handle, not just the raw buffer ----------------------------
reset();
G.beginFrame();
sim.dispatchIndirect(indirect, 0);     // the {b, w} handle itself
G.endFrame();
check('dispatchIndirect unwraps a buffer handle', log.includes('dispatchIndirect'), true);

// --- beginFrame twice: the dangling frame is submitted, not leaked ---------------------------
reset();
G.beginFrame();
sim.dispatch(1);
G.beginFrame();                       // no endFrame — the first one must still go out
G.endFrame();
check('a second beginFrame submits the first frame instead of dropping it',
  [log.filter(l => l.startsWith('encoder')).length, log.filter(l => l === 'submit').length], [2, 2]);

// --- G.frame(): begin/endFrame around a callback, exception-safe -----------------------------
reset();
G.frame(() => sim.dispatch(1));
check('frame() wraps one encoder and one submit around the callback',
  [log.filter(l => l.startsWith('encoder')).length, log.filter(l => l === 'submit').length], [1, 1]);

reset();
let threw = '';
try { G.frame(() => { sim.dispatch(1); throw Error('boom'); }); } catch (e) { threw = e.message; }
check('frame() still submits when the callback throws',
  [threw, log.filter(l => l === 'submit')], ['boom', ['submit']]);

// --- destroy(): pooled resources and the device go; must stay the LAST test ------------------
reset();
G.destroy();
check('destroy() releases the staging ring and the device, and clears G.device',
  [log.includes('bufDestroy'), log.includes('deviceDestroy'), G.device], [true, true, 0]);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall frame-lifecycle tests passed');
