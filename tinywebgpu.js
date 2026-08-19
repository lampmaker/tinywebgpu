/*
Terminology cheatsheet:
  • Buffer  = linear GPU memory. Uniform buffers are small and read-only in shaders; storage buffers are big and read/write.
  • Texture = image memory (pixels): sampled, written via textureStore, or drawn into as a render target.
  • Sampler = how a texture is read (nearest/linear, clamp/repeat).
  • BindGroup = the set of resources a shader sees at @group(N).
  • Pipeline = compiled program + fixed state; render (vertex+fragment) or compute.
  • CommandEncoder = records GPU commands for one submission. Record passes, then submit.
  • Workgroup = a tile of threads in a compute shader (@workgroup_size(x,y)); you dispatch many of them.
*/

/**
 * @typedef {Object.<string, string>} UniformSchema
 *   name → WGSL basic type: 'f32'|'i32'|'u32'|'vec2/3/4<f32|u32|i32>'|'mat4x4<f32>'.
 *   Generated into a WGSL struct bound as `UB` at @group(0) @binding(0), WGSL layout rules.
 * @typedef {Object.<string, string>} ResourceSchema
 *   name → full WGSL resource type: 'array<T>', 'struct Foo {...}', 'texture_2d<f32>',
 *   'texture_storage_2d<...>', 'sampler', or a primitive (auto-wrapped in a struct).
 *
 * @typedef {Object} BufferHandle
 * @property {GPUBuffer} b - the raw buffer; alias `buffer`
 * @property {(data: BufferSource, byteOffset?: number) => void} w - write; alias `write`. Frame-ordered inside beginFrame().
 * @property {(nbytes?: number, byteOffset?: number, Ctor?: Function) => Promise<*>} r - readback; alias `read`. Debug tool: it stalls the pipeline.
 * @property {() => void} clear - zero the buffer (storage buffers only)
 *
 * @typedef {Object} Pipeline
 * @property {GPURenderPipeline|GPUComputePipeline} pipeline
 * @property {(values: Object) => void} setUniforms - merge values into the CPU struct and upload
 * @property {(name: string, value: *) => void} setUniform
 * @property {(values: Object) => void} setResources - (re)build the bind group; pass GPUBuffers / textures / views
 * @property {string[]} uniformFields
 * @property {string[]} resourceFields
 *
 * @typedef {Pipeline & {
 *   dispatch: (x?: number, y?: number, z?: number, encoder?: GPUCommandEncoder) => void,
 *   run: (w?: number, h?: number, d?: number, encoder?: GPUCommandEncoder) => void,
 *   dispatchIndirect: (buffer: GPUBuffer, byteOffset?: number, encoder?: GPUCommandEncoder) => void,
 *   bindTo: (pass?: GPUComputePassEncoder) => void,
 * }} ComputePipeline
 *   All three recording calls join the pass `beginCompute()` opened, when one is open, and
 *   rebind only if the last pipeline bound to it was a different one.
 *
 * @typedef {Pipeline & {
 *   drawTo: (view?: GPUTextureView, clear?: number[]|'load', encoder?: GPUCommandEncoder) => void,
 *   count: number,
 *   instances: number,
 * }} RenderPipeline
 *   `count` (vertices per instance) and `instances` are what drawTo passes to draw(), and are
 *   writable — a per-frame particle count does not need a new pipeline.
 */







/*
                                                                                            
                                88                      88                                  
                                ""    ,d                88                                  
                                      88                88                                  
 ,adPPYba,  8b      db      d8  88  MM88MMM  ,adPPYba,  88,dPPYba,    ,adPPYba,  ,adPPYba,  
 I8[    ""  `8b    d88b    d8'  88    88    a8"     ""  88P'    "8a  a8P_____88  I8[    ""  
  `"Y8ba,    `8b  d8'`8b  d8'   88    88    8b          88       88  8PP"""""""   `"Y8ba,   
 aa    ]8I    `8bd8'  `8bd8'    88    88,   "8a,   ,aa  88       88  "8b,   ,aa  aa    ]8I  
 `"YbbdP"'      YP      YP      88    "Y888  `"Ybbd8"'  88       88   `"Ybbd8"'  `"YbbdP"'  
                                                                                                                                                                                                  
Build-time switches                                                                                                                                                                                                  
*/
// All true in the source you develop against, so nothing below is optional while you work.
// build-min.mjs flips them by name and lets dead-code elimination remove whatever they guard,
// which is how one file serves both the full library and a build small enough to inline into a
// <script> tag. Leave the line shape intact — build-min.mjs matches `const NAME = true;` literally.
// These stay `const` while the rest of the file uses `let`: esbuild constant-folds a `const`
// initialized to a literal and does NOT fold a `let`, so `let` here would keep every guarded
// branch in the stripped builds.
//
// DIAG: the WGSL compile-log formatter, bind-group validation, the buffer-size check and every
// debug `label:`. Console calls are stripped separately. Errors still throw.
const DIAG = true;
// MSG: human-readable error text. Off, throws carry a number — see ERRORS in build-min.mjs.
const MSG = true;
// The rest guard whole entry points. Dependencies are enforced by build-min.mjs.
const F_TEXIO = true;     // writeTexture, loadTexture — CPU pixels in
const F_READ = true;      // GPU→CPU readback: buffer .r(), readTexture, the staging pool
const F_SAVE = true;      // save() — needs F_READ
const F_SHOW = true;      // show() — the one-call "let me look at that texture" blit
const F_PINGPONG = true;  // pingPong, createPingPong, createPingPongTexture
const F_RESIZE = true;    // resizeCanvas
const F_BLEND = true;     // the named blend presets ('alpha' | 'premultiplied' | 'additive')
const F_DEPTH = true;     // makeDraw({depth}) — depth testing with an auto-managed depth texture
const F_MIPS = true;      // generateMipmaps, and the mips option on createTexture/loadTexture
// F_STAGING: the staging ring that makes writes frame-ordered, so per-dispatch uniform values
// work inside one beginFrame() submit. Without it, writes inside a frame become plain queue
// writes — they execute before the frame's submit, so the *last* value set wins for the whole
// frame. A piece that sets uniforms once per frame (most fullscreen art) never sees the
// difference; drop it for the bytes.
const F_STAGING = true;
// F_ALIASES: the readable long names — buffer/write/read on handles, uniformFields /
// resourceFields on pipelines. The short forms (b/w/r) always exist.
const F_ALIASES = true;

// The generated uniform variable's name; makePipeline tests the shader for it.
const UNIFORM_VAR = 'UB';








/*
                                                                                             
I8,        8        ,8I  88888888888  88888888ba     ,ad8888ba,   88888888ba   88        88  
`8b       d8b       d8'  88           88      "8b   d8"'    `"8b  88      "8b  88        88  
 "8,     ,8"8,     ,8"   88           88      ,8P  d8'            88      ,8P  88        88  
  Y8     8P Y8     8P    88aaaaa      88aaaaaa8P'  88             88aaaaaa8P'  88        88  
  `8b   d8' `8b   d8'    88"""""      88""""""8b,  88      88888  88""""""'    88        88  
   `8a a8'   `8a a8'     88           88      `8b  Y8,        88  88           88        88  
    `8a8'     `8a8'      88           88      a8P   Y8a.    .a88  88           Y8a.    .a8P  
     `8'       `8'       88888888888  88888888P"     `"Y88888P"   88            `"Y8888Y"'   
                                                                                             
                                                                                             
*/

/**
 * Creates an independent toolkit instance. Call `await G.init(ctx?)` before anything else.
 */
export let WEBGPU = () => {
  // Hot state lives in closure variables rather than on the instance. Both forms cost the same to
  // read at runtime, but a closure variable is renamed to one character by the minifier while
  // `S.frame.encoder` survives verbatim. `device` keeps its public name through an accessor pair
  // for the same reason: the getter/setter costs ~40 bytes once and saves seven at each of its
  // thirty-odd uses.
  // "Empty" is `0` rather than `null` throughout the file: one byte instead of four, and every
  // check stays a plain falsy test. The cost is that the nullish operators cannot guard these —
  // `??`/`??=` become `||`/`||=`, and `x?.y()` / `x?.()` become `x && x.y()` (0 is not nullish,
  // so `?.` would reach right through it). Fine here, since the real values are all objects.
  let
    D = 0,                     // the GPUDevice, behind S.device
    fEnc = 0,                  // the open frame's command encoder, 0 outside a frame
    fView = 0,                 // that frame's render target, acquired lazily by targetView()
    fPass = 0,                 // the open chained compute pass, if beginCompute() opened one
    fPassOpts = 0,             // that pass's descriptor, so a mid-chain reopen keeps e.g. timestampWrites
    fOwned = false,            // the encoder came from beginCompute(), so endCompute() submits it
    fBound = 0,                // the bind fn of the pipeline currently bound to fPass
    shaderCache = new Map(), pipelineCache = new Map();

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  let S = {
    // ─── Device & lifecycle ──────────────────────────────────────────────────────────────────
    get device() { return D; },
    set device(d) { D = d; },
    context: 0, format: 0, features: 0,

    debug: false,                // extra per-uniform warnings; DIAG builds only
    // Optional WGSL preprocessing hook, `(src: string) => string`, applied before hashing and
    // compiling. Must be deterministic — the shader and pipeline caches key on its output.
    // For token shorthands see the companion module wgsl_shorthand.js.
    pre: 0,
    // Called with the GPUDeviceLostInfo on a context crash, driver reset or tab backgrounding.
    // The library logs regardless; set this to rebuild.
    onDeviceLost: 0,







    /**
                              
88               88           
""               ""    ,d     
                       88     
88  8b,dPPYba,   88  MM88MMM  
88  88P'   `"8a  88    88     
88  88       88  88    88     
88  88       88  88    88,    
88  88       88  88    "Y888  
                                    
                                        
    * Initializes WebGPU. Pass a canvas 'webgpu' context, a canvas element / OffscreenCanvas, or
     * a CSS selector for one to render — or nothing for compute-only use (render calls then need
     * an explicit target view). Requests the adapter's max buffer-size limits. Throws if WebGPU
     * is unavailable.
     * @param {GPUCanvasContext|HTMLCanvasElement|OffscreenCanvas|string|0} [ctx]
     * @param {{features?: string[], limits?: Object, alphaMode?: string, canvasUsage?: number}} [opts]
     *   `features` are best-effort: any the adapter lacks are dropped with a warning rather than
     *   throwing, so check `G.features` for what was granted.
     * @returns {Promise<Object>} this instance, with device/context/format/features populated
     */
    init: async (ctx = 0, opts = {}) => {
      if (!navigator.gpu) err(1, MSG && 'WebGPU not supported');
      if (typeof ctx === 'string') {
        let sel = ctx;
        ctx = document.querySelector(sel);
        if (!ctx) err(23, MSG && `init: nothing matches '${sel}'.`);
      }
      if (ctx?.getContext) ctx = ctx.getContext('webgpu');   // a canvas rather than a context
      let a = await navigator.gpu.requestAdapter();
      if (!a) err(2, MSG && 'No GPU adapter');

      // Raise these to whatever the adapter allows; anything in opts.limits still wins.
      let requiredLimits = { ...opts.limits };
      for (let k of ['maxStorageBufferBindingSize', 'maxBufferSize']) requiredLimits[k] ??= a.limits[k];

      // Asking for a feature the adapter lacks would throw, so filter first.
      let wanted = opts.features ?? [];
      let requiredFeatures = wanted.filter(f => a.features.has(f));
      if (DIAG) {
        let dropped = wanted.filter(f => !a.features.has(f));
        if (dropped.length) console.warn(`[TinyWebGPU] Adapter does not support ${dropped.map(f => `'${f}'`).join(', ')}; continuing without.`);
      }

      let d = await a.requestDevice({ requiredLimits, requiredFeatures });
      d.lost.then(info => info.reason !== 'destroyed' && (   // 'destroyed' = G.destroy(), not a loss
        console.error(`[TinyWebGPU] GPU device lost (${info.reason || 'unknown'}): ${info.message}`),
        S.onDeviceLost && S.onDeviceLost(info)));
      // The handler's whole body is the log, so without DIAG there is nothing left to install.
      if (DIAG) d.onuncapturederror = e => console.error('[TinyWebGPU] Uncaptured WebGPU error:', e.error?.message ?? e);
      let f = navigator.gpu.getPreferredCanvasFormat();
      // usage defaults to RENDER_ATTACHMENT, as the spec does; add COPY_SRC to it if you want to
      // G.save() the canvas texture itself rather than your own render target.
      if (ctx) ctx.configure({ device: d, format: f, alphaMode: opts.alphaMode ?? 'opaque', usage: opts.canvasUsage ?? TEX_RENDER_ATTACHMENT });
      OA(S, { device: d, context: ctx, format: f, features: d.features });
      return S;
    },

    /**
     * Tears the instance down: destroys the device and every pooled GPU resource, and empties
     * the caches. For SPA teardown, hot-reload dev servers and live-coding pages — the leak
     * those environments hit otherwise is real. The instance is not reusable afterwards.
     */
    destroy: () => {
      endPass();
      fEnc = 0;
      fReset();
      if (F_STAGING) { for (let c of ring._chunks) c._buf.destroy(); ring._chunks = []; ring._i = 0; }
      if (F_READ) { for (let l of stagingPool.values()) for (let b of l) b.destroy(); stagingPool.clear(); }
      if (F_DEPTH) { for (let t of depthCache.values()) t.destroy(); depthCache.clear(); }
      if (F_SHOW) blitCache.clear();
      shaderCache.clear(); pipelineCache.clear();
      D && D.destroy();   // `&&`, not `?.` — the empty value is 0, which `?.` would try to call through
      D = 0;
    },





    /*
                                                                                          
    88888888ba   88                           88  88                                      
    88      "8b  ""                           88  ""                                      
    88      ,8P                               88                                          
    88aaaaaa8P'  88  8b,dPPYba,    ,adPPYba,  88  88  8b,dPPYba,    ,adPPYba,  ,adPPYba,  
    88""""""'    88  88P'    "8a  a8P_____88  88  88  88P'   `"8a  a8P_____88  I8[    ""  
    88           88  88       d8  8PP"""""""  88  88  88       88  8PP"""""""   `"Y8ba,   
    88           88  88b,   ,a8"  "8b,   ,aa  88  88  88       88  "8b,   ,aa  aa    ]8I  
    88           88  88`YbbdP"'    `"Ybbd8"'  88  88  88       88   `"Ybbd8"'  `"YbbdP"'  
                     88                                                                   
                     88                                                                   
    /*  /**
         * A fullscreen-triangle render pipeline: you write `fn frag(uv: vec2<f32>) -> vec4<f32>`,
         * the vertex shader and the fs_main wrapper are generated.
         * @param {string} frag WGSL containing the frag function, plus any helpers
         * @param {UniformSchema} [uniforms] @param {ResourceSchema} [resources]
         * @param {{format?: string|string[], blend?: string|GPUBlendState, targets?: Object}} [opts]
         *   `blend`: 'alpha' | 'premultiplied' | 'additive' or a raw GPUBlendState; omitted = opaque.
         *   `targets`: {name: format} for multiple render targets, drawn with `drawTo({name: view})`.
         * @returns {Promise<RenderPipeline>}
         */
    makeFrag: (frag, uniforms = {}, resources = {}, { format = S.format, blend, targets, depth } = {}) =>
      // The fullscreen triangle and the wrapper that hands `frag` its uv. Everything else — the
      // schema, the FSOut struct for `targets`, the pipeline — is makeDraw's job.
      S.makeDraw({
        code: `struct VSOut {@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
var ndc = array<vec2<f32>,3>(vec2<f32>(-1.,-3.),vec2<f32>(-1.,1.),vec2<f32>(3.,1.))[i];
var o: VSOut; o.pos = vec4<f32>(ndc, 0.0, 1.0); o.uv = ndc * 0.5 + vec2<f32>(0.5); return o;
}
${frag}
@fragment fn fs_main(vs: VSOut) -> ${targets ? 'FSOut' : '@location(0) vec4<f32>'} { return frag(vs.uv); }
`.trim(), uniforms, resources, format, blend, targets, depth
      }),

    /**
     * A render pipeline where you write the vertex stage yourself — `makeFrag`'s sibling for
     * geometry that is not a fullscreen quad. `code` is complete WGSL (`@vertex fn vs_main` and
     * `@fragment fn fs_main`); only the schema is prepended.
     *
     * There are no vertex buffers, on purpose: pull geometry out of a storage buffer indexed by
     * `@builtin(vertex_index)` / `@builtin(instance_index)`. Any resource the *vertex* stage reads
     * must be named in `readOnly` — WebGPU forbids a `read_write` binding from being visible to
     * the vertex stage, and `read_write` is what the schema emits by default.
     * `depth` turns on depth testing: `true` for the defaults (depth24plus, less, write on, an
     * auto-managed depth texture sized to the target), or `{format?, compare?, write?, texture?}`
     * to override any of them — `texture` hands over your own depth texture.
     * @param {{code: string, uniforms?: UniformSchema, resources?: ResourceSchema,
     *   readOnly?: string[], count?: number, instances?: number, topology?: string,
     *   format?: string|string[], blend?: string|GPUBlendState, targets?: Object,
     *   depth?: boolean|Object}} opts
     * @returns {Promise<RenderPipeline>}
     */
    makeDraw: ({ code, uniforms = {}, resources = {}, readOnly = [], count = 3, instances = 1,
      topology = 'triangle-list', format = S.format, blend, targets, depth }) => {
      // `targets` is {name: format}; the matching `struct FSOut { … }` is generated here so the
      // @location indices — the part that is easy to get wrong by hand — follow the key order.
      // WGSL module-scope declarations are order-independent, so the struct may land above the
      // shader that returns it.
      let names = targets ? OK(targets) : 0;
      let outStruct = names ? `struct FSOut {${names.map((n, i) => `@location(${i}) ${n}: vec4<f32>`).join(', ')}};\n` : '';
      return makePipeline({
        code: `${outStruct}${code}`, uniforms, resources, readOnly,
        isCompute: false, blend, targetNames: names, count, instances, topology, depth,
        format: names ? OV(targets) : format,
      });
    },

    /**
     * A compute pipeline. `body` holds declarations (helper functions, structs); `main` holds the
     * statements of the generated entry point, which receives `gid`, `lid` and `wid`.
     * @param {string} body @param {string} main
     * @param {UniformSchema} [uniforms] @param {ResourceSchema} [resources]
     * @param {{wg?: number[]}} [opts] workgroup size, default [8,8,1]
     * @returns {Promise<ComputePipeline>}
     */
    makeCompute: (body, main, uniforms = {}, resources = {}, { wg = [8, 8, 1] } = {}) => (
      // Missing axes default to 1 — `wg: [64]` used to interpolate `undefined` into the WGSL.
      wg = [wg[0] ?? 1, wg[1] ?? 1, wg[2] ?? 1],
      makePipeline({
      // Kept flush-left: this text is prepended to every generated shader, so it is hashed,
      // compiled, and line-numbered in compile errors.
      code: `${body}
@compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
${main}
}
`.trim(), uniforms, resources, isCompute: true, wg
    })),

    /**
     * `makeFrag` plus a `run(uniformValues?, view?)` that uploads and draws in one call.
     * Besides `clear`, every makeFrag option (format, blend, targets, depth) passes through.
     * @returns {Promise<RenderPipeline & {run: (u?: Object, view?: GPUTextureView) => void}>}
     */
    makeQuad: ({ frag, uniforms = {}, resources = {}, clear = [0, 0, 0, 1], ...opts }) =>
      S.makeFrag(frag, uniforms, resources, opts).then(p =>
        OA(p, { run: (u = {}, view = targetView()) => (u && OK(u).length && (p.uniforms = u), p.drawTo(view, clear)) })),

    /**
     * `makeCompute` with a default `size`, so `run()` with no arguments covers the whole grid.
     * `body` is the entry-point statements; `decls` is for helper functions and structs. Bounds-
     * check the tail with `if (gid.x >= n) { return; }` when the size is not a multiple of `wg`.
     * @returns {Promise<ComputePipeline & {run: (w?: number, h?: number, d?: number) => void}>}
     */
    // The .then callback's `run` parameter is a local capturing p.run before OA overwrites it.
    makeCompute2D: ({ body, decls = '', uniforms = {}, resources = {}, size = [1, 1], wg = [8, 8, 1] }) =>
      S.makeCompute(decls, body, uniforms, resources, { wg }).then((p, run = p.run) =>
        OA(p, { run: (w = size[0], h = size[1], d = 1, encoder) => run(w, h, d, encoder) })),







    /*
                                                                                                                                                             
    88888888888                                                         88                                           88           88                            
    88                                                                  88                         ,d                88           ""                            
    88                                                                  88                         88                88                                         
    88aaaaa  8b,dPPYba,  ,adPPYYba,  88,dPYba,,adPYba,    ,adPPYba,     88,dPPYba,   ,adPPYYba,  MM88MMM  ,adPPYba,  88,dPPYba,   88  8b,dPPYba,    ,adPPYb,d8  
    88"""""  88P'   "Y8  ""     `Y8  88P'   "88"    "8a  a8P_____88     88P'    "8a  ""     `Y8    88    a8"     ""  88P'    "8a  88  88P'   `"8a  a8"    `Y88  
    88       88          ,adPPPPP88  88      88      88  8PP"""""""     88       d8  ,adPPPPP88    88    8b          88       88  88  88       88  8b       88  
    88       88          88,    ,88  88      88      88  "8b,   ,aa     88b,   ,a8"  88,    ,88    88,   "8a,   ,aa  88       88  88  88       88  "8a,   ,d88  
    88       88          `"8bbdP"Y8  88      88      88   `"Ybbd8"'     8Y"Ybbd8"'   `"8bbdP"Y8    "Y888  `"Ybbd8"'  88       88  88  88       88   `"YbbdP"Y8  
                                                                                                                                                                 */
    // One encoder and one swapchain view for a whole frame, so every pass lands in one submit.
    beginFrame: (opts = {}) => {
      endPass();                           // an open compute pass would make finish() throw
      if (fEnc) {                          // a dangling previous frame: submit it rather than leak it
        try { S.endFrame(); }
        catch (e) {
          console.error('[TinyWebGPU] beginFrame: previous frame encoder could not be submitted — that frame was dropped.', e);
          fEnc = 0;
        }
      }
      fEnc = mkEnc(DIAG && 'frame');
      // fView is left empty unless the caller named a target: the swapchain texture is acquired
      // lazily by targetView(), so a compute-only frame never touches (or presents) the canvas.
      fReset(opts.view);
    },
    endFrame: () => {
      if (!fEnc) return;
      endPass();
      if (F_STAGING) flushRing();
      let enc = fEnc;
      fEnc = 0;                            // cleared first: a throwing finish() must not leave it dangling
      fReset();
      submit(enc);
    },
    // beginFrame/endFrame with exception safety: the frame goes out even if `fn` throws, so a
    // bug in one frame's code cannot leave a dangling encoder behind. Returns fn's result.
    frame: (fn, opts) => { S.beginFrame(opts); try { return fn(); } finally { S.endFrame(); } },
    // Keeps one compute pass open so chained dispatches skip the per-dispatch pass overhead.
    // Works with or without an enclosing frame: inside one the frame owns the submit, outside one
    // this encoder is ours and endCompute() submits it.
    beginCompute: (opts = {}) => fPass || (
      fEnc || (fEnc = mkEnc(DIAG && 'compute'), fOwned = true),
      fBound = 0,                          // fresh chain: nothing bound yet
      fPass = fEnc.beginComputePass(fPassOpts = opts)),
    endCompute: () => (
      endPass(),
      fOwned && S.endFrame()),             // beginCompute() opened the encoder; nothing else submits it










    /*
                                                                                  
    88888888ba                   ad88     ad88                                    
    88      "8b                 d8"      d8"                                      
    88      ,8P                 88       88                                       
    88aaaaaa8P'  88       88  MM88MMM  MM88MMM  ,adPPYba,  8b,dPPYba,  ,adPPYba,  
    88""""""8b,  88       88    88       88    a8P_____88  88P'   "Y8  I8[    ""  
    88      `8b  88       88    88       88    8PP"""""""  88           `"Y8ba,   
    88      a8P  "8a,   ,a88    88       88    "8b,   ,aa  88          aa    ]8I  
    88888888P"    `"YbbdP'Y8    88       88     `"Ybbd8"'  88          `"YbbdP"'  
                                                                                  
                                                                                  
    */
    /**
     * A storage buffer (big, read+write in compute/fragment) with helpers.
     * @param {number|ArrayBuffer|ArrayBufferView} sizeOrData byte length, or initial contents
     *   (the buffer is sized from it and filled in the same call)
     * @returns {BufferHandle}
     */
    createStorageBuffer: sizeOrData => {
      let init = typeof sizeOrData === 'number' ? 0 : sizeOrData;
      let h = S.createBuffer(init ? len(init) : sizeOrData, BUF_STORAGE | BUF_COPY_SRC | BUF_COPY_DST, 'storage');
      let { b, w } = h, n = b.size;
      // `r` is a debug/export path, not a hot one: F_READ drops it (and the staging pool with it).
      // C is the result view, e.g. Float32Array — passing it as the *only* argument
      // (`buf.r(Float32Array)`) reads the whole buffer typed, no byte counting.
      let r = !F_READ ? void 0 : (nbytes = n, o = 0, C = U8) => (
        typeof nbytes === 'function' && ([C, nbytes] = [nbytes, n]),
        readBack(nbytes, (enc, rb, need) => enc.copyBufferToBuffer(b, o, rb, 0, need), DIAG && 'readback')
          .then(ab => C ? new C(ab) : ab));
      let clear = () => fEnc
        ? outsidePass(() => fEnc.clearBuffer(b, 0, n))
        : oneShot(enc => enc.clearBuffer(b, 0, n), DIAG && 'clear');
      if (init) w(init);
      // Long names alias the short ones, so `parts.write(data)` and `parts.w(data)` are the same
      // function; pick whichever reads better where you are. F_ALIASES drops the long spellings.
      return OA(h, { r, clear, ...(F_ALIASES ? { read: r } : {}) });
    },

    // Explicit usage flags, minimal helpers. Size is rounded up to 4 bytes; `label` is internal.
    createBuffer: (size, usage, label = 'buffer') => {
      let n = (size + 3) & ~3;
      if (DIAG) checkSize(n, !!(usage & BUF_STORAGE));
      let b = mkBuf({ size: n, usage, ...(DIAG && { label: `${label} ${n}B` }) });
      let w = writerFor(b);
      return { b, w, ...(F_ALIASES ? { buffer: b, write: w } : {}) };
    },

    // Small and read-only in shaders. Written with writeUniforms, or by a pipeline's uniform setters.
    createUniformBuffer: byteLength =>
      mkBuf({ size: byteLength, usage: BUF_UNIFORM | BUF_COPY_DST, ...(DIAG && { label: `uniforms ${byteLength}B` }) }),

    // 3×u32 of [x,y,z] workgroup counts, for dispatchIndirect.
    createIndirectBuffer: () => S.createBuffer(12, BUF_INDIRECT | BUF_STORAGE | BUF_COPY_DST),

    // Raw uniform write (DataView or TypedArray).
    writeUniforms: (buffer, dataViewOrTypedArray, byteOffset = 0) =>
      D.queue.writeBuffer(buffer, byteOffset, dataViewOrTypedArray.buffer ?? dataViewOrTypedArray, dataViewOrTypedArray.byteOffset ?? 0, len(dataViewOrTypedArray)),

    // ─── Textures & samplers ─────────────────────────────────────────────────────────────────
    // Read-only in shaders except as a render pass output — images, render targets, post-process
    // buffers. COPY_DST is in the default usage set so writeTexture/loadTexture work unopted-in.
    // The 4th argument is usage flags, or `{ usage, mips }` — `mips: true` allocates the full
    // mip chain (fill it with generateMipmaps), a number allocates that many levels.
    createTexture: (width, height, format = 'rgba8unorm', usageOrOpts) => {
      let { usage, mips } = typeof usageOrOpts === 'number' ? { usage: usageOrOpts } : usageOrOpts ?? {};
      return tex2d(width, height, format,
        usage ?? (TEX_RENDER_ATTACHMENT | TEX_BINDING | TEX_COPY_SRC | TEX_COPY_DST), 'texture',
        mips === true ? mipCount(width, height) : mips || 1);
    },
    // Writable from WGSL via textureStore(), readable via textureLoad() — compute output,
    // accumulation buffers, GPGPU. Same COPY_DST default.
    createStorageTexture: (width, height, format = 'rgba32float', usage) =>
      tex2d(width, height, format, usage ?? (TEX_BINDING | TEX_STORAGE_BINDING | TEX_COPY_SRC | TEX_COPY_DST), 'storageTexture'),
    // How the GPU reads pixels when a texture is sampled. Defaults are nearest + clamp-to-edge.
    // Everything else (mipmapFilter, wrapW → addressModeW, compare, maxAnisotropy, lod clamps)
    // passes straight through to createSampler.
    createSampler: ({ magFilter = 'nearest', minFilter = 'nearest',
      wrapU = 'clamp-to-edge', wrapV = 'clamp-to-edge', wrapW, ...rest } = {}) => D.createSampler({
        magFilter, minFilter, addressModeU: wrapU, addressModeV: wrapV,
        ...(wrapW && { addressModeW: wrapW }), ...rest
      }),

    ...(F_TEXIO ? {
      /**
       * Uploads raw pixel data into a texture (LUTs, generated noise, CPU-side images). Rows are
       * tightly packed unless `bytesPerRow` says otherwise, and `width`/`height` default to the
       * texture's own size. Needs COPY_DST, which `createTexture` includes.
       * @returns {GPUTexture} the same texture, for chaining
       */
      writeTexture: (tex, data, opts = {}) => {
        let w = opts.width ?? tex.width, h = opts.height ?? tex.height;
        let bpt = texelBytes(tex.format);
        if (!(opts.bytesPerRow || bpt))
          err(9, MSG && `writeTexture: unknown bytes-per-texel for format '${tex.format}'; pass bytesPerRow explicitly.`);
        D.queue.writeTexture(
          { texture: tex, mipLevel: opts.mipLevel ?? 0, origin: { x: opts.x ?? 0, y: opts.y ?? 0 } },
          data, { bytesPerRow: opts.bytesPerRow ?? w * bpt, rowsPerImage: h }, { width: w, height: h });
        return tex;
      },

      /**
       * Loads an image into a texture from a URL, Blob, ImageBitmap, <img>, <canvas>,
       * OffscreenCanvas or <video>. Creates a texture sized from the source unless `opts.texture`
       * names one to reuse. `flipY` defaults to false: the image's first row lands at texture
       * v=0, so readTexture, save and show() round-trip. Mind the display path though — the uv
       * makeFrag generates has y=0 at the *bottom* of the screen, so sample with
       * `vec2(uv.x, 1.0 - uv.y)` (or show()) to put an image on screen upright.
       * @returns {Promise<GPUTexture>}
       */
      loadTexture: async (src, opts = {}) => {
        let source = src;
        if (typeof src === 'string' || src instanceof Blob) {
          let blob = src;
          if (typeof src === 'string') {
            // Without this, a 404 surfaces as an opaque createImageBitmap decode error.
            let resp = await fetch(src);
            if (!resp.ok) err(20, MSG && `loadTexture: HTTP ${resp.status} for '${src}'.`);
            blob = await resp.blob();
          }
          source = await createImageBitmap(blob);
        } else if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
          if (!src.complete) await src.decode();
          source = await createImageBitmap(src);
        }
        // Every accepted source type reports its size under one of these pairs. `||`, not `??`:
        // a <video> always *has* a `width` property and it is 0 until the layout attribute is set,
        // so the nullish form picked the zero and never reached videoWidth.
        let w = source.videoWidth || source.displayWidth || source.width;
        let h = source.videoHeight || source.displayHeight || source.height;
        if (!w || !h) err(10, MSG && 'loadTexture: could not determine source dimensions.');
        // copyExternalImageToTexture requires RENDER_ATTACHMENT in addition to COPY_DST.
        let tex = opts.texture ?? S.createTexture(w, h, opts.format ?? 'rgba8unorm',
          { usage: opts.usage, mips: F_MIPS && opts.mips });
        D.queue.copyExternalImageToTexture(
          { source, flipY: opts.flipY ?? false },
          { texture: tex, premultipliedAlpha: opts.premultipliedAlpha ?? false, colorSpace: opts.colorSpace ?? 'srgb' },
          { width: w, height: h });
        // ImageBitmaps we created ourselves are ours to release; caller-owned sources are not.
        if (source !== src && typeof source.close === 'function') source.close();
        if (F_MIPS && opts.mips) await S.generateMipmaps(tex);
        return tex;
      },
    } : {}),

    ...(F_READ ? {
      /**
       * Reads pixels back — the mirror of `writeTexture` and the texture counterpart of a buffer
       * handle's `.r()`, with the same caveat: it stalls the pipeline. Rows come back tightly
       * packed (the 256-byte padding copyTextureToBuffer needs is stripped). Needs COPY_SRC, which
       * both texture creators include.
       * @param {GPUTexture} tex
       * @param {{x?:number,y?:number,width?:number,height?:number,mipLevel?:number,Ctor?:Function}} [opts]
       *   width/height default to the whole texture; `Ctor` defaults from the format.
       * @returns {Promise<*>}
       */
      readTexture: async (tex, opts = {}) => {
        let w = opts.width ?? tex.width, h = opts.height ?? tex.height;
        let bpt = texelBytes(tex.format);
        if (!bpt) err(11, MSG && `readTexture: unknown bytes-per-texel for format '${tex.format}'.`);
        let tight = w * bpt, padded = (tight + 255) & ~255;   // copyTextureToBuffer wants 256-byte rows
        let src = new U8(await readBack(padded * h, (enc, rb) => enc.copyTextureToBuffer(
          { texture: tex, mipLevel: opts.mipLevel ?? 0, origin: { x: opts.x ?? 0, y: opts.y ?? 0 } },
          { buffer: rb, bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h }),
          DIAG && 'readTexture'));
        let out = new U8(tight * h);
        for (let y = 0; y < h; y++) out.set(src.subarray(y * padded, y * padded + tight), y * tight);  // drop row padding
        let f = tex.format;
        // 16float falls back to raw half bits where Float16Array is not available yet.
        let C = opts.Ctor ?? (/32float$/.test(f) ? Float32Array : /32uint$/.test(f) ? Uint32Array
          : /32sint$/.test(f) ? Int32Array : /16float$/.test(f) ? (globalThis.Float16Array ?? Uint16Array)
            : /16uint$/.test(f) ? Uint16Array : /16sint$/.test(f) ? Int16Array : U8);
        return C === U8 ? out : new C(out.buffer);
      },
    } : {}),

    ...(F_MIPS ? {
      /**
       * Fills a texture's smaller mip levels from level 0 by successive linear-filtered blits.
       * Needs TEXTURE_BINDING and RENDER_ATTACHMENT (createTexture's defaults) and a filterable,
       * renderable format. `createTexture(w, h, fmt, { mips: true })` allocates the chain;
       * `loadTexture(src, { mips: true })` does both steps in one call.
       * @param {GPUTexture} tex @returns {Promise<GPUTexture>} the same texture
       */
      generateMipmaps: async tex => {
        let p = await S.makeFrag(
          `fn frag(uv: vec2<f32>) -> vec4<f32> { return textureSample(src, samp, vec2<f32>(uv.x, 1.0 - uv.y)); }`,
          {}, { src: 'texture_2d<f32>', samp: 'sampler' }, { format: tex.format });
        mipSamp ||= S.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        // One frame → one submit for the whole chain, unless the caller already has one open.
        let own = !fEnc;
        if (own) S.beginFrame();
        for (let i = 1; i < tex.mipLevelCount; i++) {
          p.setResources({ src: tex.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }), samp: mipSamp });
          p.drawTo(tex.createView({ baseMipLevel: i, mipLevelCount: 1 }));
        }
        if (own) S.endFrame();
        return tex;
      },
    } : {}),







    /*
                                                                                                             
    88888888ba   88                                                                                          
    88      "8b  ""                                                                                          
    88      ,8P                                                                                              
    88aaaaaa8P'  88  8b,dPPYba,    ,adPPYb,d8            8b,dPPYba,    ,adPPYba,   8b,dPPYba,    ,adPPYb,d8  
    88""""""'    88  88P'   `"8a  a8"    `Y88  aaaaaaaa  88P'    "8a  a8"     "8a  88P'   `"8a  a8"    `Y88  
    88           88  88       88  8b       88  """"""""  88       d8  8b       d8  88       88  8b       88  
    88           88  88       88  "8a,   ,d88            88b,   ,a8"  "8a,   ,a8"  88       88  "8a,   ,d88  
    88           88  88       88   `"YbbdP"Y8            88`YbbdP"'    `"YbbdP"'   88       88   `"YbbdP"Y8  
                                   aa,    ,88            88                                      aa,    ,88  
                                    "Y8bbdP"             88                                       "Y8bbdP"   
    */
    ...(F_PINGPONG ? {
      /**
       * A read/write pair with a swap — the double-buffer a simulation needs when each step reads
       * one copy and writes the other. Both halves are made the same way, so a swap before the
       * first step is harmless.
       * @example
       *   let g = G.createPingPong(W * H * 4);
       *   step.resources = { src: g.read, dst: g.write };   // handles unwrap themselves
       *   step.run(W, H); g.swap();
       * @param {() => *} make
       * @returns {{read: *, write: *, swap: () => void}}
       */
      // `pp` is a local, not an argument — see the trailing-parameter note above oneShot.
      pingPong: (make, pp) =>
        pp = { read: make(), write: make(), swap: () => [pp.read, pp.write] = [pp.write, pp.read] },
      // Two storage buffers. A TypedArray/ArrayBuffer seeds *both*, so the pair starts consistent.
      createPingPong: sizeOrData => S.pingPong(() => S.createStorageBuffer(sizeOrData)),
      // Two storage textures. Pass `usage` for the render-target flavour (add RENDER_ATTACHMENT).
      createPingPongTexture: (width, height, format = 'rgba16float', usage) =>
        S.pingPong(() => S.createStorageTexture(width, height, format, usage)),
    } : {}),









    /*
                                                                                                                                                                                                            
      ,ad8888ba,                                                                      ,adba,        88                                                                        88                            
     d8"'    `"8b                                                                     8I  I8        ""                                                                 ,d     ""                            
    d8'                                                                               "8bdP'                                                                           88                                   
    88             ,adPPYYba,  8b,dPPYba,   8b       d8  ,adPPYYba,  ,adPPYba,       ,d8"8b  88     88  8b,dPPYba,   ,adPPYba,  8b,dPPYba,    ,adPPYba,   ,adPPYba,  MM88MMM  88   ,adPPYba,   8b,dPPYba,   
    88             ""     `Y8  88P'   `"8a  `8b     d8'  ""     `Y8  I8[    ""     .dP'   Yb,8I     88  88P'   `"8a  I8[    ""  88P'    "8a  a8P_____88  a8"     ""    88     88  a8"     "8a  88P'   `"8a  
    Y8,            ,adPPPPP88  88       88   `8b   d8'   ,adPPPPP88   `"Y8ba,      8P      888'     88  88       88   `"Y8ba,   88       d8  8PP"""""""  8b            88     88  8b       d8  88       88  
     Y8a.    .a8P  88,    ,88  88       88    `8b,d8'    88,    ,88  aa    ]8I     8b,   ,dP8b      88  88       88  aa    ]8I  88b,   ,a8"  "8b,   ,aa  "8a,   ,aa    88,    88  "8a,   ,a8"  88       88  
      `"Y8888Y"'   `"8bbdP"Y8  88       88      "8"      `"8bbdP"Y8  `"YbbdP"'     `Y8888P"  Yb     88  88       88  `"YbbdP"'  88`YbbdP"'    `"Ybbd8"'   `"Ybbd8"'    "Y888  88   `"YbbdP"'   88       88  
                                                                                                                                88                                                                          
                                                                                                                                88                                                                           
    */
    ...(F_RESIZE ? {
      /**
       * Sizes the canvas backing store to its CSS box × devicePixelRatio, clamped to the device's
       * max texture dimension. Returns the pixel size — drop it straight into a `vec2<f32>`
       * uniform — and whether it changed, so callers can gate reallocating their render targets.
       * @param {HTMLCanvasElement|OffscreenCanvas} [canvas] defaults to the canvas init() configured
       * @returns {{width: number, height: number, changed: boolean}}
       */
      resizeCanvas: (canvas = S.context?.canvas, opts = {}) => {
        if (!canvas) err(8, MSG && 'resizeCanvas: no canvas — init() with a context, or pass one.');
        let dpr = opts.dpr ?? globalThis.devicePixelRatio ?? 1;
        let max = D ? D.limits.maxTextureDimension2D : Infinity;
        // clientWidth is 0 on an OffscreenCanvas (no CSS box) — fall back to the current size.
        let fit = (css, cur) => Math.max(1, Math.min(max, Math.round((css || cur) * dpr)));
        let width = fit(canvas.clientWidth, canvas.width), height = fit(canvas.clientHeight, canvas.height);
        let changed = canvas.width !== width || canvas.height !== height;
        if (changed) { canvas.width = width; canvas.height = height; }
        return { width, height, changed };
      },
    } : {}),

    ...(F_SHOW ? {
      /**
       * Draws a texture onto a target — the shortest path from a compute result to pixels.
       * Uses `textureLoad`, not `textureSample`, so the unfilterable formats you most want to
       * inspect (rgba32float and friends) work; the cost is no filtering.
       * @param {GPUTexture} tex @param {GPUTextureView|GPUTexture} [view] defaults to the canvas
       * @param {{format?: string, scale?: number[], offset?: number[], clear?: number[]|'load', flipY?: boolean}} [opts]
       *   `scale`/`offset` are per-channel, `value * scale + offset` — enough to look at an HDR or
       *   signed buffer without writing a shader. `flipY` for a bottom-up source.
       * @returns {Promise<RenderPipeline>} the blit pipeline, in case you want to keep drawing with it
       */
      show: async (tex, view, opts = {}) => {
        // A GPUTexture target knows its own format; a raw view or the canvas default does not.
        let format = opts.format ?? view?.format ?? S.format;
        let sample = /uint$/.test(tex.format) ? 'u32' : /sint$/.test(tex.format) ? 'i32' : 'f32';
        // The generated uv has 0 at the *bottom* of the target, so the default inverts y to put the
        // source's first row on the target's first row — images stay upright and show/readTexture
        // round-trips. Writing this blit by hand without the flip is what turns your image over.
        let flip = opts.flipY ? 'uv.y' : '1.0 - uv.y';
        let key = `${format}|${sample}|${opts.flipY ? 1 : 0}`;
        let entry = blitCache.get(key);
        // `pre` is compared too: a different G.pre means different generated WGSL, and the entry
        // must not outlive the hook it was compiled under. The promise is cached, like
        // shaderCache, so two concurrent first calls share a compile.
        if (!entry || entry.pre !== S.pre) {
          let pending = S.makeFrag(`fn frag(uv: vec2<f32>) -> vec4<f32> {
    let d = vec2<f32>(textureDimensions(src));
    let c = vec2<i32>(clamp(vec2<f32>(uv.x, ${flip}) * d, vec2<f32>(0.0), d - 1.0));
    return vec4<f32>(textureLoad(src, c, 0)) * UB.scale + UB.offset;
  }`, { scale: 'vec4<f32>', offset: 'vec4<f32>' }, { src: `texture_2d<${sample}>` }, { format });
          pending.catch(() => blitCache.delete(key));
          blitCache.set(key, entry = { pre: S.pre, p: pending });
        }
        let p = await entry.p;
        p.setResources({ src: tex });
        p.setUniforms({ scale: opts.scale ?? [1, 1, 1, 1], offset: opts.offset ?? [0, 0, 0, 0] });
        p.drawTo(view, opts.clear ?? [0, 0, 0, 1]);
        return p;
      },
    } : {}),

    ...(F_SAVE ? {
      /**
       * Downloads a texture as an image file and returns the Blob. 8-bit RGBA/BGRA only, since an
       * image file has nowhere to put an HDR value — tone-map into an `rgba8unorm` target first
       * (`G.show(hdr, target, { scale })` will do).
       * @param {GPUTexture} tex needs COPY_SRC (both texture creators include it)
       * @param {string} [filename]
       * @param {{type?: string, quality?: number, download?: boolean, x?: number, y?: number,
       *   width?: number, height?: number, mipLevel?: number}} [opts]
       * @returns {Promise<Blob>}
       */
      save: async (tex, filename = 'capture.png', opts = {}) => {
        if (!/^(rgba|bgra)8unorm(-srgb)?$/.test(tex.format))
          err(19, MSG && `save: needs an 8-bit RGBA texture, got '${tex.format}'. Render it into an rgba8unorm target first.`);
        let width = opts.width ?? tex.width, height = opts.height ?? tex.height;
        let px = await S.readTexture(tex, { x: opts.x, y: opts.y, width, height, mipLevel: opts.mipLevel, Ctor: U8 });
        // ImageData is RGBA; the canvas format is BGRA on most platforms, so swap the ends.
        if (tex.format.startsWith('bgra'))
          for (let i = 0; i < px.length; i += 4) { let b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; }
        let cv = new OffscreenCanvas(width, height);
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, len(px)), width, height), 0, 0);
        let blob = await cv.convertToBlob({ type: opts.type ?? 'image/png', quality: opts.quality ?? 1 });
        if (opts.download !== false) {
          let a = document.createElement('a');
          a.download = filename;
          a.href = URL.createObjectURL(blob);
          a.click();
          // Not revoked immediately: the click starts a download that still has to read the URL.
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }
        return blob;
      },
    } : {}),









    /*
                                                                                         
88                                      88                                       88  
88                                      88                                       88  
88                                      88                                       88  
88   ,adPPYba,   8b      db      d8     88   ,adPPYba,  8b       d8   ,adPPYba,  88  
88  a8"     "8a  `8b    d88b    d8'     88  a8P_____88  `8b     d8'  a8P_____88  88  
88  8b       d8   `8b  d8'`8b  d8'      88  8PP"""""""   `8b   d8'   8PP"""""""  88  
88  "8a,   ,a8"    `8bd8'  `8bd8'       88  "8b,   ,aa    `8b,d8'    "8b,   ,aa  88  
88   `"YbbdP"'       YP      YP         88   `"Ybbd8"'      "8"       `"Ybbd8"'  88  
                                                                                     
                                                                                     
     */
    /**
     * Compiles a WGSL shader module, cached, applying `G.pre`. Compile errors throw with a pretty
     * source-window log; warnings are logged. `applyPre` is false when the caller already ran
     * `G.pre` — makePipeline does, so its cache key is computed on the post-pre source.
     * @param {string} code @returns {Promise<GPUShaderModule>}
     */
    makeShader: (code, applyPre = true) => {
      if (applyPre && S.pre) code = S.pre(code);
      let key = hash(code) + ':' + code.length;   // + length: guards against 32-bit hash collisions
      let promise = shaderCache.get(key);
      if (!promise) {
        // the promise (not the module) is cached, so concurrent calls share one compile
        shaderCache.set(key, promise = compileShader(code, key));
        promise.catch(() => shaderCache.delete(key));
      }
      return promise;
    },
    // entries: [{ binding:0, resource:{ buffer } }, { binding:1, resource: textureView }, ...]
    bindGroup: (pipeline, groupIndex, entries) =>
      D.createBindGroup({ layout: pipeline.getBindGroupLayout(groupIndex), entries }),
  };











  /*
                                                                                                                     
88  888b      88  888888888888  88888888888  88888888ba   888b      88         db         88           ad88888ba   
88  8888b     88       88       88           88      "8b  8888b     88        d88b        88          d8"     "8b  
88  88 `8b    88       88       88           88      ,8P  88 `8b    88       d8'`8b       88          Y8,          
88  88  `8b   88       88       88aaaaa      88aaaaaa8P'  88  `8b   88      d8'  `8b      88          `Y8aaaaa,    
88  88   `8b  88       88       88"""""      88""""88'    88   `8b  88     d8YaaaaY8b     88            `"""""8b,  
88  88    `8b 88       88       88           88    `8b    88    `8b 88    d8""""""""8b    88                  `8b  
88  88     `8888       88       88           88     `8b   88     `8888   d8'        `8b   88          Y8a     a8P  
88  88      `888       88       88888888888  88      `8b  88      `888  d8'          `8b  88888888888  "Y88888P"   
                                                                                                                   
                                                                                                                   
  */
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // INTERNALS — nothing below is part of the public surface. These are closure variables rather
  // than properties on S because the minifier renames a closure variable to one character.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WebGPU usage flags, named here rather than read off the GPUBufferUsage/GPUTextureUsage globals.
  // The values are normative in the spec, so this changes nothing at runtime — but it lets the
  // minifier fold each one to a literal, and it drops the `typeof … !== 'undefined'` guards the
  // globals needed in order to be touched outside a browser.
  let BUF_MAP_READ = 1, BUF_COPY_SRC = 4, BUF_COPY_DST = 8,
    BUF_UNIFORM = 64, BUF_STORAGE = 128, BUF_INDIRECT = 256;
  let TEX_COPY_SRC = 1, TEX_COPY_DST = 2, TEX_BINDING = 4,
    TEX_STORAGE_BINDING = 8, TEX_RENDER_ATTACHMENT = 16;

  // A minifier cannot shorten a property access on a global, and these are spelled out about twenty
  // times between them. Aliasing is worth ~200 bytes minified.
  let OE = Object.entries, OK = Object.keys, OA = Object.assign, OV = Object.values;

  // 'alpha' expects straight (un-premultiplied) alpha out of frag(); 'premultiplied' expects rgb
  // already scaled by a; 'additive' ignores destination alpha. All three add and all three leave
  // alpha's source at `one`, so only the colour factors differ — hence the two-argument builder.
  let blendState = (srcFactor, dstFactor) => ({
    color: { srcFactor, dstFactor, operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor, operation: 'add' },
  });
  let BLENDS = F_BLEND ? {
    alpha: blendState('src-alpha', 'one-minus-src-alpha'),
    premultiplied: blendState('one', 'one-minus-src-alpha'),
    additive: blendState('one', 'one'),
  } : {};

  // ─── Encoders & passes ─────────────────────────────────────────────────────────────────────
  // The two longest names in the WebGPU surface, spelled once each. Every encoder in the library
  // comes out of mkEnc and every submission goes through submit. `label` is passed as
  // `DIAG && '…'` at the call sites, so the strings fold away with DIAG.
  // Shared throw: call sites read `err(n, MSG && 'text')`. The `MSG &&` lives at the call site
  // on purpose — an argument to a function can never be dead-code-eliminated, so this is the
  // only shape that lets a msg-less build fold every message string away. build-min.mjs audits
  // the numbers by matching this exact call shape.
  let err = (n, m) => { throw Error(m || n); };
  // Aliases the minifier cannot make on its own: global constructors are spelled out at every
  // use otherwise, and property names on the device survive verbatim. Raw bytes only — gzip
  // would deduplicate these anyway, but the inline/on-chain builds never gzip.
  let U8 = Uint8Array, AB = ArrayBuffer;
  let mkBuf = d => D.createBuffer(d);
  let len = d => d.byteLength;
  let mkEnc = label => DIAG ? D.createCommandEncoder({ label }) : D.createCommandEncoder();
  let submit = enc => D.queue.submit([enc.finish()]);
  // One-shot submission — open an encoder, record, submit. The outside-a-frame path everywhere.
  // `enc` (and its siblings below) is a trailing parameter used as a local: a default parameter
  // is the one `let` an expression-bodied arrow can have, and callers never pass that far.
  let oneShot = (record, label, enc = mkEnc(label)) => (record(enc), submit(enc));
  // Record onto the caller's encoder, else the open frame's, else a one-shot of our own — the
  // shared tail of every dispatch and draw.
  let onEncoder = (encoder, record) =>
    (encoder || fEnc) ? record(encoder || fEnc) : oneShot(record);

  // Close the chained compute pass without submitting: callers below still need the encoder alive
  // to keep recording. Public endCompute() is the one that may submit.
  let endPass = () => { try { fPass && fPass.end(); } catch { } fPass = 0; };
  // Reset the per-frame state; `view` is the next frame's target (omitted for none).
  let fReset = view => { fView = view; fPass = fPassOpts = fBound = 0; fOwned = false; };

  // Buffer copies cannot be encoded inside a pass. Close the chained pass, encode, then reopen it
  // and restore the pipeline/bind group of whatever was last bound, so a mid-chain write is
  // invisible. The reopen is unconditional — gating it on fBound would leave the chain closed
  // when the write comes before the first dispatch.
  let outsidePass = (encode, had = fPass) => (
    endPass(),
    encode(),
    had && (fPass = fEnc.beginComputePass(fPassOpts || {}), fBound && fBound(fPass)));

  // ─── Staging ring ──────────────────────────────────────────────────────────────────────────
  // While a frame is open, uniform/buffer writes are staged CPU-side and copyBufferToBuffer'd
  // inside the frame encoder, so writes order against *dispatches* (per-dispatch uniforms in one
  // submit) instead of against whole submits. F_STAGING drops the whole mechanism: writes then
  // fall back to plain queue writes everywhere (see the switch's comment for what that changes).
  // The `_` field names are minifier instructions: build-min.mjs renames every `_`-prefixed
  // property, and nothing outside this file reads them.
  let ring = F_STAGING ? { _chunks: [], _i: 0, _cap: 1 << 18 } : 0;
  let stageCopy = !F_STAGING ? 0 : (dst, dstOff, data, size) => {
    let need = (size + 3) & ~3;       // copyBufferToBuffer needs 4-byte multiples
    while (ring._chunks[ring._i] && ring._chunks[ring._i]._buf.size - ring._chunks[ring._i]._at < need) ring._i++;
    let c = ring._chunks[ring._i];
    if (!c) {
      let cap = Math.max(ring._cap, need);
      c = ring._chunks[ring._i] = {
        _buf: mkBuf({ size: cap, usage: BUF_COPY_SRC | BUF_COPY_DST, ...(DIAG && { label: 'staging ring' }) }),
        _cpu: new U8(cap), _at: 0
      };
    }
    let src = AB.isView(data) ? new U8(data.buffer, data.byteOffset, size) : new U8(data, 0, size);
    c._cpu.set(src, c._at);
    // The copy is rounded up to 4 bytes; zero the tail so a short write cannot smear whatever the
    // previous frame left in the ring into the bytes past the caller's data.
    if (need > size) c._cpu.fill(0, c._at + size, c._at + need);
    let off = c._at;
    outsidePass(() => fEnc.copyBufferToBuffer(c._buf, off, dst, dstOff, need));
    c._at += need;
  };
  // Upload all staged chunk contents; must run just before submitting the frame encoder (queue
  // writes execute before subsequently submitted command buffers).
  let flushRing = !F_STAGING ? 0 : () => {
    for (let c of ring._chunks) {
      if (c._at > 0) D.queue.writeBuffer(c._buf, 0, c._cpu, 0, c._at);
      c._at = 0;
    }
    ring._i = 0;
  };

  // Pooled staging buffers for readbacks, keyed by size, max 4 kept per size. Reached through S
  // (see the test seams at the bottom) so test/layout.test.mjs can stub them.
  let stagingPool = F_READ ? new Map() : 0;
  let acquireStaging = !F_READ ? 0 : size => stagingPool.get(size)?.pop()
    ?? mkBuf({ size, usage: BUF_COPY_DST | BUF_MAP_READ, ...(DIAG && { label: 'readback staging' }) });
  let releaseStaging = !F_READ ? 0 : (buf, list = stagingPool.get(buf.size) ?? []) =>
    list.length < 4 ? (list.push(buf), stagingPool.set(buf.size, list)) : buf.destroy();

  // The shared readback tail behind buffer `.r()` and readTexture: pool a staging buffer, encode
  // the caller's copy into a one-shot submission, map, copy out, release. `nbytes` may be
  // unaligned — copy sizes and mapped ranges must be 4-byte multiples, so the copy is padded
  // (`need`, handed to the encode callback) and the result trimmed back to `nbytes`.
  let readBack = !F_READ ? 0 : async (nbytes, encode, label) => {
    if (fEnc) console.warn('[TinyWebGPU] readback during an open frame reads pre-frame data — call endFrame() first.');
    let need = (nbytes + 3) & ~3;
    let rb = S._acquireStaging(need);
    oneShot(enc => encode(enc, rb, need), label);
    await rb.mapAsync(GPUMapMode.READ);
    let ab = rb.getMappedRange(0, need).slice(0, nbytes);   // copy: stays valid after unmap
    rb.unmap();
    S._releaseStaging(rb);
    return ab;
  };

  // ─── Small helpers ─────────────────────────────────────────────────────────────────────────
  // The one createTexture call behind createTexture, createStorageTexture and the depth pool.
  let tex2d = (width, height, format, usage, label, mips = 1) => D.createTexture({
    size: { width, height }, format, mipLevelCount: mips, sampleCount: 1, usage,
    ...(DIAG && { label: `${label} ${width}x${height} ${format}` })
  });
  // Levels in a full mip chain, and the linear sampler generateMipmaps reuses across calls.
  let mipCount = (w, h) => 32 - Math.clz32(Math.max(w, h));
  let mipSamp = 0;

  // A stable small integer per GPU object, for building bind-group cache keys out of resource
  // identities. WeakMap-backed, so it holds nothing alive.
  let rids = new WeakMap(), ridN = 0;
  let idOf = o => rids.get(o) ?? (rids.set(o, ++ridN), ridN);

  // FNV-1a, for cache keys.
  let hash = s => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  };

  // The default view of a texture, memoized — bind groups are rebuilt often and a fresh
  // createView() per rebind is pure garbage. The view's size is recorded on the way through, so
  // the auto depth attachment can size itself from any view this library created.
  let viewCache = new WeakMap(), viewSize = F_DEPTH ? new WeakMap() : 0;
  let viewOf = (t, v = viewCache.get(t)) => v || (
    viewCache.set(t, v = t.createView()),
    F_DEPTH && viewSize.set(v, [t.width, t.height]),
    v);
  // A texture or a view, normalized to a view.
  let asView = v => v.createView ? viewOf(v) : v;

  // Where a render pass draws when the caller didn't say: the frame's view, else the swapchain.
  // Acquired on first use and, inside a frame, cached — so every pass of one frame draws into the
  // same swapchain texture, and a frame that never draws never acquires one at all.
  let targetView = (v = fView || S.context && viewOf(S.context.getCurrentTexture())) => (
    v || err(7, MSG && 'No render target: init() was called without a canvas context — pass an explicit view.'),
    fEnc && (fView = v),
    v);

  // The auto-managed depth textures behind makeDraw({depth}), pooled by size and format so every
  // pipeline drawing into the same target shares one depth buffer — which is also what makes
  // depth testing work *across* pipelines in a frame.
  let depthCache = F_DEPTH ? new Map() : 0;
  let depthFor = !F_DEPTH ? 0 : (colorView, format,
    s = viewSize.get(colorView) || err(21, MSG && 'depth: target size unknown. Pass a GPUTexture (not a view) to drawTo, or supply depth.texture.'),
    key = `${s[0]}x${s[1]} ${format}`, k) =>
    viewOf(depthCache.get(key) || (
      // Old sizes (a resized canvas leaves them behind) are destroyed, not merely dropped.
      depthCache.size >= 4 && (k = depthCache.keys().next().value, depthCache.get(k).destroy(), depthCache.delete(k)),
      depthCache.set(key, k = tex2d(s[0], s[1], format, TEX_RENDER_ATTACHMENT, 'depth')),
      k));

  // Bytes per texel, derived from the format name rather than tabulated: <channels><bits><type>.
  // This covers every copyable colour format WebGPU has — including the 16-bit unorm/snorm and
  // rgb10a2uint variants a fixed table kept missing. The three packed formats don't follow the
  // pattern and are named. Depth/stencil formats are absent on purpose: they have no single
  // bytes-per-texel for copies, and callers must pass bytesPerRow.
  let texelBytes = !(F_TEXIO || F_READ) ? 0 : f => {
    let m = /^(r|rg|rgba|bgra)(8|16|32)/.exec(f);
    return m ? m[1].length * (m[2] / 8) : { 'rgb10a2unorm': 4, 'rgb10a2uint': 4, 'rg11b10ufloat': 4 }[f];
  };

  // Warns (doesn't throw) when a requested size exceeds the device limits — allocation is still
  // attempted, since limits vary wildly across GPUs. Diagnostics only.
  let checkSize = !DIAG ? 0 : (n, isStorage) => {   // every call site is DIAG-guarded
    try {
      if (!D) return;
      if (n > D.limits.maxBufferSize)
        console.warn(`[TinyWebGPU] Requested buffer size (${n}) exceeds device.maxBufferSize (${D.limits.maxBufferSize}).`);
      if (isStorage && n > D.limits.maxStorageBufferBindingSize)
        console.warn(`[TinyWebGPU] Requested storage buffer size (${n}) exceeds device.maxStorageBufferBindingSize (${D.limits.maxStorageBufferBindingSize}).`);
    } catch { }
  };

  // Buffer writer: staged inside an open frame so writes order against dispatches, a plain queue
  // write outside. Rejects plain Arrays — `[1,2,3]` has no byteLength, and the old `?? d.length`
  // fallback silently wrote 3 bytes of nothing.
  let writerFor = b => (d, o = 0) => {
    if (!(AB.isView(d) || d instanceof AB))
      err(5, MSG && 'buffer write: expected a TypedArray or ArrayBuffer.');
    // Both write paths (writeBuffer and copyBufferToBuffer) take only 4-byte offsets — name the
    // constraint instead of letting the driver reject it.
    if (o & 3) err(6, MSG && `buffer write: byteOffset must be a multiple of 4 (got ${o}).`);
    if (F_STAGING && fEnc) return stageCopy(b, o, d, len(d));
    // writeBuffer also wants a 4-byte-multiple size; pad a copy of the tail rather than reject
    // the write. Buffer sizes are rounded up at creation, so the padding never overruns.
    if (len(d) & 3) {
      let p = new U8((len(d) + 3) & ~3);
      p.set(AB.isView(d) ? new U8(d.buffer, d.byteOffset, len(d)) : new U8(d));
      d = p;
    }
    return D.queue.writeBuffer(b, o, d.buffer ?? d, d.byteOffset ?? 0, len(d));
  };

  let blitCache = F_SHOW ? new Map() : 0;

  // Accepts a preset name or a raw GPUBlendState; falsy = no blending (opaque).
  let resolveBlend = blend =>
    !blend || typeof blend !== 'string' ? blend || 0
      : BLENDS[blend] ?? err(4, MSG && `Unknown blend preset '${blend}'. Use ${OK(BLENDS).map(k => `'${k}'`).join(', ')} or a GPUBlendState object.`);

  let compileShader = async (code, label) => {
    let module = D.createShaderModule({ code, ...(DIAG && { label: `shader ${label ?? ''}` }) });
    let info = await module.getCompilationInfo();
    let msgs = info.messages.filter(m => m.message && m.type !== 'info');
    if (msgs.length) {
      let hasError = msgs.some(m => m.type === 'error');
      // DIAG is folded to false in the minified build, which removes this whole formatter. The
      // throw below sits outside it on purpose — errors stay loud in every build.
      if (DIAG) {
        let L = code.split('\n');
        let log = '\n=== WGSL Compile Log ===\n';
        for (let m of msgs) {
          let ln = m.lineNum, col = m.linePos, t = m.type.toUpperCase();
          let s = Math.max(0, ln - 10), e = Math.min(L.length, ln + 4);
          log += `\n${t} @ ${ln}:${col} — ${m.message}\n\n`;
          for (let i = s; i < e; i++) {
            let n = i + 1;
            log += `${String(n).padStart(4, ' ')} | ${L[i]}\n`;
            if (n === ln) log += `     | ${' '.repeat(Math.max(0, col - 1))}^\n`;
          }
        }
        (hasError ? console.error : console.warn)(log);
      }
      if (hasError) err(3, MSG && 'WGSL compilation failed.');
    }
    return module;
  };

  // `layout: 'auto'` derives the bind group layout from what the shader actually references.
  // `format` is one format string, or an array of them for multiple render targets in @location
  // order; a blend state, if given, applies to every target.
  let rawRender = (module, format, topology, blend, dep) => (
    blend = resolveBlend(blend),
    D.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [format].flat().map(f => blend ? { format: f, blend } : { format: f }) },
      primitive: { topology },
      ...(F_DEPTH && dep ? { depthStencil: { format: dep.format, depthWriteEnabled: dep.write, depthCompare: dep.compare } } : {}),
    }));
  let rawCompute = module => D.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  // ─── Schema engine ─────────────────────────────────────────────────────────────────────────
  // Turns the two schema objects into WGSL declarations, a CPU-side uniform struct with a writer,
  // and the bind-group entry builder. Exposed as G.makeSchema for people driving it by hand.
  let buildSchema = (uniforms = {}, resources = {}, opts = {}) => {
    let group = opts.group ?? 0, structName = opts.structName ?? 'Uniforms', varName = opts.varName ?? UNIFORM_VAR;
    // Resources named here are bound `read`, not `read_write`. WebGPU forbids a read_write storage
    // binding from being visible to the vertex stage, so anything a vertex shader reads must say so.
    let readOnly = opts.readOnly ?? [];
    // Uniforms whose var the shader never mentions still get a buffer and setters — only the
    // @binding is left out, so `p.uniforms = {…}` keeps working against a shader that ignores UB.
    let emit = opts.emitUniform ?? true;
    let binding = opts.startBinding ?? 0;

    // [size, align, components, packRows] in 4-byte units, derived from the type string rather than
    // tabulated. WGSL layout rules: scalars are 1/1; vecN is N wide and aligns to N, except vec3
    // which aligns to 4 while still occupying 3 (so a following scalar packs into its tail);
    // matCxR is C columns of vecR, and a 3-row column occupies 4 units like any vec3.
    // `components` is how many numbers the caller supplies — smaller than `size` for exactly the
    // 3-row matrices, whose columns are written on a 4-unit stride. `packRows` flags that case.
    // `m`, `c`, `r` are locals via trailing parameters; the vec branch reuses `m` for the width,
    // the mat branch for cols/rows.
    let typeInfo = (t, m, c, r) =>
      /^[fiu]32$/.test(t) ? [1, 1, 1, 0]
        : (m = /^vec([234])<[fiu]32>$/.exec(t)) ? (c = +m[1], [c, c === 3 ? 4 : c, c, 0])
        : (m = /^mat([234])x([234])<f32>$/.exec(t)) ? (
          c = +m[1], r = +m[2],
          [c * (r === 3 ? 4 : r), r === 3 ? 4 : r, c * r, r === 3 ? 3 : 0])
        : err(12, MSG && `Unknown uniform type size for: ${t}`);
    let alignTo = (n, a) => Math.ceil(n / a) * a;

    let uniformBuffer = 0, uniformWrite = () => 0, uniformWGSL = '';
    let uniformEntries = OE(uniforms);
    if (uniformEntries.length > 0) {
      let offset = 0, layout = {};
      let structFields = uniformEntries.map(([name, wgslType]) => {
        let [size, al, comps, packRows] = typeInfo(wgslType);
        offset = alignTo(offset, al);
        // `_`-prefixed: internal fields the minified build renames (see build-min.mjs).
        layout[name] = { _offset: offset, _comps: comps, _packRows: packRows, _wgslType: wgslType };
        offset += size;
        return `  ${name}: ${wgslType},`;
      });

      offset = alignTo(offset, 4);                 // struct size must be 16-byte aligned
      let byteSize = offset * 4;
      uniformBuffer = S.createUniformBuffer(byteSize);
      let buffer = new AB(byteSize);
      let F32 = new Float32Array(buffer), I32 = new Int32Array(buffer), U32 = new Uint32Array(buffer);

      // Resolve the destination view and the integer coercion once, here — this used to be two
      // regexes per field on every setUniforms() call, i.e. in the middle of the animation loop.
      for (let f of OV(layout)) {
        f._isU = /u32/.test(f._wgslType);
        f._isI = /i32/.test(f._wgslType);
        f._view = f._isU ? U32 : f._isI ? I32 : F32;
      }

      uniformWrite = values => {
        for (let [name, value] of OE(values)) {
          let f = layout[name];
          // A name that is not in the schema used to be dropped in silence — the single most
          // expensive typo in the toolkit, since nothing at all happened. Say so instead.
          if (!f) err(13, MSG && `Unknown uniform '${name}'. Declared: ${OK(layout).join(', ') || '(none)'}.`);
          // TypedArrays count as vectors/matrices too: a Float32Array mat4 out of a maths library
          // used to fall into the scalar branch and write a single NaN.
          let array = Array.isArray(value) || AB.isView(value) ? value : [value];
          if (DIAG && S.debug && array.length > f._comps)
            console.warn(`Uniform '${name}' provided ${array.length} values but type ${f._wgslType} fits ${f._comps}. Extra values will be ignored.`);
          for (let i = 0; i < f._comps && i < array.length; i++) {
            let x = array[i] ?? 0;
            if (DIAG && S.debug && (f._isI || f._isU) && !Number.isInteger(x))
              console.warn(`Uniform '${name}' expects integer for ${f._wgslType} at index ${i}, got ${x}. It will be truncated.`);
            x = f._isU ? x >>> 0 : f._isI ? x | 0 : x;
            // Straight through, except for a 3-row matrix: the caller hands over tightly packed
            // columns and the buffer wants them on a 4-unit stride.
            f._view[f._offset + (f._packRows ? ((i / 3 | 0) * 4 + i % 3) : i)] = x;
          }
        }
        // Inside an open frame, stage so each dispatch sees the values set before it; otherwise a
        // plain queue write (ordered against the next submit) is enough.
        if (F_STAGING && fEnc) stageCopy(uniformBuffer, 0, buffer, len(buffer));
        else S.writeUniforms(uniformBuffer, buffer);
      };

      if (emit) {
        uniformWGSL = `struct ${structName} {
${structFields.join('\n')}
}\n@group(${group}) @binding(${binding}) var<uniform> ${varName}: ${structName};`;
        binding++;
      }
    }

    // Anything that is not a texture or sampler is a storage buffer and needs an address space.
    // Three forms: `array<…>` is kept as-is, a full `struct Foo {…}` is emitted and bound by name,
    // and a bare primitive/vector/matrix is auto-wrapped in `struct name_buf { value: T }`.
    let resourceLayout = {};
    let resourceWGSL = OE(resources).map(([name, wgslType]) => {
      let currentBinding = binding++;
      let isTex = wgslType.startsWith('texture_');
      let isSampler = wgslType === 'sampler' || wgslType === 'sampler_comparison';
      let isBuf = !(isTex || isSampler);

      let decls = '', typeForBinding = wgslType;
      if (isBuf && !wgslType.startsWith('array<')) {
        if (/^struct\s+/.test(wgslType)) {
          decls = wgslType.trim();
          typeForBinding = wgslType.match(/^struct\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? wgslType;
        } else {
          typeForBinding = `${name}_buf`;
          decls = `struct ${typeForBinding} {\n  value: ${wgslType},\n}`;
        }
      }

      resourceLayout[name] = { _binding: currentBinding, _wgslType: wgslType, _isBuf: isBuf, _isTex: isTex, _isSampler: isSampler };
      let addrSpace = isBuf ? (readOnly.includes(name) ? '<storage, read>' : '<storage, read_write>') : '';
      let varLine = `@group(${group}) @binding(${currentBinding}) var${addrSpace} ${name}: ${typeForBinding};`;
      return decls ? `${decls}\n${varLine}` : varLine;
    });

    // `wgsl` / `uniformBuffer` / `uniformWrite` are the documented shape and keep their names. The
    // rest is internal, so it is `_`-prefixed and the minified build renames it.
    return {
      wgsl: [uniformWGSL, ...resourceWGSL].filter(Boolean).join('\n'),
      uniformBuffer,
      uniformWrite,
      _entries: values => OE(resourceLayout).map(([name, info], i, a, resource = values[name]) =>
        resource && {
          binding: info._binding,
          resource: info._isTex ? asView(resource) : info._isBuf ? { buffer: resource } : resource,
        }).filter(Boolean),
      _uniformFields: OK(uniforms),
      _resourceFields: OK(resources),
      _resourceLayout: resourceLayout,
      // -1 = no uniform binding. 0 is a real binding number, so this one keeps a sentinel;
      // readers test `>= 0`.
      _uniformBinding: uniformEntries.length && emit ? (opts.startBinding ?? 0) : -1,
    };
  };

  // ─── Pipeline factory ──────────────────────────────────────────────────────────────────────
  // The engine behind makeFrag / makeDraw / makeCompute: generate the schema WGSL, compile and
  // cache the pipeline, and hand back the object those three return.
  let makePipeline = async ({ code, uniforms = {}, resources = {}, format = S.format,
    isCompute = false, blend, wg = [8, 8, 1], targetNames,
    topology = 'triangle-list', count = 3, instances = 1, readOnly = [], depth }) => {
    // The resolved depth config: defaults, overridable field by field. `texture` is the caller's
    // own depth attachment; without it drawTo manages one sized to the target.
    let dep = F_DEPTH && depth && !isCompute
      ? { format: 'depth24plus', compare: 'less', write: true, ...(depth === true ? {} : depth) }
      : 0;
    // Declare only what the shader actually mentions. layout:'auto' drops bindings the shader
    // never references, and a bind-group entry for a dropped binding is a validation error — so
    // instead of emitting everything and reconciling afterwards, the schema is filtered up front
    // and the generated WGSL, the binding numbers and the bind group agree by construction.
    // Comments are stripped first: layout:'auto' parses real WGSL, so a name that only appears in
    // a comment must not count as referenced — its binding would be emitted, then dropped by the
    // driver, and the bind group rejected.
    let bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    let refd = name => new RegExp(`\\b${name}\\b`).test(bare);
    let usedResources = Object.fromEntries(OE(resources).filter(([n]) => refd(n)));
    let usesUB = refd(UNIFORM_VAR);
    if (DIAG) {
      let unused = OK(resources).filter(n => !(n in usedResources));
      if (!usesUB && OK(uniforms).length) unused.unshift(`${UNIFORM_VAR} (uniforms)`);
      if (unused.length) console.warn(
        `[TinyWebGPU] Schema declares ${unused.map(n => `'${n}'`).join(', ')} but the shader never references ${unused.length > 1 ? 'them' : 'it'}; ` +
        `${unused.length > 1 ? 'they are' : 'it is'} left out of the generated WGSL and the bind group.`);
    }
    let schema = buildSchema(uniforms, usedResources, { group: 0, startBinding: 0, emitUniform: usesUB, readOnly });
    // Destructured once: these are read on every setResources() and every dispatch, and a local is
    // both faster and — since the minifier renames it — a great deal shorter than the path.
    let { _resourceFields: rFields, _resourceLayout: rLayout, _uniformBinding: uBinding, uniformWrite: uWrite } = schema;

    // Prepend the schema WGSL, then run the G.pre hook once, here — the pipeline cache keys on the
    // result, so switching G.pre can't hand back a stale pipeline.
    let preCode = schema.wgsl ? `${schema.wgsl}\n${code}` : code;
    let finalCode = S.pre ? S.pre(preCode) : preCode;

    // Blend and depth are part of the render key: identical WGSL with a different blend or depth
    // state is a different pipeline, and omitting them here would hand back the wrong one.
    // (`dep.texture` is an attachment, not pipeline state, so it stays out of the key.)
    let blendKey = isCompute || !blend ? '' : (typeof blend === 'string' ? blend : JSON.stringify(blend)) + '|';
    let depthKey = F_DEPTH && dep ? `D${dep.format},${dep.compare},${dep.write}|` : '';
    let cacheKey = (isCompute ? `C|` : `R|${[format].flat().join(',')}|${blendKey}${depthKey}${topology}|`) + hash(finalCode) + ':' + finalCode.length;
    // The *promise* is cached, like shaderCache — two concurrent builds of the same source share
    // one pipeline instead of both missing and creating duplicates.
    let pending = pipelineCache.get(cacheKey);
    if (!pending) {
      pending = S.makeShader(finalCode, false).then(module => {   // S.pre already applied above
        // The error scope is purely for reporting: WebGPU rejects a bad pipeline either way, and
        // without DIAG the driver's own message is the one that surfaces.
        if (DIAG) D.pushErrorScope('validation');
        let pl = isCompute ? rawCompute(module) : rawRender(module, format, topology, blend, dep);
        if (DIAG) D.popErrorScope().then(err => {
          if (!err) return;
          // Evict, or the next build of the same source would reuse the broken pipeline and,
          // having skipped this branch entirely, report nothing at all.
          pipelineCache.delete(cacheKey);
          console.error(`[TinyWebGPU] Pipeline creation failed (${cacheKey}):\n${err.message}`);
        }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
        return pl;
      });
      pending.catch(() => pipelineCache.delete(cacheKey));
      pipelineCache.set(cacheKey, pending);
    }
    let pipeline = await pending;

    let bindGroup = 0, bound = 0;   // `bound` = the resource map the current group was built from

    // What a declared type needs the resource to have been created with. Checking it here turns
    // the commonest texture mistake (a plain createTexture behind a texture_storage_2d) from a wall
    // of driver validation text into one line naming the resource and the missing flag. Diagnostics
    // only — WebGPU validates the bind group itself, so the minified build folds this away.
    let usageNeed = !DIAG ? 0 : info =>
      info._isBuf ? [BUF_STORAGE, 'GPUBufferUsage.STORAGE']
        : info._isTex ? (/^texture_storage_/.test(info._wgslType)
          ? [TEX_STORAGE_BINDING, 'GPUTextureUsage.STORAGE_BINDING (use createStorageTexture)']
          : [TEX_BINDING, 'GPUTextureUsage.TEXTURE_BINDING'])
        : [0, ''];
    let validateResources = !DIAG ? 0 : vals => {   // both call sites are DIAG-guarded
      let missing = [], mismatched = [];
      for (let name of rFields) {
        let info = rLayout?.[name];
        let v = vals[name];
        if (!v) { missing.push(name); continue; }
        let expected = info?._wgslType ?? resources[name];
        // Heuristics: catch the obvious mismatches without producing false positives. A sampler is
        // opaque, so it gets no kind check at all.
        let bad = 0;
        if (info?._isBuf) {
          if (!(typeof v.mapAsync === 'function' || typeof v.getMappedRange === 'function' || typeof v.buffer?.mapAsync === 'function')) bad = typeof v;
        } else if (info?._isTex) {
          // A GPUTextureView is opaque (no marker properties at all), so instanceof is the test.
          if (!(typeof GPUTextureView !== 'undefined' && v instanceof GPUTextureView)
            && !(typeof v.createView === 'function' || 'dimension' in v || 'mipLevelCount' in v)) bad = typeof v;
        }
        // Right kind of object, wrong usage flags: catch it here rather than in the driver.
        if (!bad && info && v.usage) {
          let [need, label] = usageNeed(info);
          if (need && !(v.usage & need)) bad = `a ${info._isBuf ? 'buffer' : 'texture'} created without ${label}`;
        }
        if (bad) mismatched.push({ name, expected, got: bad });
      }
      if (!missing.length && !mismatched.length) return;
      let at = n => rLayout?.[n]?._binding >= 0 ? ` (binding ${rLayout[n]._binding})` : '';
      let msg = 'BindGroup(0) resource validation failed.';
      if (missing.length) msg += '\nMissing:' + missing.map(n => `\n  - ${n}${at(n)}`).join('');
      if (mismatched.length) msg += '\nMismatched:' + mismatched.map(m => `\n  - ${m.name}${at(m.name)}: expected ${m.expected}, got ${m.got}`).join('');
      err(14, MSG && msg);
    };

    // Resources merge into what is already bound and are compared by value, so a partial update
    // ({ grid } after both were set) is legal, and passing the same handles again every frame is
    // free instead of rebuilding a bind group per frame. Buffer handles unwrap themselves.
    // Bind groups are cached per resource-identity tuple, so a ping-pong that alternates between
    // two states builds two groups total instead of one per swap per frame.
    let bgCache = new Map();
    let rebindResources = resourceValues => {
      let next = { ...bound };
      for (let [name, v] of OE(resourceValues ?? {})) {
        // A typo'd name used to vanish in silence — the resource twin of the unknown-uniform trap.
        if (!(name in resources))
          err(22, MSG && `Unknown resource '${name}'. Declared: ${OK(resources).join(', ') || '(none)'}.`);
        if (!(name in rLayout)) continue;   // declared but unused by the shader — warned at build
        next[name] = rLayout[name]._isBuf && typeof v?.b?.mapAsync === 'function' ? v.b : v;
      }
      if (bindGroup && bound && rFields.every(n => next[n] === bound[n])) return;
      bound = next;
      let key = rFields.map(n => next[n] ? idOf(next[n]) : 0).join(',');
      let hit = bgCache.get(key);
      if (hit) return void (bindGroup = hit);
      if (DIAG && rFields.length > 0) validateResources(next);
      let entries = [
        ...(uBinding >= 0 ? [{ binding: 0, resource: { buffer: schema.uniformBuffer } }] : []),
        ...schema._entries(next),
      ];
      // Reporting only, as at pipeline creation — the driver rejects a bad group regardless.
      if (DIAG) D.pushErrorScope('validation');
      bindGroup = S.bindGroup(pipeline, 0, entries);
      if (DIAG) D.popErrorScope().then(err => {
        if (err) console.error(`[TinyWebGPU] createBindGroup failed.\n${err.message}`);
      }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
      if (bgCache.size >= 8) bgCache.delete(bgCache.keys().next().value);   // oldest out
      bgCache.set(key, bindGroup);
    };

    // Nothing left for the caller to supply: build @group(0) now. Otherwise wait for
    // setResources, so the group is never built against a layout still missing entries.
    if (uBinding >= 0 && !rFields.length) rebindResources({});

    // Whether @group(0) exists at all. If it does and nothing is bound to it, dispatching produces
    // a bare "bind group 0 is not set" from the driver — say which call is missing instead.
    let needsBindGroup = uBinding >= 0 || rFields.length > 0;

    let bind = pass => (
      !bindGroup && needsBindGroup &&
        err(15, MSG && `No resources bound. Call setResources({ ${rFields.join(', ')} }) before dispatching/drawing.`),
      pass.setPipeline(pipeline),
      bindGroup && pass.setBindGroup(0, bindGroup));

    // Records compute work. When beginCompute() has a pass open on the encoder we would use, join
    // it — rebinding only if the last pipeline bound to it was a different one — so chaining is
    // what you get by default and `dispatch()` never silently ends someone else's chain.
    // Otherwise open a pass of our own, and submit if we also own the encoder.
    let computePass = (record, encoder) =>
      fPass && (!encoder || encoder === fEnc)
        ? (fBound !== bind && (bind(fPass), fBound = bind), record(fPass))
        : onEncoder(encoder, (enc, pass = enc.beginComputePass()) =>
          (bind(pass), record(pass), pass.end()));

    let base = {
      pipeline,
      set uniforms(values) { uWrite(values); },
      setUniform: (name, value) => uWrite({ [name]: value }),
      setUniforms: values => uWrite(values),
      set resources(values) { rebindResources(values); },
      setResources: values => rebindResources(values),
      ...(F_ALIASES ? {
        get uniformFields() { return schema._uniformFields; },
        get resourceFields() { return rFields; },
      } : {}),
      // Vertices per instance, and instance count. Plain properties rather than drawTo arguments
      // because a particle count that changes every frame should not need a new pipeline —
      // `p.instances = alive` and draw again.
      count, instances,
    };

    return isCompute ? OA(base, {
      dispatch: (x = 1, y = 1, z = 1, encoder) => computePass(p => p.dispatchWorkgroups(x, y, z), encoder),
      // dispatch() counts workgroups; run() counts the items you actually have and divides by the
      // workgroup size for you. Guard the tail with `if (gid.x >= n) { return; }` as usual.
      run: (w = 1, h = 1, d = 1, encoder) => computePass(
        p => p.dispatchWorkgroups(Math.ceil(w / wg[0]), Math.ceil(h / wg[1]), Math.ceil(d / wg[2])), encoder),
      // Takes a raw GPUBuffer or a handle — `.b ??` unwraps, as setResources does.
      dispatchIndirect: (buffer, byteOffset = 0, encoder) =>
        computePass(p => p.dispatchWorkgroupsIndirect(buffer.b ?? buffer, byteOffset), encoder),
      // Escape hatch: bind this pipeline to a pass you opened yourself, then dispatch on it with
      // the raw WebGPU calls. Not needed for beginCompute() chains — dispatch() handles those.
      // fBound is remembered because a staged write mid-chain has to close and reopen the pass,
      // and the reopened one starts with no pipeline bound.
      bindTo: (pass = fPass) => (
        pass || err(17, MSG && 'No active compute pass. Call G.beginCompute() first, or pass one.'),
        bind(pass),
        pass === fPass && (fBound = bind)),
    }) : OA(base, {
      // Single target: a view or texture, defaulting to the canvas. Multiple targets: an object
      // keyed by the `targets` schema — `drawTo({ colour: a, normal: b })` — so the @location order
      // lives in one place and callers never restate it.
      drawTo: (view, clear = [0, 0, 0, 1], encoder) => {
        let c = Array.isArray(clear) ? clear : [0, 0, 0, 1];
        let loadOp = clear === 'load' ? 'load' : 'clear', clearValue = { r: c[0], g: c[1], b: c[2], a: c[3] };
        let views = targetNames
          ? targetNames.map(n => asView(view?.[n] || err(18, MSG && `drawTo: no target for '${n}'. Pass { ${targetNames.join(', ')} }.`)))
          : [view ? asView(view) : targetView()];

        onEncoder(encoder, (enc, pass) => (
          enc === fEnc && fPass && endPass(),   // a render pass cannot nest inside the compute pass
          pass = enc.beginRenderPass({
            colorAttachments: views.map(v => ({ view: v, loadOp, storeOp: 'store', clearValue })),
            // The depth buffer follows the clear mode of the colour targets: 'load' keeps both.
            ...(F_DEPTH && dep ? {
              depthStencilAttachment: {
                view: dep.texture ? asView(dep.texture) : depthFor(views[0], dep.format),
                depthClearValue: 1, depthLoadOp: loadOp, depthStoreOp: 'store',
              }
            } : {}),
          }),
          bind(pass),
          pass.draw(base.count, base.instances, 0, 0),
          pass.end()));
      },
    });
  };

  // ─── Escape hatches & test seams ───────────────────────────────────────────────────────────
  // makeSchema is the documented low-level entry to the schema engine. The `_` names are reserved
  // in build-min.mjs because test/layout.test.mjs stubs (staging) or reads (the other two) them.
  OA(S, {
    makeSchema: buildSchema,
    _resolveBlend: resolveBlend,
    ...(F_TEXIO || F_READ ? { _texelBytes: texelBytes } : {}),
    ...(F_READ ? { _stagingPool: stagingPool, _acquireStaging: acquireStaging, _releaseStaging: releaseStaging } : {}),
  });

  return S;
};
