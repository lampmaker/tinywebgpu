/*

Terminology cheatsheet (quick):
  • Buffer  = linear GPU memory (numbers/arrays). Uniform buffers are small read-only for shaders; storage buffers are big and can be read/written by compute/fragment.
  • Texture = 2D/3D image memory (pixels); can be read (sampled) and/or written (as storage texture or render target).
  • Sampler = how to read textures (nearest/linear, clamp/repeat).
  • BindGroup = the actual set of resources (buffers/textures) a shader sees at @group(N).
  • Pipeline = precompiled program + fixed state. Render pipeline (vertex+fragment) or compute pipeline (compute only).
  • CommandEncoder = a recorder for GPU commands for one submission (like a frame). You record passes, then submit.
  • Workgroup = a tile/block of threads in a compute shader (@workgroup_size(x,y)). You dispatch many workgroups.
*/
// ------------------------------

/**
 * @typedef {Object.<string, string>} UniformSchema
 *   name → WGSL basic type: 'f32'|'i32'|'u32'|'vec2/3/4<f32|u32|i32>'|'mat4x4<f32>'.
 *   Generated into a WGSL struct bound as `UB` at @group(0) @binding(0), WGSL layout rules.
 * @typedef {Object.<string, string>} ResourceSchema
 *   name → full WGSL resource type: 'array<T>', 'struct Foo {...}', 'texture_2d<f32>',
 *   'texture_storage_2d<...>', 'sampler', or a primitive (auto-wrapped in a struct).
 *
 * @typedef {Object} StorageBufferHandle
 * @property {GPUBuffer} b - the raw buffer
 * @property {(data: BufferSource, byteOffset?: number) => void} w - write (frame-ordered inside beginFrame)
 * @property {(nbytes?: number, byteOffset?: number, Ctor?: Function) => Promise<*>} r - debug readback; stalls the pipeline
 * @property {() => void} clear - zero the buffer
 *
 * @typedef {Object} PipelineCommon
 * @property {GPURenderPipeline|GPUComputePipeline} pipeline
 * @property {(values: Object) => void} setUniforms - merge values into the CPU struct and upload
 * @property {(name: string, value: *) => void} setUniform
 * @property {(values: Object) => void} setResources - (re)build the bind group; pass GPUBuffers / textures / views
 * @property {string[]} uniformFields
 * @property {string[]} resourceFields
 *
 * @typedef {PipelineCommon & {
 *   dispatch: (x?: number, y?: number, z?: number, encoder?: GPUCommandEncoder) => void,
 *   run: (w?: number, h?: number, d?: number, encoder?: GPUCommandEncoder) => void,
 *   dispatchIndirect: (buffer: GPUBuffer, byteOffset?: number, encoder?: GPUCommandEncoder) => void,
 *   use: (pass?: GPUComputePassEncoder) => void,
 *   dispatchOn: (pass: GPUComputePassEncoder|null, x?: number, y?: number, z?: number) => void,
 *   dispatchIndirectOn: (pass: GPUComputePassEncoder|null, buffer: GPUBuffer, byteOffset?: number) => void,
 * }} ComputePipeline
 * @typedef {PipelineCommon & {
 *   drawTo: (view?: GPUTextureView, clear?: number[]|'load', encoder?: GPUCommandEncoder) => void,
 * }} RenderPipeline
 */

// Build-time diagnostics switch. The minified build flips this to false, which lets dead-code
// elimination drop the WGSL compile-log formatter; console calls are stripped separately.
// Errors still throw in every build — only the reporting goes away. Leave the line shape
// intact: build-min.mjs matches it literally.
const DIAG = true;

// WebGPU usage flags, named here rather than read off the GPUBufferUsage/GPUTextureUsage globals.
// The values are normative in the spec, so this changes nothing at runtime — but it lets the
// minifier fold each one to a literal, and it drops the `typeof … !== 'undefined'` guards the
// globals needed in order to be touched outside a browser.
const BUF_MAP_READ = 1, BUF_COPY_SRC = 4, BUF_COPY_DST = 8,
  BUF_UNIFORM = 64, BUF_STORAGE = 128, BUF_INDIRECT = 256;
const TEX_COPY_SRC = 1, TEX_COPY_DST = 2, TEX_BINDING = 4,
  TEX_STORAGE_BINDING = 8, TEX_RENDER_ATTACHMENT = 16;

/**
 * Creates an independent toolkit instance. Call `await G.init(ctx?)` before anything else.
 * Also settable on the instance: `G.debug`, `G.pre`, `G.onDeviceLost` (see their comments).
 */
export const WEBGPU = () => {
  let S = {
    device: null, context: null, format: null, features: null,
    // performance + diagnostics
    debug: false,
    shaderCache: new Map(),
    pipelineCache: new Map(),
    // `owned` = the encoder was opened by beginCompute() rather than beginFrame(), so endCompute()
    // is the only thing that will ever submit it. `bound` re-applies the last use() to a reopened pass.
    frame: { encoder: null, view: null, cpass: null, owned: false, bound: null },
    // Close the chained compute pass without submitting. Internal: callers below still need the
    // encoder alive to keep recording. Public endCompute() is the one that may submit.
    _endPass: () => { try { S.frame.cpass?.end(); } catch { } S.frame.cpass = null; },
    // Frame API: batch multiple passes into one submission
    beginFrame: (opts = {}) => {
      // If a frame is already open, end it to avoid dangling encoders
      S._endPass();                        // an open compute pass would make finish() throw
      if (S.frame.encoder) {
        try { S.endFrame(); }
        catch (e) {
          console.error('[TinyWebGPU] beginFrame: previous frame encoder could not be submitted — that frame was dropped.', e);
          S.frame.encoder = null;
        }
      }
      S.frame.encoder = S.device.createCommandEncoder({ label: DIAG ? 'frame' : void 0 });
      // Left null unless the caller named a target: the swapchain texture is acquired lazily by
      // _view(), so a compute-only frame never touches (and never presents) the canvas.
      S.frame.view = opts.view ?? null;
      S.frame.cpass = null;
      S.frame.owned = false;
      return S.frame;
    },
    endFrame: () => {
      if (!S.frame.encoder) return;
      S._endPass();                        // ensure any open compute pass is closed
      S._flushRing();
      const enc = S.frame.encoder;
      S.frame.encoder = null;              // cleared first: a throwing finish() must not leave it dangling
      S.frame.view = null;
      S.frame.owned = false;
      S.frame.bound = null;
      S.device.queue.submit([enc.finish()]);
    },
    // Keep a single compute pass open to chain dispatches
    beginCompute: (opts = {}) => {
      if (S.frame.cpass) return S.frame.cpass;
      if (!S.frame.encoder) {
        // No frame is open, so this encoder is ours: endCompute() has to submit it, otherwise
        // every dispatch recorded into it — and every later one — would silently never run.
        S.frame.encoder = S.device.createCommandEncoder({ label: DIAG ? 'compute' : void 0 });
        S.frame.owned = true;
      }
      S.frame.bound = null;                // fresh chain: nothing to restore yet
      return (S.frame.cpass = S.frame.encoder.beginComputePass(opts));
    },
    endCompute: () => {
      S._endPass();
      if (S.frame.owned) S.endFrame();     // beginCompute() opened the encoder; nothing else submits it
    },
    // Buffer copies cannot be encoded inside a pass. Close the chained pass, encode, then reopen
    // it and restore the pipeline/bind group from the last use(), so a mid-chain write is invisible.
    _outsidePass: encode => {
      const had = S.frame.cpass;
      S._endPass();
      encode();
      if (had) S.frame.bound?.(S.frame.cpass = S.frame.encoder.beginComputePass());
    },
    // Called when the GPU device is lost (context crash, driver reset, tab backgrounding).
    // Receives the GPUDeviceLostInfo. The library logs regardless; set this to recover/rebuild.
    onDeviceLost: null,
    //=============================================================================================================================
    // Staging ring: while a frame is open, uniform/buffer writes are staged CPU-side and
    // copyBufferToBuffer'd inside the frame encoder, so writes order against *dispatches*
    // (per-dispatch uniforms in one submit) instead of against whole submits.
    _ring: { chunks: [], i: 0, chunkSize: 1 << 18 },
    _stageCopy: (dst, dstOff, data, size) => {
      const r = S._ring;
      const need = (size + 3) & ~3;       // copyBufferToBuffer needs 4-byte multiples
      while (r.chunks[r.i] && r.chunks[r.i].buf.size - r.chunks[r.i].cursor < need) r.i++;
      let c = r.chunks[r.i];
      if (!c) {
        const cap = Math.max(r.chunkSize, need);
        c = r.chunks[r.i] = {
          buf: S.device.createBuffer({ size: cap, usage: BUF_COPY_SRC | BUF_COPY_DST, label: DIAG ? 'staging ring' : void 0 }),
          cpu: new Uint8Array(cap), cursor: 0
        };
      }
      const src = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, size)
        : new Uint8Array(data, 0, size);
      c.cpu.set(src, c.cursor);
      // The copy is rounded up to 4 bytes; zero the tail so a short write cannot smear
      // whatever the previous frame left in the ring into the bytes past the caller's data.
      if (need > size) c.cpu.fill(0, c.cursor + size, c.cursor + need);
      const off = c.cursor;
      S._outsidePass(() => S.frame.encoder.copyBufferToBuffer(c.buf, off, dst, dstOff, need));
      c.cursor += need;
    },
    // Upload all staged chunk contents; must run just before submitting the frame encoder
    // (queue writes execute before subsequently submitted command buffers).
    _flushRing: () => {
      for (const c of S._ring.chunks) {
        if (c.cursor > 0) S.device.queue.writeBuffer(c.buf, 0, c.cpu, 0, c.cursor);
        c.cursor = 0;
      }
      S._ring.i = 0;
    },
    // Pooled staging buffers for readbacks (keyed by size, max 4 kept per size)
    _stagingPool: new Map(),
    _acquireStaging: size => S._stagingPool.get(size)?.pop()
      ?? S.device.createBuffer({ size, usage: BUF_COPY_DST | BUF_MAP_READ, label: DIAG ? 'readback staging' : void 0 }),
    _releaseStaging: buf => {
      const list = S._stagingPool.get(buf.size) ?? [];
      if (list.length < 4) { list.push(buf); S._stagingPool.set(buf.size, list); }
      else buf.destroy();
    },
    // Simple fast hash (FNV-1a) for cache keys
    _hash: s => {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16);
    },
    // Optional WGSL preprocessing hook: (src: string) => string, applied in makeShader
    // before hashing/compiling. Default null = user WGSL is never rewritten.
    // Must be deterministic — shader/pipeline caches key on the post-pre code.
    // For token shorthands see the optional companion module wgsl_shorthand.js.
    pre: null,
    //=============================================================================================================================
    /**
     * Initializes WebGPU. Pass a canvas 'webgpu' context to render, or nothing for
     * compute-only use (render calls then require an explicit target view).
     * Requests the adapter's max buffer-size limits. Throws if WebGPU is unavailable.
     * @param {GPUCanvasContext|null} [ctx]
     * @param {{features?: string[], limits?: Object, alphaMode?: string}} [opts]
     *   `features` are requested best-effort: any the adapter doesn't support are dropped
     *   with a warning rather than throwing. Check `G.features` for what was granted.
     * @returns {Promise<Object>} this instance, with device/context/format/features populated
     */
    init: async (ctx = null, opts = {}) => {
      if (!navigator.gpu) throw Error('WebGPU not supported');
      const a = await navigator.gpu.requestAdapter();
      if (!a) throw Error('No GPU adapter');

      // Request higher limits up to adapter capabilities (not exceeding)
      const requiredLimits = {
        maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize,
        maxBufferSize: a.limits.maxBufferSize,
        ...(opts.limits ?? {}),
      };

      // Best-effort features: asking for one the adapter lacks would throw, so filter first.
      const wanted = opts.features ?? [];
      const requiredFeatures = wanted.filter(f => a.features.has(f));
      const dropped = wanted.filter(f => !a.features.has(f));
      if (dropped.length) console.warn(`[TinyWebGPU] Adapter does not support ${dropped.map(f => `'${f}'`).join(', ')}; continuing without.`);

      const d = await a.requestDevice({ requiredLimits, requiredFeatures });
      d.lost.then(info => {
        console.error(`[TinyWebGPU] GPU device lost (${info.reason || 'unknown'}): ${info.message}`);
        S.onDeviceLost?.(info);
      });
      d.onuncapturederror = e => console.error('[TinyWebGPU] Uncaptured WebGPU error:', e.error?.message ?? e);
      const f = navigator.gpu.getPreferredCanvasFormat();
      // usage defaults to RENDER_ATTACHMENT, as the spec does; add COPY_SRC to it if you want to
      // G.save() the canvas texture itself rather than your own render target.
      if (ctx) ctx.configure({ device: d, format: f, alphaMode: opts.alphaMode ?? 'opaque', usage: opts.canvasUsage ?? TEX_RENDER_ATTACHMENT });
      Object.assign(S, { device: d, context: ctx, format: f, features: d.features })
      return S;
    },
    //=============================================================================================================================
    /**
     * Compiles a WGSL shader module (cached; applies `G.pre`). Compile errors throw with a
     * pretty source-window log; warnings are logged.
     * @param {string} code @returns {Promise<GPUShaderModule>}
     */
    // `applyPre` is false when the caller already ran S.pre (makePipeline does, so that its own
    // cache key is computed on the post-pre source — see the pipeline cache below).
    makeShader: (code, applyPre = true) => {
      if (applyPre && S.pre) code = S.pre(code);
      // hash + length guards against 32-bit hash collisions returning the wrong module
      const key = S._hash(code) + ':' + code.length;
      let promise = S.shaderCache.get(key);
      if (!promise) {
        // the promise (not the module) is cached, so concurrent calls share one compile
        promise = S._compileShader(code, key);
        promise.catch(() => S.shaderCache.delete(key));
        S.shaderCache.set(key, promise);
      }
      return promise;
    },
    _compileShader: async (code, label) => {
      const module = S.device.createShaderModule({ code, label: DIAG ? `shader ${label ?? ''}` : void 0 });
      const info = await module.getCompilationInfo();
      const msgs = info.messages.filter(m => m.message && m.type !== 'info');
      if (msgs.length) {
        const hasError = msgs.some(m => m.type === 'error');
        // DIAG is folded to false in the minified build, which removes this whole formatter.
        // The throw below sits outside it on purpose — errors stay loud in every build.
        if (DIAG) {
          const L = code.split('\n');
          let log = '\n=== WGSL Compile Log ===\n';
          for (const m of msgs) {
            const ln = m.lineNum, col = m.linePos, t = m.type.toUpperCase(), msg = m.message;
            const s = Math.max(0, ln - 10), e = Math.min(L.length, ln + 4);
            log += `\n${t} @ ${ln}:${col} — ${msg}\n\n`;
            for (let i = s; i < e; i++) {
              const n = i + 1, pad = String(n).padStart(4, ' ');
              log += `${pad} | ${L[i]}\n`;
              if (n === ln) log += `     | ${' '.repeat(Math.max(0, col - 1))}^\n`;
            }
          }
          (hasError ? console.error : console.warn)(log);
        }
        if (hasError) throw new Error('WGSL compilation failed.');
      }
      return module;
    },

    //=============================================================================================================================
    // Pipelines: render and compute
    // Named blend states. 'alpha' expects straight (un-premultiplied) alpha out of frag();
    // 'premultiplied' expects rgb already scaled by a; 'additive' ignores destination alpha.
    _blendPresets: {
      alpha: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
      premultiplied: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
      additive: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    },
    // Accepts a preset name or a raw GPUBlendState; null/undefined = no blending (opaque).
    _resolveBlend: blend => {
      if (!blend) return null;
      if (typeof blend !== 'string') return blend;
      const b = S._blendPresets[blend];
      if (!b) throw new Error(`Unknown blend preset '${blend}'. Use ${Object.keys(S._blendPresets).map(k => `'${k}'`).join(', ')} or a GPUBlendState object.`);
      return b;
    },
    // `format` is one format string, or an array of them for multiple render targets (in
    // @location order). A blend state, if given, applies to every target.
    makeRenderPipeline: (vsModule, fsModule, format, topology = 'triangle-list', blend = null) => {
      const b = S._resolveBlend(blend);
      return S.device.createRenderPipeline({
        layout: 'auto',                                       // 'auto' means use the default layout for this pipeline, which
        vertex: { module: vsModule, entryPoint: 'vs_main' },     // entryPoint is the function name in the WGSL module
        fragment: { module: fsModule, entryPoint: 'fs_main', targets: [format].flat().map(f => b ? { format: f, blend: b } : { format: f }) },
        primitive: { topology }                                 // primitive topology (triangle-list, triangle-strip, line-list, etc.)
      });
    },
    makeComputePipeline: csModule => S.device.createComputePipeline({ layout: 'auto', compute: { module: csModule, entryPoint: 'main' } }),

    //=============================================================================================================================
    // creates a uniform buffer (small, read-only in shaders)
    createUniformBuffer: byteLength => S.device.createBuffer({ size: byteLength, usage: BUF_UNIFORM | BUF_COPY_DST, label: DIAG ? `uniforms ${byteLength}B` : void 0 }),
    //=============================================================================================================================
    // writes data to a uniform buffer (DataView or TypedArray)
    writeUniforms: (buffer, dataViewOrTypedArray, byteOffset = 0) => S.device.queue.writeBuffer(buffer, byteOffset, dataViewOrTypedArray.buffer ?? dataViewOrTypedArray, dataViewOrTypedArray.byteOffset ?? 0, dataViewOrTypedArray.byteLength),
    //=============================================================================================================================
    /**
     * Creates a storage buffer (big, read+write in compute/fragment) with helpers.
     * @param {number|ArrayBuffer|ArrayBufferView} sizeOrData byte length, or initial
     *   contents (the buffer is sized from it and filled in the same call)
     * @returns {StorageBufferHandle}
     */
    // Warns (doesn't throw) when a requested size exceeds the device limits — allocation is
    // still attempted, since limits vary wildly across GPUs. Shared by both buffer creators.
    // Diagnostics only: folded away entirely in the minified build.
    _checkBufferSize: !DIAG ? () => { } : (n, isStorage) => {
      try {
        if (!S.device) return;
        if (n > S.device.limits.maxBufferSize) {
          console.warn(`[TinyWebGPU] Requested buffer size (${n}) exceeds device.maxBufferSize (${S.device.limits.maxBufferSize}).`);
        }
        if (isStorage && n > S.device.limits.maxStorageBufferBindingSize) {
          console.warn(`[TinyWebGPU] Requested storage buffer size (${n}) exceeds device.maxStorageBufferBindingSize (${S.device.limits.maxStorageBufferBindingSize}).`);
        }
      } catch {}
    },
    // Shared buffer writer: staged inside an open frame so writes order against dispatches,
    // a plain queue write outside. Rejects plain Arrays — `[1,2,3]` has no byteLength, and the
    // old `?? d.length` fallback silently wrote 3 bytes of nothing.
    _writer: b => (d, o = 0) => {
      if (!(ArrayBuffer.isView(d) || d instanceof ArrayBuffer))
        throw new Error('buffer write: expected a TypedArray or ArrayBuffer.');
      if (!S.frame.encoder) return S.device.queue.writeBuffer(b, o, d.buffer ?? d, d.byteOffset ?? 0, d.byteLength);
      // Staged writes go through copyBufferToBuffer, which only takes 4-byte offsets. Outside a
      // frame the same call would have been fine, so name the constraint instead of letting the
      // driver reject it.
      if (o & 3) throw new Error(`buffer write: byteOffset must be a multiple of 4 inside beginFrame() (got ${o}).`);
      return S._stageCopy(b, o, d, d.byteLength);
    },
    createStorageBuffer: sizeOrData => {
      const init = typeof sizeOrData === 'number' ? null : sizeOrData;
      const n = ((init ? init.byteLength : sizeOrData) + 3) & ~3;  // buffer sizes stay 4-byte aligned
      S._checkBufferSize(n, true);
      const b = S.device.createBuffer({
        size: n, usage: BUF_STORAGE | BUF_COPY_SRC | BUF_COPY_DST,
        label: DIAG ? `storage ${n}B` : void 0
      });
      const w = S._writer(b);
      const r = async (nbytes = n, o = 0, C = Uint8Array) => {
        if (S.frame.encoder) console.warn('[TinyWebGPU] readback during an open frame reads pre-frame data — call endFrame() first.');
        const rb = S._acquireStaging(nbytes);
        const enc = S.device.createCommandEncoder({ label: DIAG ? 'readback' : void 0 });
        enc.copyBufferToBuffer(b, o, rb, 0, nbytes);
        S.device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const ab = rb.getMappedRange(0, nbytes).slice(0); rb.unmap();  // copy: stays valid after unmap
        S._releaseStaging(rb);
        return C ? new C(ab) : ab;                               // C e.g. Uint32Array, Float32Array
      };
      const clear = () => {
        if (S.frame.encoder) return S._outsidePass(() => S.frame.encoder.clearBuffer(b, 0, n));
        const enc = S.device.createCommandEncoder({ label: DIAG ? 'clear' : void 0 });
        enc.clearBuffer(b, 0, n);
        S.device.queue.submit([enc.finish()]);
      };
      if (init) w(init);
      return { b, w, r, clear };  // b=GPUBuffer, w=write, r=read
    },

    // Generic buffer creator with explicit usage flags; minimal helpers
    createBuffer: (size, usage) => {
      const n = (size + 3) & ~3;                 // same 4-byte rounding createStorageBuffer does
      S._checkBufferSize(n, !!(usage & BUF_STORAGE));
      const b = S.device.createBuffer({ size: n, usage, label: DIAG ? `buffer ${n}B` : void 0 });
      return { b, w: S._writer(b) };
    },

    // Convenience: 3*u32 dispatch indirect args buffer [x,y,z]
    createDispatchIndirectBuffer: () => {
      const usage = BUF_INDIRECT | BUF_STORAGE | BUF_COPY_DST;
      return S.createBuffer(12, usage);
    },

    //=============================================================================================================================
    /**
     * A read/write pair with a swap — the double-buffer a simulation needs when each step reads
     * one copy and writes the other. `make` is any factory; the two wrappers below cover buffers
     * and textures. Both halves are made the same way, so a swap before the first step is harmless.
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
    createPingPongTexture2D: (width, height, format = 'rgba16float', usage) =>
      S.pingPong(() => S.createStorageTexture2D(width, height, format, usage)),

    //=============================================================================================================================
    // Creates a normal 2D texture — good for images, render targets, post-process buffers.
    // Read-only in shaders (except as render pass output). Compact format by default.   
    // COPY_DST is in the default set so writeTexture/loadTexture work without opting in.
    createTexture2D: (width, height, format = 'rgba8unorm', usage) => S.device.createTexture({ size: { width, height }, format, mipLevelCount: 1, sampleCount: 1, usage: usage ?? (TEX_RENDER_ATTACHMENT | TEX_BINDING | TEX_COPY_SRC | TEX_COPY_DST), label: DIAG ? `texture2D ${width}x${height} ${format}` : void 0 }),
    //=============================================================================================================================
    // Creates a storage texture — good for compute shaders, ray tracing accumulation,
    // GPGPU processing, or any case you need to read+write pixels directly in a shader.
    // Writable from WGSL via textureStore() / readable via textureLoad().
    // COPY_DST is in the default set, like createTexture2D, so writeTexture works without opting in.
    createStorageTexture2D: (width, height, format = 'rgba32float', usage) => S.device.createTexture({ size: { width, height }, format, mipLevelCount: 1, sampleCount: 1, usage: usage ?? (TEX_BINDING | TEX_STORAGE_BINDING | TEX_COPY_SRC | TEX_COPY_DST), label: DIAG ? `storageTexture2D ${width}x${height} ${format}` : void 0 }),
    //=============================================================================================================================
    // creates a sampler (how to read textures: nearest/linear, clamp/repeat).,   it tells the GPU how to read pixels from a texture when it’s sampled in a shader.
    // options are:
    //   - magFilter: 'nearest' or 'linear' (default: 'nearest')
    //   - minFilter: 'nearest' or 'linear' (default: 'nearest')
    //   - wrapU: 'clamp-to-edge', 'repeat', or 'mirror-repeat' (default: 'clamp-to-edge')
    //   - wrapV: 'clamp-to-edge', 'repeat', or 'mirror-repeat' (default: 'clamp-to-edge')    
    createSampler: (opts = {}) => S.device.createSampler({ magFilter: opts.magFilter ?? 'nearest', minFilter: opts.minFilter ?? 'nearest', addressModeU: opts.wrapU ?? 'clamp-to-edge', addressModeV: opts.wrapV ?? 'clamp-to-edge' }),
    //=============================================================================================================================
    // The default view of a texture, memoized — bind groups are rebuilt often and a fresh
    // createView() per rebind is pure garbage.
    _views: new WeakMap(),
    _viewOf: t => { let v = S._views.get(t); if (!v) S._views.set(t, v = t.createView()); return v; },
    // Where a render pass draws when the caller didn't say: the frame's view, else the swapchain.
    // Acquired on first use and, inside a frame, cached — so every pass of one frame draws into
    // the same swapchain texture, and a frame that never draws never acquires one at all.
    _view: () => {
      const v = S.frame.view ?? S.context?.getCurrentTexture().createView();
      if (!v) throw new Error('No render target: init() was called without a canvas context — pass an explicit view.');
      if (S.frame.encoder) S.frame.view = v;
      return v;
    },
    /**
     * Sizes the canvas backing store to its CSS box × devicePixelRatio, clamped to the device's
     * max texture dimension. Returns the pixel size — drop it straight into a `vec2<f32>` uniform —
     * and whether it changed, so callers can gate reallocating their own render targets.
     * @param {HTMLCanvasElement|OffscreenCanvas} [canvas] defaults to the canvas init() configured
     * @param {{dpr?: number}} [opts]
     * @returns {{width: number, height: number, changed: boolean}}
     */
    resizeCanvas: (canvas = S.context?.canvas, opts = {}) => {
      if (!canvas) throw new Error('resizeCanvas: no canvas — init() with a context, or pass one.');
      const dpr = opts.dpr ?? globalThis.devicePixelRatio ?? 1;
      const max = S.device?.limits.maxTextureDimension2D ?? Infinity;
      // clientWidth is 0 on an OffscreenCanvas (no CSS box) — fall back to the current size.
      const fit = (css, cur) => Math.max(1, Math.min(max, Math.round((css || cur) * dpr)));
      const width = fit(canvas.clientWidth, canvas.width), height = fit(canvas.clientHeight, canvas.height);
      const changed = canvas.width !== width || canvas.height !== height;
      if (changed) { canvas.width = width; canvas.height = height; }
      return { width, height, changed };
    },
    // Bytes per texel, derived from the format name rather than tabulated: <channels><bits><type>.
    // This covers every copyable colour format WebGPU has — including the 16-bit unorm/snorm and
    // rgb10a2uint variants a fixed table kept missing — so writeTexture/readTexture stop demanding
    // an explicit bytesPerRow for them. The three packed formats don't follow the pattern and are
    // named. Depth/stencil formats are absent on purpose: they have no single bytes-per-texel for
    // copies, and callers must pass bytesPerRow.
    _texelBytes: f => {
      const m = /^(r|rg|rgba|bgra)(8|16|32)/.exec(f);
      return m ? m[1].length * (m[2] / 8) : { 'rgb10a2unorm': 4, 'rgb10a2uint': 4, 'rg11b10ufloat': 4 }[f];
    },
    /**
     * Uploads raw pixel data into a texture (LUTs, generated noise, CPU-side images).
     * The texture needs COPY_DST usage — the default from `createTexture2D` has it.
     * @param {GPUTexture} tex
     * @param {ArrayBuffer|ArrayBufferView} data tightly packed rows unless bytesPerRow says otherwise
     * @param {{width?:number,height?:number,x?:number,y?:number,bytesPerRow?:number,mipLevel?:number}} [opts]
     *   width/height default to the texture's own size (a full-surface upload)
     * @returns {GPUTexture} the same texture, for chaining
     */
    writeTexture: (tex, data, opts = {}) => {
      const w = opts.width ?? tex.width, h = opts.height ?? tex.height;
      const bpt = S._texelBytes(tex.format);
      if (opts.bytesPerRow == null && !bpt)
        throw new Error(`writeTexture: unknown bytes-per-texel for format '${tex.format}'; pass bytesPerRow explicitly.`);
      const bytesPerRow = opts.bytesPerRow ?? w * bpt;
      S.device.queue.writeTexture(
        { texture: tex, mipLevel: opts.mipLevel ?? 0, origin: { x: opts.x ?? 0, y: opts.y ?? 0 } },
        data, { bytesPerRow, rowsPerImage: h }, { width: w, height: h });
      return tex;
    },
    /**
     * Loads an image into a texture. Accepts a URL, Blob, ImageBitmap, <img>, <canvas>,
     * OffscreenCanvas or <video>. Creates a texture sized from the source unless one is
     * passed in `opts.texture`.
     *
     * Note on orientation: `flipY` defaults to false, which puts the image's first row at
     * v=0. The uv `makeRender` hands your `frag` also starts at 0 on that edge, so the
     * default round-trips; set `flipY: true` if your source is bottom-up.
     * @param {string|Blob|ImageBitmap|HTMLImageElement|HTMLCanvasElement|OffscreenCanvas|HTMLVideoElement} src
     * @param {{texture?:GPUTexture,format?:string,usage?:number,flipY?:boolean,premultipliedAlpha?:boolean,colorSpace?:string}} [opts]
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
      if (!w || !h) throw new Error('loadTexture: could not determine source dimensions.');
      // copyExternalImageToTexture requires RENDER_ATTACHMENT in addition to COPY_DST.
      const tex = opts.texture ?? S.createTexture2D(w, h, opts.format ?? 'rgba8unorm', opts.usage);
      S.device.queue.copyExternalImageToTexture(
        { source, flipY: opts.flipY ?? false },
        { texture: tex, premultipliedAlpha: opts.premultipliedAlpha ?? false, colorSpace: opts.colorSpace ?? 'srgb' },
        { width: w, height: h });
      // ImageBitmaps we created ourselves are ours to release; caller-owned sources are not.
      if (source !== src && typeof source.close === 'function') source.close();
      return tex;
    },
    /**
     * Reads pixels back from a texture. The mirror of `writeTexture`, and the texture counterpart
     * of `createStorageBuffer().r` — a debug/export tool with the same caveat: it stalls the
     * pipeline. The texture needs COPY_SRC; both texture creators include it by default.
     * @param {GPUTexture} tex
     * @param {{x?:number,y?:number,width?:number,height?:number,mipLevel?:number,Ctor?:Function}} [opts]
     *   width/height default to the whole texture; `Ctor` defaults from the format.
     * @returns {Promise<*>} tightly packed rows (row padding removed), as `Ctor`
     */
    readTexture: async (tex, opts = {}) => {
      if (S.frame.encoder) console.warn('[TinyWebGPU] readTexture during an open frame reads pre-frame data — call endFrame() first.');
      const w = opts.width ?? tex.width, h = opts.height ?? tex.height;
      const bpt = S._texelBytes(tex.format);
      if (!bpt) throw new Error(`readTexture: unknown bytes-per-texel for format '${tex.format}'.`);
      const tight = w * bpt, padded = (tight + 255) & ~255;   // copyTextureToBuffer wants 256-byte rows
      const rb = S._acquireStaging(padded * h);
      const enc = S.device.createCommandEncoder({ label: DIAG ? 'readTexture' : void 0 });
      enc.copyTextureToBuffer(
        { texture: tex, mipLevel: opts.mipLevel ?? 0, origin: { x: opts.x ?? 0, y: opts.y ?? 0 } },
        { buffer: rb, bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h });
      S.device.queue.submit([enc.finish()]);
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
    // ------------------------------
    // 6) Bind groups: connect buffers/textures to @group(N)/@binding(M)
    // entries: [{ binding:0, resource:{ buffer } }, { binding:1, resource: textureView }, ...]
    bindGroup: (pipeline, groupIndex, entries) => S.device.createBindGroup({ layout: pipeline.getBindGroupLayout(groupIndex), entries }),


    // ======== Ultra-Simplified Dual Schema Handler ========
    makeUniformsAndResources: (uniforms = {}, resources = {}, opts = {}) => {
      const g = opts.g ?? 0, n = opts.n ?? 'Uniforms', v = opts.v ?? 'UB';
      // Uniforms whose var the shader never mentions still get a buffer and setters — only the
      // @binding is left out, so `p.uniforms = {…}` keeps working against a shader that ignores UB.
      const emit = opts.emitUniform ?? true;
      let binding = opts.startBinding ?? 0;

      // [size, align, components, packRows] in 4-byte units, derived from the type string rather
      // than tabulated. WGSL layout rules: scalars are 1/1; vecN is N wide and aligns to N, except
      // vec3 which aligns to 4 while still occupying 3 (so a following scalar packs into its tail);
      // matCxR is C columns of vecR, and a 3-row column occupies 4 units like any vec3.
      // `components` is how many numbers the caller supplies — smaller than `size` for exactly the
      // 3-row matrices, whose columns are written on a 4-unit stride. `packRows` flags that case.
      const _info = t => {
        let m;
        if (/^[fiu]32$/.test(t)) return [1, 1, 1, 0];
        if ((m = /^vec([234])<[fiu]32>$/.exec(t))) { const c = +m[1]; return [c, c === 3 ? 4 : c, c, 0]; }
        if ((m = /^mat([234])x([234])<f32>$/.exec(t))) {
          const cols = +m[1], rows = +m[2], stride = rows === 3 ? 4 : rows;
          return [cols * stride, stride, cols * rows, rows === 3 ? 3 : 0];
        }
        throw new Error(`Unknown uniform type size for: ${t}`);
      };
      const alignTo = (n, a) => Math.ceil(n / a) * a;

      // Build uniform buffer
      let uniformBuffer = null, uniformWrite = () => { }, uniformWGSL = '';

      const uniformEntries = Object.entries(uniforms);
      if (uniformEntries.length > 0) {
        let offset = 0;
        const layout = {};

        const structFields = uniformEntries.map(([name, wgslType]) => {
          const [size, al, comps, packRows] = _info(wgslType);
          offset = alignTo(offset, al);
          layout[name] = { offset, size, comps, packRows, wgslType };
          offset += size;
          return `  ${name}: ${wgslType},`;
        });

        // struct size must be 16-byte aligned (4 floats)
        offset = alignTo(offset, 4);
        const byteSize = offset * 4;

        uniformBuffer = S.createUniformBuffer(byteSize);
        const buffer = new ArrayBuffer(byteSize);
        const F32 = new Float32Array(buffer);
        const I32 = new Int32Array(buffer);
        const U32 = new Uint32Array(buffer);

        // Resolve the destination view and the integer coercion once, here — this used to be two
        // regexes per field on every setUniforms() call, i.e. in the middle of the animation loop.
        for (const f of Object.values(layout)) {
          f.isU = /u32/.test(f.wgslType);
          f.isI = /i32/.test(f.wgslType);
          f.view = f.isU ? U32 : f.isI ? I32 : F32;
        }

        uniformWrite = values => {
          for (const [name, value] of Object.entries(values)) {
            const f = layout[name];
            // A name that is not in the schema used to be dropped in silence — the single most
            // expensive typo in the toolkit, since nothing at all happened. Say so instead.
            if (!f) throw new Error(`Unknown uniform '${name}'. Declared: ${Object.keys(layout).join(', ') || '(none)'}.`);
            // TypedArrays count as vectors/matrices too: a Float32Array mat4 out of a maths
            // library used to fall into the scalar branch and write a single NaN.
            const array = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [value];
            if (S.debug && array.length > f.comps) {
              console.warn(`Uniform '${name}' provided ${array.length} values but type ${f.wgslType} fits ${f.comps}. Extra values will be ignored.`);
            }
            for (let i = 0; i < f.comps && i < array.length; i++) {
              let x = array[i] ?? 0;
              if (S.debug && (f.isI || f.isU) && !Number.isInteger(x)) {
                console.warn(`Uniform '${name}' expects integer for ${f.wgslType} at index ${i}, got ${x}. It will be truncated.`);
              }
              if (f.isU) x = x >>> 0;      // ensure unsigned
              else if (f.isI) x = x | 0;   // ensure signed 32-bit
              // Straight through, except for a 3-row matrix: the caller hands over tightly packed
              // columns and the buffer wants them on a 4-unit stride.
              f.view[f.offset + (f.packRows ? ((i / 3 | 0) * 4 + i % 3) : i)] = x;
            }
          }
          // Inside an open frame, stage so each dispatch sees the values set before it;
          // otherwise a plain queue write (ordered against the next submit) is enough.
          if (S.frame.encoder) S._stageCopy(uniformBuffer, 0, buffer, buffer.byteLength);
          else S.writeUniforms(uniformBuffer, buffer);
        };

        if (emit) {
          uniformWGSL = `struct ${n} {
${structFields.join('\n')}
}\n@group(${g}) @binding(${binding}) var<uniform> ${v}: ${n};`;
          binding++;
        }
      }

      // Build resources - direct WGSL types
      // Rule: any resource that is NOT a texture/sampler is treated as a storage buffer and must declare an address space.
      // Supports three forms for non-texture resources:
      //   1) array<...>  (kept as-is)
      //   2) struct Type { ... }  (we emit the struct and bind var<storage> name: Type)
      //   3) primitive or vector/matrix type (we auto-wrap into a struct: struct name_buf { value: T; })
      const resourceLayout = {};
      const resourceWGSL = Object.entries(resources).map(([name, wgslType]) => {
        const currentBinding = binding++;
        const isTex = wgslType.startsWith('texture_');
        const isSampler = wgslType === 'sampler' || wgslType === 'sampler_comparison';
        const isBufferLike = !(isTex || isSampler);

        let decls = '';
        let typeForBinding = wgslType;
        if (isBufferLike) {
          const isArray = wgslType.startsWith('array<');
          const isStructDef = /^struct\s+/.test(wgslType);
          if (isStructDef) {
            // Expect full struct definition provided; extract the type name for the binding
            decls += wgslType.trim();
            // Try to extract the struct name
            const m = wgslType.match(/^struct\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (m) typeForBinding = m[1];
          } else if (!isArray) {
            // Primitive/vector/matrix: auto-wrap into a struct so it's bindable as a buffer
            const wrappedName = `${name}_buf`;
            decls += `struct ${wrappedName} {\n  value: ${wgslType},\n}`;
            typeForBinding = wrappedName;
          }
        }

        resourceLayout[name] = { binding: currentBinding, wgslType, isBuf: isBufferLike, isTex, isSampler };
        const addrSpace = isBufferLike ? '<storage, read_write>' : '';
        const varLine = `@group(${g}) @binding(${currentBinding}) var${addrSpace} ${name}: ${typeForBinding};`;
        return decls ? `${decls}\n${varLine}` : varLine;
      });

      // Create bind group entries for resources
    const createResourceEntries = values => Object.entries(resourceLayout)
        .map(([name, info]) => {
          let resource = values[name];
          if (!resource) return null;
          if (info.isTex && resource.createView) {
            resource = S._viewOf(resource);
          } else if (info.isBuf) {
            resource = { buffer: resource };
          }
          return { binding: info.binding, resource };
        }).filter(Boolean);

      return {
        wgsl: [uniformWGSL, ...resourceWGSL].filter(Boolean).join('\n'),
        uniformBuffer,
        uniformWrite,
        createResourceEntries,
        uniformFields: Object.keys(uniforms),
  resourceFields: Object.keys(resources),
  resourceLayout,
  uniformVar: uniformEntries.length > 0 ? v : null,
  uniformBinding: uniformEntries.length > 0 && emit ? (opts.startBinding ?? 0) : null
      };
    }
  };



  // The generated uniform variable's name; makePipeline tests the shader for it.
  const UNIFORM_VAR = 'UB';

  //=============================================================================================================================
  // Simplified Dual-Schema Pipeline Factory
  // uniforms: object with WGSL basic types (f32, vec2<f32>, etc.)
  // resources: object with full WGSL resource types (texture_storage_2d<...>, array<...>, etc.)

  const makePipeline = async ({ code, uniforms = {}, resources = {}, format = S.format, isCompute = false, blend = null, wg = [8, 8, 1], targetNames = null }) => {
    // Declare only what the shader actually mentions. layout:'auto' drops bindings the shader
    // never references, and a bind-group entry for a dropped binding is a validation error — so
    // instead of emitting everything and reconciling afterwards, the schema is filtered up front
    // and the generated WGSL, the binding numbers and the bind group agree by construction.
    const refd = name => new RegExp(`\\b${name}\\b`).test(code);
    const usedResources = Object.fromEntries(Object.entries(resources).filter(([n]) => refd(n)));
    const usesUB = refd(UNIFORM_VAR);
    if (DIAG) {
      const unused = Object.keys(resources).filter(n => !(n in usedResources));
      if (!usesUB && Object.keys(uniforms).length) unused.unshift(`${UNIFORM_VAR} (uniforms)`);
      if (unused.length) console.warn(
        `[TinyWebGPU] Schema declares ${unused.map(n => `'${n}'`).join(', ')} but the shader never references ${unused.length > 1 ? 'them' : 'it'}; ` +
        `${unused.length > 1 ? 'they are' : 'it is'} left out of the generated WGSL and the bind group.`);
    }
    const schemaResult = S.makeUniformsAndResources(uniforms, usedResources, { g: 0, startBinding: 0, emitUniform: usesUB });

    // Prepend schema-generated WGSL to shader code, then run the G.pre hook once, here — the
    // pipeline cache keys on the result, so switching G.pre can't hand back a stale pipeline.
    const preCode = schemaResult.wgsl ? `${schemaResult.wgsl}\n${code}` : code;
    const finalCode = S.pre ? S.pre(preCode) : preCode;

    // Pipeline cache (hash + length: see makeShader collision note).
    // Blend is part of the render key: identical WGSL with a different blend state is a
    // different pipeline, and omitting it here would hand back the wrong one.
    const blendKey = isCompute || !blend ? '' : (typeof blend === 'string' ? blend : JSON.stringify(blend)) + '|';
    const cacheKey = (isCompute ? `C|` : `R|${[format].flat().join(',')}|${blendKey}`) + S._hash(finalCode) + ':' + finalCode.length;
    let pipeline = S.pipelineCache.get(cacheKey);
    if (!pipeline) {
      const module = await S.makeShader(finalCode, false);   // S.pre already applied above
      S.device.pushErrorScope('validation');
      pipeline = isCompute ? S.makeComputePipeline(module) : S.makeRenderPipeline(module, module, format, 'triangle-list', blend);
      S.device.popErrorScope().then(err => {
        if (!err) return;
        // Evict, or the next build of the same source would reuse the broken pipeline and,
        // having skipped this branch entirely, report nothing at all.
        S.pipelineCache.delete(cacheKey);
        console.error(`[TinyWebGPU] Pipeline creation failed (${cacheKey}):\n${err.message}`);
      }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
      S.pipelineCache.set(cacheKey, pipeline);
    }

    // Bind group handling
    let bindGroup = null;
    let bound = null;              // the merged resource map the current bindGroup was built from
    // What a declared type needs the resource to have been created with. Checking it here turns
    // the commonest texture mistake (a plain createTexture2D behind a texture_storage_2d) from a
    // wall of driver validation text into one line naming the resource and the missing flag.
    const _usageNeed = info => {
      if (info.isBuf) return [BUF_STORAGE, 'GPUBufferUsage.STORAGE'];
      if (info.isTex) return /^texture_storage_/.test(info.wgslType)
        ? [TEX_STORAGE_BINDING, 'GPUTextureUsage.STORAGE_BINDING (use createStorageTexture2D)']
        : [TEX_BINDING, 'GPUTextureUsage.TEXTURE_BINDING'];
      return [0, ''];
    };
    // Diagnostics only. WebGPU validates the bind group itself; this exists to name the resource
    // and the missing usage flag instead of handing you a wall of driver text, so the minified
    // build folds it away and lets the driver's own error through.
    const validateResources = !DIAG ? () => { } : (resourceValues) => {
      const expected = schemaResult.resourceFields;
      const missing = [];
      const mismatched = [];
      const vals = resourceValues || {};
      for (const name of expected) {
        const info = schemaResult.resourceLayout?.[name];
        if (!(name in vals) || vals[name] == null) { missing.push(name); continue; }
        const v = vals[name];
        const expectedType = info?.wgslType ?? resources[name];
        // Heuristic checks to catch obvious mismatches while avoiding false positives
        let bad = null;
        if (info?.isBuf) {
          const isGPUBuffer = typeof v.mapAsync === 'function' || typeof v.getMappedRange === 'function' || typeof v.buffer?.mapAsync === 'function';
          if (!isGPUBuffer) bad = typeof v;
        } else if (info?.isTex) {
          const looksLikeTextureOrView = typeof v.createView === 'function' || 'dimension' in v || 'mipLevelCount' in v;
          if (!looksLikeTextureOrView) bad = typeof v;
        } else if (expectedType === 'sampler') {
          // Best-effort: sampler is opaque; skip strict check
        }
        // Right kind of object, wrong usage flags: catch it here rather than in the driver.
        if (!bad && info && v.usage != null) {
          const [need, label] = _usageNeed(info);
          if (need && !(v.usage & need)) bad = `a ${info.isBuf ? 'buffer' : 'texture'} created without ${label}`;
        }
        if (bad) mismatched.push({ name, expected: expectedType, got: bad });
      }
      if (missing.length || mismatched.length) {
        let msg = 'BindGroup(0) resource validation failed.';
        if (missing.length) {
          msg += '\nMissing:';
          for (const n of missing) {
            const b = schemaResult.resourceLayout?.[n]?.binding;
            msg += `\n  - ${n}${(b!=null?` (binding ${b})`:'')}`;
          }
        }
        if (mismatched.length) {
          msg += '\nMismatched:';
          for (const m of mismatched) {
            const b = schemaResult.resourceLayout?.[m.name]?.binding;
            msg += `\n  - ${m.name}${(b!=null?` (binding ${b})`:'')}: expected ${m.expected}, got ${m.got}`;
          }
        }
        throw new Error(msg);
      }
    };
    // Resources merge into what is already bound and are compared by value, so a partial update
    // ({ grid } after both were set) is legal, and passing the same handles again every frame is
    // free instead of rebuilding a bind group per frame. `{b, w, r}` handles unwrap themselves.
    const rebindResources = (resourceValues) => {
      const next = { ...bound };
      for (const [name, v] of Object.entries(resourceValues ?? {}))
        next[name] = schemaResult.resourceLayout[name]?.isBuf && typeof v?.b?.mapAsync === 'function' ? v.b : v;
      if (bindGroup && bound && schemaResult.resourceFields.every(n => next[n] === bound[n])) return;
      bound = next;
      const baseEntries = schemaResult.uniformBinding != null ? [{ binding: 0, resource: { buffer: schemaResult.uniformBuffer } }] : [];
      if (schemaResult.resourceFields.length > 0) validateResources(next);
      const resourceEntries = schemaResult.createResourceEntries(next);
      const entries = [...baseEntries, ...resourceEntries];
      S.device.pushErrorScope('validation');
      bindGroup = S.bindGroup(pipeline, 0, entries);
      S.device.popErrorScope().then(err => {
        if (err) console.error(
          `[TinyWebGPU] createBindGroup failed. If a schema resource is declared but only mentioned in comments/strings, ` +
          `auto layout still removed its binding — remove it from the schema or use it in the shader.\n${err.message}`);
      }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
    };

    // Nothing left for the caller to supply: build @group(0) now. Otherwise wait for
    // setResources, so the group is never built against a layout still missing entries.
    if (schemaResult.uniformBinding != null && !schemaResult.resourceFields.length) rebindResources({});

    // Whether @group(0) exists at all. If it does and nothing is bound to it, dispatching produces
    // a bare "bind group 0 is not set" from the driver — say which call is missing instead.
    const needsBindGroup = schemaResult.uniformBinding != null || schemaResult.resourceFields.length > 0;

    // Applies this pipeline's state to a compute pass. Also stashed on the frame by use(), so a
    // pass torn down and reopened around a staged write comes back with the same state.
    const bind = pass => {
      if (!bindGroup && needsBindGroup)
        throw new Error(`No resources bound. Call setResources({ ${schemaResult.resourceFields.join(', ')} }) before dispatching/drawing.`);
      pass.setPipeline(pipeline);
      if (bindGroup) pass.setBindGroup(0, bindGroup);
    };

    // Opens a pass, binds this pipeline, lets `record` put work in it, and submits if it owns the
    // encoder. Every entry point below goes through here — direct dispatch, indirect and draw —
    // so the encoder/pass lifecycle exists in exactly one place. `desc` null = a compute pass.
    const runPass = (record, desc = null, encoder = null) => {
      const enc = encoder ?? S.frame.encoder ?? S.device.createCommandEncoder();
      // A chained compute pass (beginCompute) may still be open on the frame encoder;
      // close it before opening another pass — two open passes is a validation error.
      // _endPass, not endCompute: `enc` is that same encoder and must stay open to record into.
      if (enc === S.frame.encoder && S.frame.cpass) S._endPass();
      const pass = desc ? enc.beginRenderPass(desc) : enc.beginComputePass();
      bind(pass);
      record(pass);
      pass.end();
      if (!encoder && !S.frame.encoder) S.device.queue.submit([enc.finish()]);
    };

    const onPass = pass => { const p = pass ?? S.frame.cpass; if (!p) throw new Error('No active compute pass'); return p; };

    // Common interface
    const common = {
      pipeline,
      set uniforms(values) { schemaResult.uniformWrite(values); },
      setUniform: (name, value) => schemaResult.uniformWrite({ [name]: value }),
      setUniforms: (values) => schemaResult.uniformWrite(values),
      set resources(values) { rebindResources(values); },
      setResources: (values) => rebindResources(values),
      get uniformFields() { return schemaResult.uniformFields; },
      get resourceFields() { return schemaResult.resourceFields; }
    };

    return isCompute ? Object.assign(common, {
      dispatch: (x = 1, y = 1, z = 1, encoder = null) => runPass(p => p.dispatchWorkgroups(x, y, z), null, encoder),
      // dispatch() counts workgroups; run() counts the items you actually have and divides by the
      // workgroup size for you — the `Math.ceil(n / 64)` every call site was writing by hand.
      // Guard the tail with `if (gid.x >= n) { return; }` as usual.
      run: (w = 1, h = 1, d = 1, encoder = null) => runPass(
        p => p.dispatchWorkgroups(Math.ceil(w / wg[0]), Math.ceil(h / (wg[1] ?? 1)), Math.ceil(d / (wg[2] ?? 1))), null, encoder),
      dispatchIndirect: (buffer, byteOffset = 0, encoder = null) =>
        runPass(p => p.dispatchWorkgroupsIndirect(buffer, byteOffset), null, encoder),
      // New: reuse an existing compute pass for chaining
      use: (pass = S.frame.cpass) => {
        if (!pass) throw new Error('No active compute pass. Call WG.beginCompute() first or pass a compute pass.');
        bind(pass);
        // Remember it: a staged write mid-chain has to close and reopen the pass, and the
        // reopened one starts with no pipeline bound.
        if (pass === S.frame.cpass) S.frame.bound = bind;
      },
      dispatchOn: (pass, x = 1, y = 1, z = 1) => onPass(pass).dispatchWorkgroups(x, y, z),
      dispatchIndirectOn: (pass, buffer, byteOffset = 0) => onPass(pass).dispatchWorkgroupsIndirect(buffer, byteOffset)
    }) : Object.assign(common, {
      // Single target: a view or texture, defaulting to the canvas. Multiple targets: an object
      // keyed by the `targets` schema — `drawTo({ colour: a, normal: b })` — so the @location
      // order lives in one place and callers never restate it.
      drawTo: (view, clear = [0, 0, 0, 1], encoder = null) => {
        const c = Array.isArray(clear) ? clear : [0, 0, 0, 1];
        const loadOp = clear === 'load' ? 'load' : 'clear';
        const clearValue = { r: c[0], g: c[1], b: c[2], a: c[3] };
        const asView = v => v.createView ? S._viewOf(v) : v;
        const views = targetNames
          ? targetNames.map(n => {
            const v = view?.[n];
            if (!v) throw new Error(`drawTo: no target for '${n}'. Pass { ${targetNames.join(', ')} }.`);
            return asView(v);
          })
          : [view ? asView(view) : S._view()];
        return runPass(p => p.draw(3, 1, 0, 0), {
          colorAttachments: views.map(v => ({ view: v, loadOp, storeOp: 'store', clearValue }))
        }, encoder);
      }
    });
  };

  //=============================================================================================================================
  // Simplified Dual-Schema Pipeline Creators
  // uniforms: basic WGSL types (f32, vec2<f32>, mat4x4<f32>, etc.)
  // resources: full WGSL resource types (texture_storage_2d<rgba32float, write>, array<Ray>, etc.)

  /**
   * Builds a compute pipeline from a dual schema.
   * @param {string} body WGSL declarations (functions, structs)
   * @param {string} main WGSL statements for the generated entry point; receives `gid`, `lid`, `wid`
   * @param {UniformSchema} [uniforms]
   * @param {ResourceSchema} [resources]
   * @param {{wg?: number[]}} [opts] workgroup size, default [8,8,1]
   * @returns {Promise<ComputePipeline>}
   */
  S.makeCompute = (body, main, uniforms = {}, resources = {}, { wg = [8, 8, 1] } = {}) => {
    // Generate compute shader code
    // Kept flush-left: this text is prepended to every generated shader, so it is hashed,
    // compiled, and line-numbered in compile errors.
    const code = `${body}
@compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
${main}
}
`.trim();

    return makePipeline({ code, uniforms, resources, isCompute: true, wg });
  };

  /**
   * Builds a fullscreen-triangle render pipeline. You provide
   * `fn frag(uv: vec2<f32>) -> vec4<f32>`; vertex shader and fs_main wrapper are generated.
   * @param {string} frag WGSL containing the frag function (plus any helpers)
   * @param {UniformSchema} [uniforms]
   * @param {ResourceSchema} [resources]
   * @param {{format?: string, blend?: string|GPUBlendState}} [opts] target format (default =
   *   canvas format) and optional blending: 'alpha' | 'premultiplied' | 'additive', or a raw
   *   GPUBlendState. Omitted = opaque overwrite, as before.
   * @returns {Promise<RenderPipeline>}
   */
  S.makeRender = (frag, uniforms = {}, resources = {}, { format = S.format, blend = null, targets = null } = {}) => {
    // One target: `frag` returns vec4<f32>, unchanged. Several: `targets` is {name: format}, and
    // the matching `struct FSOut { … }` is generated here — so `frag` returns FSOut and the
    // @location indices, the part that is easy to get wrong by hand, follow the key order.
    const names = targets ? Object.keys(targets) : null;
    const outStruct = names
      ? `struct FSOut {${names.map((n, i) => `@location(${i}) ${n}: vec4<f32>`).join(', ')}};\n`
      : '';
    const code = `struct VSOut {@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
var ndc = array<vec2<f32>,3>(vec2<f32>(-1.,-3.),vec2<f32>(-1.,1.),vec2<f32>(3.,1.))[i];
var o: VSOut; o.pos = vec4<f32>(ndc, 0.0, 1.0); o.uv = ndc * 0.5 + vec2<f32>(0.5); return o;
}
${outStruct}${frag}
@fragment fn fs_main(vs: VSOut) -> ${names ? 'FSOut' : '@location(0) vec4<f32>'} { return frag(vs.uv); }
`.trim();

    return makePipeline({
      code, uniforms, resources, isCompute: false, blend, targetNames: names,
      format: names ? Object.values(targets) : format,
    });
  };

  //======================== One-liner helpers ========================
  /**
   * makeRender + a `run(uniformValues?, view?)` helper that uploads and draws in one call.
   * @returns {Promise<RenderPipeline & {run: (u?: Object, view?: GPUTextureView) => void}>}
   */
  S.drawQuad = async ({ frag, uniforms = {}, resources = {}, clear = [0, 0, 0, 1], format = S.format, blend = null }) => {
    const p = await S.makeRender(frag, uniforms, resources, { format, blend });
    return Object.assign(p, {
      run: (u = {}, view = S._view()) => {
        if (u && Object.keys(u).length) p.uniforms = u;
        p.drawTo(view, clear);
      }
    });
  };
  /**
   * makeCompute with a default `size`, so `run()` with no arguments covers the whole grid.
   * `body` is the entry-point *statements* (it gets `gid`/`lid`/`wid`); put helper functions and
   * structs in `decls`. The body must use `gid` bounds checks for non-multiple sizes.
   * @returns {Promise<ComputePipeline & {run: (w?: number, h?: number, d?: number) => void}>}
   */
  S.compute2D = async ({ body, decls = '', uniforms = {}, resources = {}, size = [1, 1], wg = [8, 8, 1] }) => {
    const p = await S.makeCompute(decls, body, uniforms, resources, { wg });
    const run = p.run;
    return Object.assign(p, { run: (w = size[0], h = size[1], d = 1) => run(w, h, d) });
  };

  //======================== Looking at things ========================
  // One cached blit pipeline per (target format, sample type). Keyed on the promise, like
  // shaderCache, so two concurrent first calls share a compile.
  S._blits = new Map();
  /**
   * Draws a texture onto a target — the "let me just look at it" call, and the shortest path from
   * a compute result to pixels.
   *
   * Uses `textureLoad`, not `textureSample`: unfilterable formats (rgba32float and friends — the
   * ones you most want to inspect) are rejected outright by a sampler. That also means no
   * filtering, so it is a 1:1 texel blit stretched over the target.
   *
   * Orientation: the source's first row lands on the target's first row, so an image comes out
   * the right way up and `show(a, b)` then `readTexture(b)` round-trips. That means an internal
   * `1.0 - uv.y`, because the generated uv has 0 at the *bottom* of the target — writing this blit
   * by hand with `textureSample(t, s, uv)` is exactly the mistake that flips your image. Pass
   * `flipY: true` for a bottom-up source, or to reproduce the naive behaviour.
   * @param {GPUTexture} tex
   * @param {GPUTextureView|GPUTexture} [view] defaults to the canvas
   * @param {{format?: string, scale?: number[], offset?: number[], clear?: number[]|'load', flipY?: boolean}} [opts]
   *   `scale`/`offset` are per-channel and applied as `value * scale + offset`, which is enough to
   *   look at an HDR or signed buffer without writing a shader for it.
   * @returns {Promise<Object>} the blit pipeline, in case you want to keep drawing with it
   */
  S.show = async (tex, view, opts = {}) => {
    const format = opts.format ?? S.format;
    const sample = /uint$/.test(tex.format) ? 'u32' : /sint$/.test(tex.format) ? 'i32' : 'f32';
    const flip = opts.flipY ? 'uv.y' : '1.0 - uv.y';
    const key = `${format}|${sample}|${opts.flipY ? 1 : 0}`;
    let pending = S._blits.get(key);
    if (!pending) {
      pending = S.makeRender(`fn frag(uv: vec2<f32>) -> vec4<f32> {
  let d = vec2<f32>(textureDimensions(src));
  let c = vec2<i32>(clamp(vec2<f32>(uv.x, ${flip}) * d, vec2<f32>(0.0), d - 1.0));
  return vec4<f32>(textureLoad(src, c, 0)) * UB.scale + UB.offset;
}`, { scale: 'vec4<f32>', offset: 'vec4<f32>' }, { src: `texture_2d<${sample}>` }, { format });
      pending.catch(() => S._blits.delete(key));
      S._blits.set(key, pending);
    }
    const p = await pending;
    p.setResources({ src: tex });
    p.setUniforms({ scale: opts.scale ?? [1, 1, 1, 1], offset: opts.offset ?? [0, 0, 0, 0] });
    p.drawTo(view, opts.clear ?? [0, 0, 0, 1]);
    return p;
  };

  /**
   * Downloads a texture as an image file.
   *
   * 8-bit RGBA/BGRA only — an image file has nowhere to put an HDR value, so tone-map first by
   * rendering into an `rgba8unorm` target (`G.show(hdr, target.createView(), { scale })` will do)
   * and saving that. Unlike the WebGL-era version this doesn't tile: WebGPU's
   * `maxTextureDimension2D` (8192–16384) is the only ceiling, so render big and save once.
   *
   * The canvas texture is not saveable by default — a swapchain is RENDER_ATTACHMENT only. Either
   * draw into your own texture, or `init(ctx, { canvasUsage })` with COPY_SRC included.
   * @param {GPUTexture} tex needs COPY_SRC (both texture creators include it)
   * @param {string} [filename]
   * @param {{type?: string, quality?: number, download?: boolean, x?: number, y?: number, width?: number, height?: number, mipLevel?: number}} [opts]
   * @returns {Promise<Blob>}
   */
  S.save = async (tex, filename = 'capture.png', opts = {}) => {
    if (!/^(rgba|bgra)8unorm(-srgb)?$/.test(tex.format))
      throw new Error(`save: needs an 8-bit RGBA texture, got '${tex.format}'. Render it into an rgba8unorm target first.`);
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
  };
  return S
}












