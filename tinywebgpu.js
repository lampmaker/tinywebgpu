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

// ─── Build-time switches ──────────────────────────────────────────────────────────────────────
// All true in the source you develop against, so nothing below is optional while you work.
// build-min.mjs flips them by name and lets dead-code elimination remove whatever they guard,
// which is how one file serves both the full library and a build small enough to inline into a
// <script> tag. Leave the line shape intact — build-min.mjs matches `const NAME = true;` literally.
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

// WebGPU usage flags, named here rather than read off the GPUBufferUsage/GPUTextureUsage globals.
// The values are normative in the spec, so this changes nothing at runtime — but it lets the
// minifier fold each one to a literal, and it drops the `typeof … !== 'undefined'` guards the
// globals needed in order to be touched outside a browser.
const BUF_MAP_READ = 1, BUF_COPY_SRC = 4, BUF_COPY_DST = 8,
  BUF_UNIFORM = 64, BUF_STORAGE = 128, BUF_INDIRECT = 256;
const TEX_COPY_SRC = 1, TEX_COPY_DST = 2, TEX_BINDING = 4,
  TEX_STORAGE_BINDING = 8, TEX_RENDER_ATTACHMENT = 16;

// A minifier cannot shorten a property access on a global, and these are spelled out about twenty
// times between them. Aliasing is worth ~200 bytes minified.
const OE = Object.entries, OK = Object.keys, OA = Object.assign, OV = Object.values;

// 'alpha' expects straight (un-premultiplied) alpha out of frag(); 'premultiplied' expects rgb
// already scaled by a; 'additive' ignores destination alpha. All three add and all three leave
// alpha's source at `one`, so only the colour factors differ — hence the two-argument builder.
const blendState = (srcFactor, dstFactor) => ({
  color: { srcFactor, dstFactor, operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor, operation: 'add' },
});
const BLENDS = F_BLEND ? {
  alpha: blendState('src-alpha', 'one-minus-src-alpha'),
  premultiplied: blendState('one', 'one-minus-src-alpha'),
  additive: blendState('one', 'one'),
} : {};

// The generated uniform variable's name; makePipeline tests the shader for it.
const UNIFORM_VAR = 'UB';

/**
 * Creates an independent toolkit instance. Call `await G.init(ctx?)` before anything else.
 */
export const WEBGPU = () => {
  // Hot state lives in closure variables rather than on the instance. Both forms cost the same to
  // read at runtime, but a closure variable is renamed to one character by the minifier while
  // `S.frame.encoder` survives verbatim. `device` keeps its public name through an accessor pair
  // for the same reason: the getter/setter costs ~40 bytes once and saves seven at each of its
  // thirty-odd uses.
  let D = null;                  // the GPUDevice, behind S.device
  let fEnc = null;               // the open frame's command encoder, null outside a frame
  let fView = null;              // that frame's render target, acquired lazily by targetView()
  let fPass = null;              // the open chained compute pass, if beginCompute() opened one
  let fOwned = false;            // the encoder came from beginCompute(), so endCompute() submits it
  let fBound = null;             // the bind fn of the pipeline currently bound to fPass
  const shaderCache = new Map(), pipelineCache = new Map();

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  let S = {
    // ─── Device & lifecycle ──────────────────────────────────────────────────────────────────
    get device() { return D; },
    set device(d) { D = d; },
    context: null, format: null, features: null,

    debug: false,                // extra per-uniform warnings; DIAG builds only
    // Optional WGSL preprocessing hook, `(src: string) => string`, applied before hashing and
    // compiling. Must be deterministic — the shader and pipeline caches key on its output.
    // For token shorthands see the companion module wgsl_shorthand.js.
    pre: null,
    // Called with the GPUDeviceLostInfo on a context crash, driver reset or tab backgrounding.
    // The library logs regardless; set this to rebuild.
    onDeviceLost: null,

    /**
     * Initializes WebGPU. Pass a canvas 'webgpu' context to render, or nothing for compute-only
     * use (render calls then need an explicit target view). Requests the adapter's max buffer-size
     * limits. Throws if WebGPU is unavailable.
     * @param {GPUCanvasContext|null} [ctx]
     * @param {{features?: string[], limits?: Object, alphaMode?: string, canvasUsage?: number}} [opts]
     *   `features` are best-effort: any the adapter lacks are dropped with a warning rather than
     *   throwing, so check `G.features` for what was granted.
     * @returns {Promise<Object>} this instance, with device/context/format/features populated
     */
    init: async (ctx = null, opts = {}) => {
      if (!navigator.gpu) throw Error(MSG ? 'WebGPU not supported' : 1);
      const a = await navigator.gpu.requestAdapter();
      if (!a) throw Error(MSG ? 'No GPU adapter' : 2);

      // Raise these to whatever the adapter allows; anything in opts.limits still wins.
      const requiredLimits = { ...opts.limits };
      for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize']) requiredLimits[k] ??= a.limits[k];

      // Asking for a feature the adapter lacks would throw, so filter first.
      const wanted = opts.features ?? [];
      const requiredFeatures = wanted.filter(f => a.features.has(f));
      if (DIAG) {
        const dropped = wanted.filter(f => !a.features.has(f));
        if (dropped.length) console.warn(`[TinyWebGPU] Adapter does not support ${dropped.map(f => `'${f}'`).join(', ')}; continuing without.`);
      }

      const d = await a.requestDevice({ requiredLimits, requiredFeatures });
      d.lost.then(info => {
        console.error(`[TinyWebGPU] GPU device lost (${info.reason || 'unknown'}): ${info.message}`);
        S.onDeviceLost?.(info);
      });
      // The handler's whole body is the log, so without DIAG there is nothing left to install.
      if (DIAG) d.onuncapturederror = e => console.error('[TinyWebGPU] Uncaptured WebGPU error:', e.error?.message ?? e);
      const f = navigator.gpu.getPreferredCanvasFormat();
      // usage defaults to RENDER_ATTACHMENT, as the spec does; add COPY_SRC to it if you want to
      // G.save() the canvas texture itself rather than your own render target.
      if (ctx) ctx.configure({ device: d, format: f, alphaMode: opts.alphaMode ?? 'opaque', usage: opts.canvasUsage ?? TEX_RENDER_ATTACHMENT });
      OA(S, { device: d, context: ctx, format: f, features: d.features });
      return S;
    },

    // ─── Pipelines ───────────────────────────────────────────────────────────────────────────
    /**
     * A fullscreen-triangle render pipeline: you write `fn frag(uv: vec2<f32>) -> vec4<f32>`,
     * the vertex shader and the fs_main wrapper are generated.
     * @param {string} frag WGSL containing the frag function, plus any helpers
     * @param {UniformSchema} [uniforms] @param {ResourceSchema} [resources]
     * @param {{format?: string|string[], blend?: string|GPUBlendState, targets?: Object}} [opts]
     *   `blend`: 'alpha' | 'premultiplied' | 'additive' or a raw GPUBlendState; omitted = opaque.
     *   `targets`: {name: format} for multiple render targets, drawn with `drawTo({name: view})`.
     * @returns {Promise<RenderPipeline>}
     */
    makeFrag: (frag, uniforms = {}, resources = {}, { format = S.format, blend = null, targets = null } = {}) =>
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
`.trim(), uniforms, resources, format, blend, targets
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
     * @param {{code: string, uniforms?: UniformSchema, resources?: ResourceSchema,
     *   readOnly?: string[], count?: number, instances?: number, topology?: string,
     *   format?: string|string[], blend?: string|GPUBlendState, targets?: Object}} opts
     * @returns {Promise<RenderPipeline>}
     */
    makeDraw: ({ code, uniforms = {}, resources = {}, readOnly = [], count = 3, instances = 1,
      topology = 'triangle-list', format = S.format, blend = null, targets = null }) => {
      // `targets` is {name: format}; the matching `struct FSOut { … }` is generated here so the
      // @location indices — the part that is easy to get wrong by hand — follow the key order.
      // WGSL module-scope declarations are order-independent, so the struct may land above the
      // shader that returns it.
      const names = targets ? OK(targets) : null;
      const outStruct = names
        ? `struct FSOut {${names.map((n, i) => `@location(${i}) ${n}: vec4<f32>`).join(', ')}};\n`
        : '';
      return makePipeline({
        code: `${outStruct}${code}`, uniforms, resources, readOnly,
        isCompute: false, blend, targetNames: names, count, instances, topology,
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
    makeCompute: (body, main, uniforms = {}, resources = {}, { wg = [8, 8, 1] } = {}) => makePipeline({
      // Kept flush-left: this text is prepended to every generated shader, so it is hashed,
      // compiled, and line-numbered in compile errors.
      code: `${body}
@compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
${main}
}
`.trim(), uniforms, resources, isCompute: true, wg
    }),

    /**
     * `makeFrag` plus a `run(uniformValues?, view?)` that uploads and draws in one call.
     * @returns {Promise<RenderPipeline & {run: (u?: Object, view?: GPUTextureView) => void}>}
     */
    makeQuad: async ({ frag, uniforms = {}, resources = {}, clear = [0, 0, 0, 1], format = S.format, blend = null }) => {
      const p = await S.makeFrag(frag, uniforms, resources, { format, blend });
      return OA(p, {
        run: (u = {}, view = targetView()) => {
          if (u && OK(u).length) p.uniforms = u;
          p.drawTo(view, clear);
        }
      });
    },

    /**
     * `makeCompute` with a default `size`, so `run()` with no arguments covers the whole grid.
     * `body` is the entry-point statements; `decls` is for helper functions and structs. Bounds-
     * check the tail with `if (gid.x >= n) { return; }` when the size is not a multiple of `wg`.
     * @returns {Promise<ComputePipeline & {run: (w?: number, h?: number, d?: number) => void}>}
     */
    makeCompute2D: async ({ body, decls = '', uniforms = {}, resources = {}, size = [1, 1], wg = [8, 8, 1] }) => {
      const p = await S.makeCompute(decls, body, uniforms, resources, { wg });
      const run = p.run;
      return OA(p, { run: (w = size[0], h = size[1], d = 1) => run(w, h, d) });
    },

    // ─── Frame batching ──────────────────────────────────────────────────────────────────────
    // One encoder and one swapchain view for a whole frame, so every pass lands in one submit.
    beginFrame: (opts = {}) => {
      endPass();                           // an open compute pass would make finish() throw
      if (fEnc) {                          // a dangling previous frame: submit it rather than leak it
        try { S.endFrame(); }
        catch (e) {
          console.error('[TinyWebGPU] beginFrame: previous frame encoder could not be submitted — that frame was dropped.', e);
          fEnc = null;
        }
      }
      fEnc = mkEnc(DIAG && 'frame');
      // Left null unless the caller named a target: the swapchain texture is acquired lazily by
      // targetView(), so a compute-only frame never touches (and never presents) the canvas.
      fView = opts.view ?? null;
      fPass = null;
      fOwned = false;
      fBound = null;
    },
    endFrame: () => {
      if (!fEnc) return;
      endPass();
      flushRing();
      const enc = fEnc;
      fEnc = null;                         // cleared first: a throwing finish() must not leave it dangling
      fView = null;
      fOwned = false;
      fBound = null;
      submit(enc);
    },
    // Keeps one compute pass open so chained dispatches skip the per-dispatch pass overhead.
    // Works with or without an enclosing frame: inside one the frame owns the submit, outside one
    // this encoder is ours and endCompute() submits it.
    beginCompute: (opts = {}) => {
      if (fPass) return fPass;
      if (!fEnc) { fEnc = mkEnc(DIAG && 'compute'); fOwned = true; }
      fBound = null;                       // fresh chain: nothing bound yet
      return (fPass = fEnc.beginComputePass(opts));
    },
    endCompute: () => {
      endPass();
      if (fOwned) S.endFrame();            // beginCompute() opened the encoder; nothing else submits it
    },

    // ─── Buffers ─────────────────────────────────────────────────────────────────────────────
    /**
     * A storage buffer (big, read+write in compute/fragment) with helpers.
     * @param {number|ArrayBuffer|ArrayBufferView} sizeOrData byte length, or initial contents
     *   (the buffer is sized from it and filled in the same call)
     * @returns {BufferHandle}
     */
    createStorageBuffer: sizeOrData => {
      const init = typeof sizeOrData === 'number' ? null : sizeOrData;
      const n = ((init ? init.byteLength : sizeOrData) + 3) & ~3;  // buffer sizes stay 4-byte aligned
      if (DIAG) checkSize(n, true);
      const b = D.createBuffer({
        size: n, usage: BUF_STORAGE | BUF_COPY_SRC | BUF_COPY_DST,
        ...(DIAG && { label: `storage ${n}B` })
      });
      const w = writerFor(b);
      // `r` is a debug/export path, not a hot one: F_READ drops it (and the staging pool with it).
      const r = !F_READ ? void 0 : async (nbytes = n, o = 0, C = Uint8Array) => {
        if (fEnc) console.warn('[TinyWebGPU] readback during an open frame reads pre-frame data — call endFrame() first.');
        const rb = S._acquireStaging(nbytes);
        const enc = mkEnc(DIAG && 'readback');
        enc.copyBufferToBuffer(b, o, rb, 0, nbytes);
        submit(enc);
        await rb.mapAsync(GPUMapMode.READ);
        const ab = rb.getMappedRange(0, nbytes).slice(0); rb.unmap();  // copy: stays valid after unmap
        S._releaseStaging(rb);
        return C ? new C(ab) : ab;                               // C e.g. Uint32Array, Float32Array
      };
      const clear = () => {
        if (fEnc) return outsidePass(() => fEnc.clearBuffer(b, 0, n));
        const enc = mkEnc(DIAG && 'clear');
        enc.clearBuffer(b, 0, n);
        submit(enc);
      };
      if (init) w(init);
      // Long names alias the short ones, so `parts.write(data)` and `parts.w(data)` are the same
      // function; pick whichever reads better where you are.
      return { b, w, r, clear, buffer: b, write: w, read: r };
    },

    // Explicit usage flags, minimal helpers. Size is rounded up to 4 bytes as above.
    createBuffer: (size, usage) => {
      const n = (size + 3) & ~3;
      if (DIAG) checkSize(n, !!(usage & BUF_STORAGE));
      const b = D.createBuffer({ size: n, usage, ...(DIAG && { label: `buffer ${n}B` }) });
      const w = writerFor(b);
      return { b, w, buffer: b, write: w };
    },

    // Small and read-only in shaders. Written with writeUniforms, or by a pipeline's uniform setters.
    createUniformBuffer: byteLength =>
      D.createBuffer({ size: byteLength, usage: BUF_UNIFORM | BUF_COPY_DST, ...(DIAG && { label: `uniforms ${byteLength}B` }) }),

    // 3×u32 of [x,y,z] workgroup counts, for dispatchIndirect.
    createIndirectBuffer: () => S.createBuffer(12, BUF_INDIRECT | BUF_STORAGE | BUF_COPY_DST),

    // Raw uniform write (DataView or TypedArray).
    writeUniforms: (buffer, dataViewOrTypedArray, byteOffset = 0) =>
      D.queue.writeBuffer(buffer, byteOffset, dataViewOrTypedArray.buffer ?? dataViewOrTypedArray, dataViewOrTypedArray.byteOffset ?? 0, dataViewOrTypedArray.byteLength),

    // ─── Textures & samplers ─────────────────────────────────────────────────────────────────
    // Read-only in shaders except as a render pass output — images, render targets, post-process
    // buffers. COPY_DST is in the default usage set so writeTexture/loadTexture work unopted-in.
    createTexture: (width, height, format = 'rgba8unorm', usage) => D.createTexture({
      size: { width, height }, format, mipLevelCount: 1, sampleCount: 1,
      usage: usage ?? (TEX_RENDER_ATTACHMENT | TEX_BINDING | TEX_COPY_SRC | TEX_COPY_DST),
      ...(DIAG && { label: `texture ${width}x${height} ${format}` })
    }),
    // Writable from WGSL via textureStore(), readable via textureLoad() — compute output,
    // accumulation buffers, GPGPU. Same COPY_DST default.
    createStorageTexture: (width, height, format = 'rgba32float', usage) => D.createTexture({
      size: { width, height }, format, mipLevelCount: 1, sampleCount: 1,
      usage: usage ?? (TEX_BINDING | TEX_STORAGE_BINDING | TEX_COPY_SRC | TEX_COPY_DST),
      ...(DIAG && { label: `storageTexture ${width}x${height} ${format}` })
    }),
    // How the GPU reads pixels when a texture is sampled. Defaults are nearest + clamp-to-edge.
    createSampler: (opts = {}) => D.createSampler({
      magFilter: opts.magFilter ?? 'nearest', minFilter: opts.minFilter ?? 'nearest',
      addressModeU: opts.wrapU ?? 'clamp-to-edge', addressModeV: opts.wrapV ?? 'clamp-to-edge'
    }),

    ...(F_TEXIO ? {
      /**
       * Uploads raw pixel data into a texture (LUTs, generated noise, CPU-side images). Rows are
       * tightly packed unless `bytesPerRow` says otherwise, and `width`/`height` default to the
       * texture's own size. Needs COPY_DST, which `createTexture` includes.
       * @returns {GPUTexture} the same texture, for chaining
       */
      writeTexture: (tex, data, opts = {}) => {
        const w = opts.width ?? tex.width, h = opts.height ?? tex.height;
        const bpt = texelBytes(tex.format);
        if (opts.bytesPerRow == null && !bpt)
          throw Error(MSG ? `writeTexture: unknown bytes-per-texel for format '${tex.format}'; pass bytesPerRow explicitly.` : 9);
        D.queue.writeTexture(
          { texture: tex, mipLevel: opts.mipLevel ?? 0, origin: { x: opts.x ?? 0, y: opts.y ?? 0 } },
          data, { bytesPerRow: opts.bytesPerRow ?? w * bpt, rowsPerImage: h }, { width: w, height: h });
        return tex;
      },

      /**
       * Loads an image into a texture from a URL, Blob, ImageBitmap, <img>, <canvas>,
       * OffscreenCanvas or <video>. Creates a texture sized from the source unless `opts.texture`
       * names one to reuse. `flipY` defaults to false, putting the image's first row at v=0 — the
       * same edge the uv `makeFrag` hands your `frag` starts at, so the default round-trips.
       * @returns {Promise<GPUTexture>}
       */
      loadTexture: async (src, opts = {}) => {
        let source = src;
        if (typeof src === 'string' || src instanceof Blob) {
          const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
          source = await createImageBitmap(blob);
        } else if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
          if (!src.complete) await src.decode();
          source = await createImageBitmap(src);
        }
        // Every accepted source type reports its size under one of these pairs. `||`, not `??`:
        // a <video> always *has* a `width` property and it is 0 until the layout attribute is set,
        // so the nullish form picked the zero and never reached videoWidth.
        const w = source.videoWidth || source.displayWidth || source.width;
        const h = source.videoHeight || source.displayHeight || source.height;
        if (!w || !h) throw Error(MSG ? 'loadTexture: could not determine source dimensions.' : 10);
        // copyExternalImageToTexture requires RENDER_ATTACHMENT in addition to COPY_DST.
        const tex = opts.texture ?? S.createTexture(w, h, opts.format ?? 'rgba8unorm', opts.usage);
        D.queue.copyExternalImageToTexture(
          { source, flipY: opts.flipY ?? false },
          { texture: tex, premultipliedAlpha: opts.premultipliedAlpha ?? false, colorSpace: opts.colorSpace ?? 'srgb' },
          { width: w, height: h });
        // ImageBitmaps we created ourselves are ours to release; caller-owned sources are not.
        if (source !== src && typeof source.close === 'function') source.close();
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
        if (fEnc) console.warn('[TinyWebGPU] readTexture during an open frame reads pre-frame data — call endFrame() first.');
        const w = opts.width ?? tex.width, h = opts.height ?? tex.height;
        const bpt = texelBytes(tex.format);
        if (!bpt) throw Error(MSG ? `readTexture: unknown bytes-per-texel for format '${tex.format}'.` : 11);
        const tight = w * bpt, padded = (tight + 255) & ~255;   // copyTextureToBuffer wants 256-byte rows
        const rb = S._acquireStaging(padded * h);
        const enc = mkEnc(DIAG && 'readTexture');
        enc.copyTextureToBuffer(
          { texture: tex, mipLevel: opts.mipLevel ?? 0, origin: { x: opts.x ?? 0, y: opts.y ?? 0 } },
          { buffer: rb, bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h });
        submit(enc);
        await rb.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(rb.getMappedRange(0, padded * h));
        const out = new Uint8Array(tight * h);
        for (let y = 0; y < h; y++) out.set(src.subarray(y * padded, y * padded + tight), y * tight);  // drop row padding
        rb.unmap();
        S._releaseStaging(rb);
        const f = tex.format;
        const C = opts.Ctor ?? (/32float$/.test(f) ? Float32Array : /32uint$/.test(f) ? Uint32Array
          : /32sint$/.test(f) ? Int32Array : /16uint$/.test(f) ? Uint16Array : /16sint$/.test(f) ? Int16Array : Uint8Array);
        return C === Uint8Array ? out : new C(out.buffer);
      },
    } : {}),

    // ─── Ping-pong ───────────────────────────────────────────────────────────────────────────
    ...(F_PINGPONG ? {
      /**
       * A read/write pair with a swap — the double-buffer a simulation needs when each step reads
       * one copy and writes the other. Both halves are made the same way, so a swap before the
       * first step is harmless.
       * @example
       *   const g = G.createPingPong(W * H * 4);
       *   step.resources = { src: g.read, dst: g.write };   // handles unwrap themselves
       *   step.run(W, H); g.swap();
       * @param {() => *} make
       * @returns {{read: *, write: *, swap: () => void}}
       */
      pingPong: make => {
        const pp = { read: make(), write: make(), swap: () => { const t = pp.read; pp.read = pp.write; pp.write = t; } };
        return pp;
      },
      // Two storage buffers. A TypedArray/ArrayBuffer seeds *both*, so the pair starts consistent.
      createPingPong: sizeOrData => S.pingPong(() => S.createStorageBuffer(sizeOrData)),
      // Two storage textures. Pass `usage` for the render-target flavour (add RENDER_ATTACHMENT).
      createPingPongTexture: (width, height, format = 'rgba16float', usage) =>
        S.pingPong(() => S.createStorageTexture(width, height, format, usage)),
    } : {}),

    // ─── Canvas & inspection ─────────────────────────────────────────────────────────────────
    ...(F_RESIZE ? {
      /**
       * Sizes the canvas backing store to its CSS box × devicePixelRatio, clamped to the device's
       * max texture dimension. Returns the pixel size — drop it straight into a `vec2<f32>`
       * uniform — and whether it changed, so callers can gate reallocating their render targets.
       * @param {HTMLCanvasElement|OffscreenCanvas} [canvas] defaults to the canvas init() configured
       * @returns {{width: number, height: number, changed: boolean}}
       */
      resizeCanvas: (canvas = S.context?.canvas, opts = {}) => {
        if (!canvas) throw Error(MSG ? 'resizeCanvas: no canvas — init() with a context, or pass one.' : 8);
        const dpr = opts.dpr ?? globalThis.devicePixelRatio ?? 1;
        const max = D?.limits.maxTextureDimension2D ?? Infinity;
        // clientWidth is 0 on an OffscreenCanvas (no CSS box) — fall back to the current size.
        const fit = (css, cur) => Math.max(1, Math.min(max, Math.round((css || cur) * dpr)));
        const width = fit(canvas.clientWidth, canvas.width), height = fit(canvas.clientHeight, canvas.height);
        const changed = canvas.width !== width || canvas.height !== height;
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
        const format = opts.format ?? S.format;
        const sample = /uint$/.test(tex.format) ? 'u32' : /sint$/.test(tex.format) ? 'i32' : 'f32';
        // The generated uv has 0 at the *bottom* of the target, so the default inverts y to put the
        // source's first row on the target's first row — images stay upright and show/readTexture
        // round-trips. Writing this blit by hand without the flip is what turns your image over.
        const flip = opts.flipY ? 'uv.y' : '1.0 - uv.y';
        const key = `${format}|${sample}|${opts.flipY ? 1 : 0}`;
        let pending = blitCache.get(key);
        if (!pending) {
          // Keyed on the promise, like shaderCache, so two concurrent first calls share a compile.
          pending = S.makeFrag(`fn frag(uv: vec2<f32>) -> vec4<f32> {
    let d = vec2<f32>(textureDimensions(src));
    let c = vec2<i32>(clamp(vec2<f32>(uv.x, ${flip}) * d, vec2<f32>(0.0), d - 1.0));
    return vec4<f32>(textureLoad(src, c, 0)) * UB.scale + UB.offset;
  }`, { scale: 'vec4<f32>', offset: 'vec4<f32>' }, { src: `texture_2d<${sample}>` }, { format });
          pending.catch(() => blitCache.delete(key));
          blitCache.set(key, pending);
        }
        const p = await pending;
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
          throw Error(MSG ? `save: needs an 8-bit RGBA texture, got '${tex.format}'. Render it into an rgba8unorm target first.` : 19);
        const width = opts.width ?? tex.width, height = opts.height ?? tex.height;
        const px = await S.readTexture(tex, { x: opts.x, y: opts.y, width, height, mipLevel: opts.mipLevel, Ctor: Uint8Array });
        // ImageData is RGBA; the canvas format is BGRA on most platforms, so swap the ends.
        if (tex.format.startsWith('bgra'))
          for (let i = 0; i < px.length; i += 4) { const b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; }
        const cv = new OffscreenCanvas(width, height);
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), width, height), 0, 0);
        const blob = await cv.convertToBlob({ type: opts.type ?? 'image/png', quality: opts.quality ?? 1 });
        if (opts.download !== false) {
          const a = document.createElement('a');
          a.download = filename;
          a.href = URL.createObjectURL(blob);
          a.click();
          // Not revoked immediately: the click starts a download that still has to read the URL.
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }
        return blob;
      },
    } : {}),

    // ─── Escape hatches ──────────────────────────────────────────────────────────────────────
    /**
     * Compiles a WGSL shader module, cached, applying `G.pre`. Compile errors throw with a pretty
     * source-window log; warnings are logged. `applyPre` is false when the caller already ran
     * `G.pre` — makePipeline does, so its cache key is computed on the post-pre source.
     * @param {string} code @returns {Promise<GPUShaderModule>}
     */
    makeShader: (code, applyPre = true) => {
      if (applyPre && S.pre) code = S.pre(code);
      const key = hash(code) + ':' + code.length;   // + length: guards against 32-bit hash collisions
      let promise = shaderCache.get(key);
      if (!promise) {
        // the promise (not the module) is cached, so concurrent calls share one compile
        promise = compileShader(code, key);
        promise.catch(() => shaderCache.delete(key));
        shaderCache.set(key, promise);
      }
      return promise;
    },
    // entries: [{ binding:0, resource:{ buffer } }, { binding:1, resource: textureView }, ...]
    bindGroup: (pipeline, groupIndex, entries) =>
      D.createBindGroup({ layout: pipeline.getBindGroupLayout(groupIndex), entries }),
  };

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // INTERNALS — nothing below is part of the public surface. These are closure consts rather than
  // properties on S because the minifier renames a closure variable to one character.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  // ─── Encoders & passes ─────────────────────────────────────────────────────────────────────
  // The two longest names in the WebGPU surface, spelled once each. Every encoder in the library
  // comes out of mkEnc and every submission goes through submit. `label` is passed as
  // `DIAG && '…'` at the call sites, so the strings fold away with DIAG.
  const mkEnc = label => DIAG ? D.createCommandEncoder({ label }) : D.createCommandEncoder();
  const submit = enc => D.queue.submit([enc.finish()]);

  // Close the chained compute pass without submitting: callers below still need the encoder alive
  // to keep recording. Public endCompute() is the one that may submit.
  const endPass = () => { try { fPass?.end(); } catch { } fPass = null; };

  // Buffer copies cannot be encoded inside a pass. Close the chained pass, encode, then reopen it
  // and restore the pipeline/bind group of whatever was last bound, so a mid-chain write is
  // invisible. The reopen is unconditional — `fBound?.()` would short-circuit its own argument and
  // leave the chain closed when the write comes before the first dispatch.
  const outsidePass = encode => {
    const had = fPass;
    endPass();
    encode();
    if (had) { fPass = fEnc.beginComputePass(); fBound?.(fPass); }
  };

  // ─── Staging ring ──────────────────────────────────────────────────────────────────────────
  // While a frame is open, uniform/buffer writes are staged CPU-side and copyBufferToBuffer'd
  // inside the frame encoder, so writes order against *dispatches* (per-dispatch uniforms in one
  // submit) instead of against whole submits.
  // The `_` field names are minifier instructions: build-min.mjs renames every `_`-prefixed
  // property, and nothing outside this file reads them.
  const ring = { _chunks: [], _i: 0, _cap: 1 << 18 };
  const stageCopy = (dst, dstOff, data, size) => {
    const need = (size + 3) & ~3;       // copyBufferToBuffer needs 4-byte multiples
    while (ring._chunks[ring._i] && ring._chunks[ring._i]._buf.size - ring._chunks[ring._i]._at < need) ring._i++;
    let c = ring._chunks[ring._i];
    if (!c) {
      const cap = Math.max(ring._cap, need);
      c = ring._chunks[ring._i] = {
        _buf: D.createBuffer({ size: cap, usage: BUF_COPY_SRC | BUF_COPY_DST, ...(DIAG && { label: 'staging ring' }) }),
        _cpu: new Uint8Array(cap), _at: 0
      };
    }
    const src = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, size)
      : new Uint8Array(data, 0, size);
    c._cpu.set(src, c._at);
    // The copy is rounded up to 4 bytes; zero the tail so a short write cannot smear whatever the
    // previous frame left in the ring into the bytes past the caller's data.
    if (need > size) c._cpu.fill(0, c._at + size, c._at + need);
    const off = c._at;
    outsidePass(() => fEnc.copyBufferToBuffer(c._buf, off, dst, dstOff, need));
    c._at += need;
  };
  // Upload all staged chunk contents; must run just before submitting the frame encoder (queue
  // writes execute before subsequently submitted command buffers).
  const flushRing = () => {
    for (const c of ring._chunks) {
      if (c._at > 0) D.queue.writeBuffer(c._buf, 0, c._cpu, 0, c._at);
      c._at = 0;
    }
    ring._i = 0;
  };

  // Pooled staging buffers for readbacks, keyed by size, max 4 kept per size. Reached through S
  // (see the test seams at the bottom) so test/layout.test.mjs can stub them.
  const stagingPool = F_READ ? new Map() : null;
  const acquireStaging = !F_READ ? null : size => stagingPool.get(size)?.pop()
    ?? D.createBuffer({ size, usage: BUF_COPY_DST | BUF_MAP_READ, ...(DIAG && { label: 'readback staging' }) });
  const releaseStaging = !F_READ ? null : buf => {
    const list = stagingPool.get(buf.size) ?? [];
    if (list.length < 4) { list.push(buf); stagingPool.set(buf.size, list); }
    else buf.destroy();
  };

  // ─── Small helpers ─────────────────────────────────────────────────────────────────────────
  // FNV-1a, for cache keys.
  const hash = s => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  };

  // The default view of a texture, memoized — bind groups are rebuilt often and a fresh
  // createView() per rebind is pure garbage.
  const viewCache = new WeakMap();
  const viewOf = t => { let v = viewCache.get(t); if (!v) viewCache.set(t, v = t.createView()); return v; };

  // Where a render pass draws when the caller didn't say: the frame's view, else the swapchain.
  // Acquired on first use and, inside a frame, cached — so every pass of one frame draws into the
  // same swapchain texture, and a frame that never draws never acquires one at all.
  const targetView = () => {
    const v = fView ?? S.context?.getCurrentTexture().createView();
    if (!v) throw Error(MSG ? 'No render target: init() was called without a canvas context — pass an explicit view.' : 7);
    if (fEnc) fView = v;
    return v;
  };

  // Bytes per texel, derived from the format name rather than tabulated: <channels><bits><type>.
  // This covers every copyable colour format WebGPU has — including the 16-bit unorm/snorm and
  // rgb10a2uint variants a fixed table kept missing. The three packed formats don't follow the
  // pattern and are named. Depth/stencil formats are absent on purpose: they have no single
  // bytes-per-texel for copies, and callers must pass bytesPerRow.
  const texelBytes = !(F_TEXIO || F_READ) ? null : f => {
    const m = /^(r|rg|rgba|bgra)(8|16|32)/.exec(f);
    return m ? m[1].length * (m[2] / 8) : { 'rgb10a2unorm': 4, 'rgb10a2uint': 4, 'rg11b10ufloat': 4 }[f];
  };

  // Warns (doesn't throw) when a requested size exceeds the device limits — allocation is still
  // attempted, since limits vary wildly across GPUs. Diagnostics only.
  const checkSize = !DIAG ? () => { } : (n, isStorage) => {
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
  const writerFor = b => (d, o = 0) => {
    if (!(ArrayBuffer.isView(d) || d instanceof ArrayBuffer))
      throw Error(MSG ? 'buffer write: expected a TypedArray or ArrayBuffer.' : 5);
    if (!fEnc) return D.queue.writeBuffer(b, o, d.buffer ?? d, d.byteOffset ?? 0, d.byteLength);
    // Staged writes go through copyBufferToBuffer, which only takes 4-byte offsets. Outside a
    // frame the same call would have been fine, so name the constraint instead of letting the
    // driver reject it.
    if (o & 3) throw Error(MSG ? `buffer write: byteOffset must be a multiple of 4 inside beginFrame() (got ${o}).` : 6);
    return stageCopy(b, o, d, d.byteLength);
  };

  const blitCache = F_SHOW ? new Map() : null;

  // Accepts a preset name or a raw GPUBlendState; null/undefined = no blending (opaque).
  const resolveBlend = blend => {
    if (!blend) return null;
    if (typeof blend !== 'string') return blend;
    const b = BLENDS[blend];
    if (!b) throw Error(MSG ? `Unknown blend preset '${blend}'. Use ${OK(BLENDS).map(k => `'${k}'`).join(', ')} or a GPUBlendState object.` : 4);
    return b;
  };

  const compileShader = async (code, label) => {
    const module = D.createShaderModule({ code, ...(DIAG && { label: `shader ${label ?? ''}` }) });
    const info = await module.getCompilationInfo();
    const msgs = info.messages.filter(m => m.message && m.type !== 'info');
    if (msgs.length) {
      const hasError = msgs.some(m => m.type === 'error');
      // DIAG is folded to false in the minified build, which removes this whole formatter. The
      // throw below sits outside it on purpose — errors stay loud in every build.
      if (DIAG) {
        const L = code.split('\n');
        let log = '\n=== WGSL Compile Log ===\n';
        for (const m of msgs) {
          const ln = m.lineNum, col = m.linePos, t = m.type.toUpperCase();
          const s = Math.max(0, ln - 10), e = Math.min(L.length, ln + 4);
          log += `\n${t} @ ${ln}:${col} — ${m.message}\n\n`;
          for (let i = s; i < e; i++) {
            const n = i + 1;
            log += `${String(n).padStart(4, ' ')} | ${L[i]}\n`;
            if (n === ln) log += `     | ${' '.repeat(Math.max(0, col - 1))}^\n`;
          }
        }
        (hasError ? console.error : console.warn)(log);
      }
      if (hasError) throw Error(MSG ? 'WGSL compilation failed.' : 3);
    }
    return module;
  };

  // `layout: 'auto'` derives the bind group layout from what the shader actually references.
  // `format` is one format string, or an array of them for multiple render targets in @location
  // order; a blend state, if given, applies to every target.
  const rawRender = (module, format, topology, blend) => {
    const b = resolveBlend(blend);
    return D.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [format].flat().map(f => b ? { format: f, blend: b } : { format: f }) },
      primitive: { topology },
    });
  };
  const rawCompute = module => D.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  // ─── Schema engine ─────────────────────────────────────────────────────────────────────────
  // Turns the two schema objects into WGSL declarations, a CPU-side uniform struct with a writer,
  // and the bind-group entry builder. Exposed as G.makeSchema for people driving it by hand.
  const buildSchema = (uniforms = {}, resources = {}, opts = {}) => {
    const group = opts.group ?? 0, structName = opts.structName ?? 'Uniforms', varName = opts.varName ?? UNIFORM_VAR;
    // Resources named here are bound `read`, not `read_write`. WebGPU forbids a read_write storage
    // binding from being visible to the vertex stage, so anything a vertex shader reads must say so.
    const readOnly = opts.readOnly ?? [];
    // Uniforms whose var the shader never mentions still get a buffer and setters — only the
    // @binding is left out, so `p.uniforms = {…}` keeps working against a shader that ignores UB.
    const emit = opts.emitUniform ?? true;
    let binding = opts.startBinding ?? 0;

    // [size, align, components, packRows] in 4-byte units, derived from the type string rather than
    // tabulated. WGSL layout rules: scalars are 1/1; vecN is N wide and aligns to N, except vec3
    // which aligns to 4 while still occupying 3 (so a following scalar packs into its tail);
    // matCxR is C columns of vecR, and a 3-row column occupies 4 units like any vec3.
    // `components` is how many numbers the caller supplies — smaller than `size` for exactly the
    // 3-row matrices, whose columns are written on a 4-unit stride. `packRows` flags that case.
    const typeInfo = t => {
      let m;
      if (/^[fiu]32$/.test(t)) return [1, 1, 1, 0];
      if ((m = /^vec([234])<[fiu]32>$/.exec(t))) { const c = +m[1]; return [c, c === 3 ? 4 : c, c, 0]; }
      if ((m = /^mat([234])x([234])<f32>$/.exec(t))) {
        const cols = +m[1], rows = +m[2], stride = rows === 3 ? 4 : rows;
        return [cols * stride, stride, cols * rows, rows === 3 ? 3 : 0];
      }
      throw Error(MSG ? `Unknown uniform type size for: ${t}` : 12);
    };
    const alignTo = (n, a) => Math.ceil(n / a) * a;

    let uniformBuffer = null, uniformWrite = () => { }, uniformWGSL = '';
    const uniformEntries = OE(uniforms);
    if (uniformEntries.length > 0) {
      let offset = 0;
      const layout = {};
      const structFields = uniformEntries.map(([name, wgslType]) => {
        const [size, al, comps, packRows] = typeInfo(wgslType);
        offset = alignTo(offset, al);
        layout[name] = { offset, size, comps, packRows, wgslType };
        offset += size;
        return `  ${name}: ${wgslType},`;
      });

      offset = alignTo(offset, 4);                 // struct size must be 16-byte aligned
      const byteSize = offset * 4;
      uniformBuffer = S.createUniformBuffer(byteSize);
      const buffer = new ArrayBuffer(byteSize);
      const F32 = new Float32Array(buffer), I32 = new Int32Array(buffer), U32 = new Uint32Array(buffer);

      // Resolve the destination view and the integer coercion once, here — this used to be two
      // regexes per field on every setUniforms() call, i.e. in the middle of the animation loop.
      for (const f of OV(layout)) {
        f.isU = /u32/.test(f.wgslType);
        f.isI = /i32/.test(f.wgslType);
        f.view = f.isU ? U32 : f.isI ? I32 : F32;
      }

      uniformWrite = values => {
        for (const [name, value] of OE(values)) {
          const f = layout[name];
          // A name that is not in the schema used to be dropped in silence — the single most
          // expensive typo in the toolkit, since nothing at all happened. Say so instead.
          if (!f) throw Error(MSG ? `Unknown uniform '${name}'. Declared: ${OK(layout).join(', ') || '(none)'}.` : 13);
          // TypedArrays count as vectors/matrices too: a Float32Array mat4 out of a maths library
          // used to fall into the scalar branch and write a single NaN.
          const array = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [value];
          if (DIAG && S.debug && array.length > f.comps)
            console.warn(`Uniform '${name}' provided ${array.length} values but type ${f.wgslType} fits ${f.comps}. Extra values will be ignored.`);
          for (let i = 0; i < f.comps && i < array.length; i++) {
            let x = array[i] ?? 0;
            if (DIAG && S.debug && (f.isI || f.isU) && !Number.isInteger(x))
              console.warn(`Uniform '${name}' expects integer for ${f.wgslType} at index ${i}, got ${x}. It will be truncated.`);
            if (f.isU) x = x >>> 0;
            else if (f.isI) x = x | 0;
            // Straight through, except for a 3-row matrix: the caller hands over tightly packed
            // columns and the buffer wants them on a 4-unit stride.
            f.view[f.offset + (f.packRows ? ((i / 3 | 0) * 4 + i % 3) : i)] = x;
          }
        }
        // Inside an open frame, stage so each dispatch sees the values set before it; otherwise a
        // plain queue write (ordered against the next submit) is enough.
        if (fEnc) stageCopy(uniformBuffer, 0, buffer, buffer.byteLength);
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
    const resourceLayout = {};
    const resourceWGSL = OE(resources).map(([name, wgslType]) => {
      const currentBinding = binding++;
      const isTex = wgslType.startsWith('texture_');
      const isSampler = wgslType === 'sampler' || wgslType === 'sampler_comparison';
      const isBuf = !(isTex || isSampler);

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

      resourceLayout[name] = { binding: currentBinding, wgslType, isBuf, isTex, isSampler };
      const addrSpace = isBuf ? (readOnly.includes(name) ? '<storage, read>' : '<storage, read_write>') : '';
      const varLine = `@group(${group}) @binding(${currentBinding}) var${addrSpace} ${name}: ${typeForBinding};`;
      return decls ? `${decls}\n${varLine}` : varLine;
    });

    // `wgsl` / `uniformBuffer` / `uniformWrite` are the documented shape and keep their names. The
    // rest is internal, so it is `_`-prefixed and the minified build renames it.
    return {
      wgsl: [uniformWGSL, ...resourceWGSL].filter(Boolean).join('\n'),
      uniformBuffer,
      uniformWrite,
      _entries: values => OE(resourceLayout).map(([name, info]) => {
        let resource = values[name];
        if (!resource) return null;
        if (info.isTex && resource.createView) resource = viewOf(resource);
        else if (info.isBuf) resource = { buffer: resource };
        return { binding: info.binding, resource };
      }).filter(Boolean),
      _uniformFields: OK(uniforms),
      _resourceFields: OK(resources),
      _resourceLayout: resourceLayout,
      _uniformBinding: uniformEntries.length > 0 && emit ? (opts.startBinding ?? 0) : null,
    };
  };

  // ─── Pipeline factory ──────────────────────────────────────────────────────────────────────
  // The engine behind makeFrag / makeDraw / makeCompute: generate the schema WGSL, compile and
  // cache the pipeline, and hand back the object those three return.
  const makePipeline = async ({ code, uniforms = {}, resources = {}, format = S.format,
    isCompute = false, blend = null, wg = [8, 8, 1], targetNames = null,
    topology = 'triangle-list', count = 3, instances = 1, readOnly = [] }) => {
    // Declare only what the shader actually mentions. layout:'auto' drops bindings the shader
    // never references, and a bind-group entry for a dropped binding is a validation error — so
    // instead of emitting everything and reconciling afterwards, the schema is filtered up front
    // and the generated WGSL, the binding numbers and the bind group agree by construction.
    const refd = name => new RegExp(`\\b${name}\\b`).test(code);
    const usedResources = Object.fromEntries(OE(resources).filter(([n]) => refd(n)));
    const usesUB = refd(UNIFORM_VAR);
    if (DIAG) {
      const unused = OK(resources).filter(n => !(n in usedResources));
      if (!usesUB && OK(uniforms).length) unused.unshift(`${UNIFORM_VAR} (uniforms)`);
      if (unused.length) console.warn(
        `[TinyWebGPU] Schema declares ${unused.map(n => `'${n}'`).join(', ')} but the shader never references ${unused.length > 1 ? 'them' : 'it'}; ` +
        `${unused.length > 1 ? 'they are' : 'it is'} left out of the generated WGSL and the bind group.`);
    }
    const schema = buildSchema(uniforms, usedResources, { group: 0, startBinding: 0, emitUniform: usesUB, readOnly });
    // Destructured once: these are read on every setResources() and every dispatch, and a local is
    // both faster and — since the minifier renames it — a great deal shorter than the path.
    const { _resourceFields: rFields, _resourceLayout: rLayout, _uniformBinding: uBinding, uniformWrite: uWrite } = schema;

    // Prepend the schema WGSL, then run the G.pre hook once, here — the pipeline cache keys on the
    // result, so switching G.pre can't hand back a stale pipeline.
    const preCode = schema.wgsl ? `${schema.wgsl}\n${code}` : code;
    const finalCode = S.pre ? S.pre(preCode) : preCode;

    // Blend is part of the render key: identical WGSL with a different blend state is a different
    // pipeline, and omitting it here would hand back the wrong one.
    const blendKey = isCompute || !blend ? '' : (typeof blend === 'string' ? blend : JSON.stringify(blend)) + '|';
    const cacheKey = (isCompute ? `C|` : `R|${[format].flat().join(',')}|${blendKey}${topology}|`) + hash(finalCode) + ':' + finalCode.length;
    let pipeline = pipelineCache.get(cacheKey);
    if (!pipeline) {
      const module = await S.makeShader(finalCode, false);   // S.pre already applied above
      // The error scope is purely for reporting: WebGPU rejects a bad pipeline either way, and
      // without DIAG the driver's own message is the one that surfaces.
      if (DIAG) D.pushErrorScope('validation');
      pipeline = isCompute ? rawCompute(module) : rawRender(module, format, topology, blend);
      if (DIAG) D.popErrorScope().then(err => {
        if (!err) return;
        // Evict, or the next build of the same source would reuse the broken pipeline and, having
        // skipped this branch entirely, report nothing at all.
        pipelineCache.delete(cacheKey);
        console.error(`[TinyWebGPU] Pipeline creation failed (${cacheKey}):\n${err.message}`);
      }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
      pipelineCache.set(cacheKey, pipeline);
    }

    let bindGroup = null;
    let bound = null;              // the merged resource map the current bindGroup was built from

    // What a declared type needs the resource to have been created with. Checking it here turns
    // the commonest texture mistake (a plain createTexture behind a texture_storage_2d) from a wall
    // of driver validation text into one line naming the resource and the missing flag. Diagnostics
    // only — WebGPU validates the bind group itself, so the minified build folds this away.
    const usageNeed = !DIAG ? null : info => {
      if (info.isBuf) return [BUF_STORAGE, 'GPUBufferUsage.STORAGE'];
      if (info.isTex) return /^texture_storage_/.test(info.wgslType)
        ? [TEX_STORAGE_BINDING, 'GPUTextureUsage.STORAGE_BINDING (use createStorageTexture)']
        : [TEX_BINDING, 'GPUTextureUsage.TEXTURE_BINDING'];
      return [0, ''];
    };
    const validateResources = !DIAG ? () => { } : vals => {
      const missing = [], mismatched = [];
      for (const name of rFields) {
        const info = rLayout?.[name];
        if (!(name in vals) || vals[name] == null) { missing.push(name); continue; }
        const v = vals[name];
        const expected = info?.wgslType ?? resources[name];
        // Heuristics: catch the obvious mismatches without producing false positives. A sampler is
        // opaque, so it gets no kind check at all.
        let bad = null;
        if (info?.isBuf) {
          if (!(typeof v.mapAsync === 'function' || typeof v.getMappedRange === 'function' || typeof v.buffer?.mapAsync === 'function')) bad = typeof v;
        } else if (info?.isTex) {
          if (!(typeof v.createView === 'function' || 'dimension' in v || 'mipLevelCount' in v)) bad = typeof v;
        }
        // Right kind of object, wrong usage flags: catch it here rather than in the driver.
        if (!bad && info && v.usage != null) {
          const [need, label] = usageNeed(info);
          if (need && !(v.usage & need)) bad = `a ${info.isBuf ? 'buffer' : 'texture'} created without ${label}`;
        }
        if (bad) mismatched.push({ name, expected, got: bad });
      }
      if (!missing.length && !mismatched.length) return;
      const at = n => rLayout?.[n]?.binding != null ? ` (binding ${rLayout[n].binding})` : '';
      let msg = 'BindGroup(0) resource validation failed.';
      if (missing.length) msg += '\nMissing:' + missing.map(n => `\n  - ${n}${at(n)}`).join('');
      if (mismatched.length) msg += '\nMismatched:' + mismatched.map(m => `\n  - ${m.name}${at(m.name)}: expected ${m.expected}, got ${m.got}`).join('');
      throw Error(MSG ? msg : 14);
    };

    // Resources merge into what is already bound and are compared by value, so a partial update
    // ({ grid } after both were set) is legal, and passing the same handles again every frame is
    // free instead of rebuilding a bind group per frame. Buffer handles unwrap themselves.
    const rebindResources = resourceValues => {
      const next = { ...bound };
      for (const [name, v] of OE(resourceValues ?? {}))
        next[name] = rLayout[name]?.isBuf && typeof v?.b?.mapAsync === 'function' ? v.b : v;
      if (bindGroup && bound && rFields.every(n => next[n] === bound[n])) return;
      bound = next;
      if (DIAG && rFields.length > 0) validateResources(next);
      const entries = [
        ...(uBinding != null ? [{ binding: 0, resource: { buffer: schema.uniformBuffer } }] : []),
        ...schema._entries(next),
      ];
      // Reporting only, as at pipeline creation — the driver rejects a bad group regardless.
      if (DIAG) D.pushErrorScope('validation');
      bindGroup = S.bindGroup(pipeline, 0, entries);
      if (DIAG) D.popErrorScope().then(err => {
        if (err) console.error(
          `[TinyWebGPU] createBindGroup failed. If a schema resource is declared but only mentioned in comments/strings, ` +
          `auto layout still removed its binding — remove it from the schema or use it in the shader.\n${err.message}`);
      }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
    };

    // Nothing left for the caller to supply: build @group(0) now. Otherwise wait for
    // setResources, so the group is never built against a layout still missing entries.
    if (uBinding != null && !rFields.length) rebindResources({});

    // Whether @group(0) exists at all. If it does and nothing is bound to it, dispatching produces
    // a bare "bind group 0 is not set" from the driver — say which call is missing instead.
    const needsBindGroup = uBinding != null || rFields.length > 0;

    const bind = pass => {
      if (!bindGroup && needsBindGroup)
        throw Error(MSG ? `No resources bound. Call setResources({ ${rFields.join(', ')} }) before dispatching/drawing.` : 15);
      pass.setPipeline(pipeline);
      if (bindGroup) pass.setBindGroup(0, bindGroup);
    };

    // Records compute work. When beginCompute() has a pass open on the encoder we would use, join
    // it — rebinding only if the last pipeline bound to it was a different one — so chaining is
    // what you get by default and `dispatch()` never silently ends someone else's chain.
    // Otherwise open a pass of our own, and submit if we also own the encoder.
    const computePass = (record, encoder = null) => {
      if (fPass && (!encoder || encoder === fEnc)) {
        if (fBound !== bind) { bind(fPass); fBound = bind; }
        return record(fPass);
      }
      const enc = encoder ?? fEnc ?? mkEnc();
      const pass = enc.beginComputePass();
      bind(pass);
      record(pass);
      pass.end();
      if (!encoder && !fEnc) submit(enc);
    };

    const base = {
      pipeline,
      set uniforms(values) { uWrite(values); },
      setUniform: (name, value) => uWrite({ [name]: value }),
      setUniforms: values => uWrite(values),
      set resources(values) { rebindResources(values); },
      setResources: values => rebindResources(values),
      get uniformFields() { return schema._uniformFields; },
      get resourceFields() { return rFields; },
      // Vertices per instance, and instance count. Plain properties rather than drawTo arguments
      // because a particle count that changes every frame should not need a new pipeline —
      // `p.instances = alive` and draw again.
      count, instances,
    };

    return isCompute ? OA(base, {
      dispatch: (x = 1, y = 1, z = 1, encoder = null) => computePass(p => p.dispatchWorkgroups(x, y, z), encoder),
      // dispatch() counts workgroups; run() counts the items you actually have and divides by the
      // workgroup size for you. Guard the tail with `if (gid.x >= n) { return; }` as usual.
      run: (w = 1, h = 1, d = 1, encoder = null) => computePass(
        p => p.dispatchWorkgroups(Math.ceil(w / wg[0]), Math.ceil(h / (wg[1] ?? 1)), Math.ceil(d / (wg[2] ?? 1))), encoder),
      dispatchIndirect: (buffer, byteOffset = 0, encoder = null) =>
        computePass(p => p.dispatchWorkgroupsIndirect(buffer, byteOffset), encoder),
      // Escape hatch: bind this pipeline to a pass you opened yourself, then dispatch on it with
      // the raw WebGPU calls. Not needed for beginCompute() chains — dispatch() handles those.
      bindTo: (pass = fPass) => {
        if (!pass) throw Error(MSG ? 'No active compute pass. Call G.beginCompute() first, or pass one.' : 17);
        bind(pass);
        // Remember it: a staged write mid-chain has to close and reopen the pass, and the reopened
        // one starts with no pipeline bound.
        if (pass === fPass) fBound = bind;
      },
    }) : OA(base, {
      // Single target: a view or texture, defaulting to the canvas. Multiple targets: an object
      // keyed by the `targets` schema — `drawTo({ colour: a, normal: b })` — so the @location order
      // lives in one place and callers never restate it.
      drawTo: (view, clear = [0, 0, 0, 1], encoder = null) => {
        const c = Array.isArray(clear) ? clear : [0, 0, 0, 1];
        const loadOp = clear === 'load' ? 'load' : 'clear';
        const clearValue = { r: c[0], g: c[1], b: c[2], a: c[3] };
        const asView = v => v.createView ? viewOf(v) : v;
        const views = targetNames
          ? targetNames.map(n => {
            const v = view?.[n];
            if (!v) throw Error(MSG ? `drawTo: no target for '${n}'. Pass { ${targetNames.join(', ')} }.` : 18);
            return asView(v);
          })
          : [view ? asView(view) : targetView()];

        const enc = encoder ?? fEnc ?? mkEnc();
        if (enc === fEnc && fPass) endPass();   // a render pass cannot nest inside the compute pass
        const pass = enc.beginRenderPass({
          colorAttachments: views.map(v => ({ view: v, loadOp, storeOp: 'store', clearValue })),
        });
        bind(pass);
        pass.draw(base.count, base.instances, 0, 0);
        pass.end();
        if (!encoder && !fEnc) submit(enc);
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
