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
      S.frame.encoder = S.device.createCommandEncoder({ label: 'frame' });
      S.frame.view = opts.view ?? (S.context?.getCurrentTexture()?.createView()) ?? null;
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
        S.frame.encoder = S.device.createCommandEncoder({ label: 'compute' });
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
          buf: S.device.createBuffer({ size: cap, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'staging ring' }),
          cpu: new Uint8Array(cap), cursor: 0
        };
      }
      const src = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, size)
        : new Uint8Array(data, 0, size);
      c.cpu.set(src, c.cursor);
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
      ?? S.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'readback staging' }),
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
      if (ctx) ctx.configure({ device: d, format: f, alphaMode: opts.alphaMode ?? 'opaque' });
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
      const module = S.device.createShaderModule({ code, label: `shader ${label ?? ''}` });
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
    makeRenderPipeline: (vsModule, fsModule, format, topology = 'triangle-list', blend = null) => {
      const b = S._resolveBlend(blend);
      return S.device.createRenderPipeline({
        layout: 'auto',                                       // 'auto' means use the default layout for this pipeline, which
        vertex: { module: vsModule, entryPoint: 'vs_main' },     // entryPoint is the function name in the WGSL module
        fragment: { module: fsModule, entryPoint: 'fs_main', targets: [b ? { format, blend: b } : { format }] },  // targets is an array of output formats (usually one)
        primitive: { topology }                                 // primitive topology (triangle-list, triangle-strip, line-list, etc.)
      });
    },
    makeComputePipeline: csModule => S.device.createComputePipeline({ layout: 'auto', compute: { module: csModule, entryPoint: 'main' } }),

    //=============================================================================================================================
    // creates a uniform buffer (small, read-only in shaders)
    createUniformBuffer: byteLength => S.device.createBuffer({ size: byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `uniforms ${byteLength}B` }),
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
    _checkBufferSize: (n, isStorage) => {
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
      return S.frame.encoder
        ? S._stageCopy(b, o, d, d.byteLength)
        : S.device.queue.writeBuffer(b, o, d.buffer ?? d, d.byteOffset ?? 0, d.byteLength);
    },
    createStorageBuffer: sizeOrData => {
      const init = typeof sizeOrData === 'number' ? null : sizeOrData;
      const n = ((init ? init.byteLength : sizeOrData) + 3) & ~3;  // buffer sizes stay 4-byte aligned
      S._checkBufferSize(n, true);
      const b = S.device.createBuffer({
        size: n, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: `storage ${n}B`
      });
      const w = S._writer(b);
      const r = async (nbytes = n, o = 0, C = Uint8Array) => {
        if (S.frame.encoder) console.warn('[TinyWebGPU] readback during an open frame reads pre-frame data — call endFrame() first.');
        const rb = S._acquireStaging(nbytes);
        const enc = S.device.createCommandEncoder({ label: 'readback' });
        enc.copyBufferToBuffer(b, o, rb, 0, nbytes);
        S.device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const ab = rb.getMappedRange(0, nbytes).slice(0); rb.unmap();  // copy: stays valid after unmap
        S._releaseStaging(rb);
        return C ? new C(ab) : ab;                               // C e.g. Uint32Array, Float32Array
      };
      const clear = () => {
        if (S.frame.encoder) return S._outsidePass(() => S.frame.encoder.clearBuffer(b, 0, n));
        const enc = S.device.createCommandEncoder({ label: 'clear' });
        enc.clearBuffer(b, 0, n);
        S.device.queue.submit([enc.finish()]);
      };
      if (init) w(init);
      return { b, w, r, clear };  // b=GPUBuffer, w=write, r=read
    },

    // Generic buffer creator with explicit usage flags; minimal helpers
    createBuffer: (size, usage) => {
      S._checkBufferSize(size, !!(usage & GPUBufferUsage.STORAGE));
      const b = S.device.createBuffer({ size, usage, label: `buffer ${size}B` });
      return { b, w: S._writer(b) };
    },

    // Convenience: 3*u32 dispatch indirect args buffer [x,y,z]
    createDispatchIndirectBuffer: () => {
      const usage = GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      return S.createBuffer(12, usage);
    },

    //=============================================================================================================================
    // Creates a normal 2D texture — good for images, render targets, post-process buffers.
    // Read-only in shaders (except as render pass output). Compact format by default.   
    // COPY_DST is in the default set so writeTexture/loadTexture work without opting in.
    createTexture2D: (width, height, format = 'rgba8unorm', usage) => S.device.createTexture({ size: { width, height }, format, mipLevelCount: 1, sampleCount: 1, usage: usage ?? (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST), label: `texture2D ${width}x${height} ${format}` }),
    //=============================================================================================================================
    // Creates a storage texture — good for compute shaders, ray tracing accumulation,
    // GPGPU processing, or any case you need to read+write pixels directly in a shader.
    // Writable from WGSL via textureStore() / readable via textureLoad().
    createStorageTexture2D: (width, height, format = 'rgba32float') => S.device.createTexture({ size: { width, height }, format, mipLevelCount: 1, sampleCount: 1, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC, label: `storageTexture2D ${width}x${height} ${format}` }),
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
    _view: () => {
      const v = S.frame.view ?? S.context?.getCurrentTexture().createView();
      if (!v) throw new Error('No render target: init() was called without a canvas context — pass an explicit view.');
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
    //=============================================================================================================================
    // Bytes per texel, for the formats these helpers can produce. Derives the default bytesPerRow
    // in writeTexture/readTexture; pass bytesPerRow explicitly for anything exotic.
    _texelBytes: {
      'r8unorm': 1, 'r8uint': 1, 'r8sint': 1,
      'rg8unorm': 2, 'r16float': 2, 'r16uint': 2, 'r16sint': 2,
      'rgba8unorm': 4, 'rgba8unorm-srgb': 4, 'bgra8unorm': 4, 'bgra8unorm-srgb': 4,
      'rgba8uint': 4, 'rgba8sint': 4, 'rg16float': 4, 'r32float': 4, 'r32uint': 4, 'r32sint': 4,
      'rgba16float': 8, 'rg32float': 8, 'rg32uint': 8, 'rg32sint': 8,
      'rgba32float': 16, 'rgba32uint': 16, 'rgba32sint': 16,
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
      const bpt = S._texelBytes[tex.format];
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
      // Every accepted source type reports its size under one of these pairs.
      const w = source.width ?? source.videoWidth ?? source.displayWidth;
      const h = source.height ?? source.videoHeight ?? source.displayHeight;
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
      const bpt = S._texelBytes[tex.format];
      if (!bpt) throw new Error(`readTexture: unknown bytes-per-texel for format '${tex.format}'.`);
      const tight = w * bpt, padded = (tight + 255) & ~255;   // copyTextureToBuffer wants 256-byte rows
      const rb = S._acquireStaging(padded * h);
      const enc = S.device.createCommandEncoder({ label: 'readTexture' });
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
      const C = opts.Ctor ?? (/32float$/.test(f) ? Float32Array : /32uint$/.test(f) ? Uint32Array : /32sint$/.test(f) ? Int32Array : Uint8Array);
      return C === Uint8Array ? out : new C(out.buffer);
    },
    // ------------------------------
    // 6) Bind groups: connect buffers/textures to @group(N)/@binding(M)
    // entries: [{ binding:0, resource:{ buffer } }, { binding:1, resource: textureView }, ...]
    bindGroup: (pipeline, groupIndex, entries) => S.device.createBindGroup({ layout: pipeline.getBindGroupLayout(groupIndex), entries }),


    // ======== Ultra-Simplified Dual Schema Handler ========
    makeUniformsAndResources: (uniforms = {}, resources = {}, opts = {}) => {
      const g = opts.g ?? 0, n = opts.n ?? 'Uniforms', v = opts.v ?? 'UB';
      let binding = opts.startBinding ?? 0;

      // [size, align] in 4-byte units per WGSL type. vec3 has align 16 but size 12:
      // a following scalar packs into its tail, matching WGSL uniform layout rules.
      const _ti = {
        'f32': [1, 1], 'i32': [1, 1], 'u32': [1, 1],
        'vec2<f32>': [2, 2], 'vec3<f32>': [3, 4], 'vec4<f32>': [4, 4],
        'vec2<u32>': [2, 2], 'vec3<u32>': [3, 4], 'vec4<u32>': [4, 4],
        'vec2<i32>': [2, 2], 'vec3<i32>': [3, 4], 'vec4<i32>': [4, 4],
        'mat4x4<f32>': [16, 4]
      };
      const _info = t => {
        const i = _ti[t];
        if (!i) throw new Error(`Unknown uniform type size for: ${t}`);
        return i;
      };
      const alignTo = (n, a) => Math.ceil(n / a) * a;

      // Build uniform buffer
      let uniformBuffer = null, uniformWrite = () => { }, uniformWGSL = '';

      const uniformEntries = Object.entries(uniforms);
      if (uniformEntries.length > 0) {
        let offset = 0;
        const layout = {};

        const structFields = uniformEntries.map(([name, wgslType]) => {
          const [size, al] = _info(wgslType);
          offset = alignTo(offset, al);
          layout[name] = { offset, size, wgslType };
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

        const _intType = t => ({
          isU: t === 'u32' || /vec\d*<u32>/.test(t),
          isI: t === 'i32' || /vec\d*<i32>/.test(t)
        });
        uniformWrite = values => {
          for (const [name, value] of Object.entries(values)) {
            const field = layout[name];
            if (!field) continue;
            const array = Array.isArray(value) ? value : [value];
            if (S.debug && array.length > field.size) {
              console.warn(`Uniform '${name}' provided ${array.length} values but type ${field.wgslType} fits ${field.size}. Extra values will be ignored.`);
            }
            const it = _intType(field.wgslType);
            const view = it.isU ? U32 : it.isI ? I32 : F32;
            for (let i = 0; i < field.size && i < array.length; i++) {
              let v = array[i] ?? 0;
              if (S.debug && (it.isI || it.isU) && !Number.isInteger(v)) {
                console.warn(`Uniform '${name}' expects integer for ${field.wgslType} at index ${i}, got ${v}. It will be truncated.`);
              }
              if (it.isU) v = v >>> 0; // ensure unsigned
              else if (it.isI) v = v | 0; // ensure signed 32-bit
              view[field.offset + i] = v;
            }
          }
          // Inside an open frame, stage so each dispatch sees the values set before it;
          // otherwise a plain queue write (ordered against the next submit) is enough.
          if (S.frame.encoder) S._stageCopy(uniformBuffer, 0, buffer, buffer.byteLength);
          else S.writeUniforms(uniformBuffer, buffer);
        };

 

        uniformWGSL = `struct ${n} {
${structFields.join('\n')}
}\n@group(${g}) @binding(${binding}) var<uniform> ${v}: ${n};`;

        
        binding++;
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
  uniformBinding: uniformEntries.length > 0 ? (opts.startBinding ?? 0) : null
      };
    }
  };



  //=============================================================================================================================
  // Simplified Dual-Schema Pipeline Factory
  // uniforms: object with WGSL basic types (f32, vec2<f32>, etc.)
  // resources: object with full WGSL resource types (texture_storage_2d<...>, array<...>, etc.)

  const makePipeline = async ({ code, uniforms = {}, resources = {}, format = S.format, isCompute = false, blend = null }) => {
    // Process dual schema
    const schemaResult = S.makeUniformsAndResources(uniforms, resources, { g: 0, startBinding: 0 });

    // Prepend schema-generated WGSL to shader code, then run the G.pre hook once, here — the
    // pipeline cache keys on the result, so switching G.pre can't hand back a stale pipeline.
    const preCode = schemaResult.wgsl ? `${schemaResult.wgsl}\n${code}` : code;
    const finalCode = S.pre ? S.pre(preCode) : preCode;

    // Pipelines use layout:'auto', which strips bindings the shader never references.
    // A bind-group entry for a stripped binding is a validation error, so detect schema
    // resources the user code never mentions and drop their entries (with a warning).
    const strippedBindings = new Set();
    {
      const refd = name => new RegExp(`\\b${name}\\b`).test(code);
      const unused = schemaResult.resourceFields.filter(name => !refd(name));
      if (schemaResult.uniformVar && !refd(schemaResult.uniformVar)) {
        strippedBindings.add(schemaResult.uniformBinding);
        unused.unshift(`${schemaResult.uniformVar} (uniforms)`);
      }
      for (const name of unused) {
        const info = schemaResult.resourceLayout[name];
        if (info) strippedBindings.add(info.binding);
      }
      if (unused.length) console.warn(
        `[TinyWebGPU] Schema declares ${unused.map(n => `'${n}'`).join(', ')} but the shader never references ${unused.length > 1 ? 'them' : 'it'}; ` +
        `auto layout removes unused bindings, so ${unused.length > 1 ? 'their' : 'its'} bind group entries are skipped.`);
    }

    // Pipeline cache (hash + length: see makeShader collision note).
    // Blend is part of the render key: identical WGSL with a different blend state is a
    // different pipeline, and omitting it here would hand back the wrong one.
    const blendKey = isCompute || !blend ? '' : (typeof blend === 'string' ? blend : JSON.stringify(blend)) + '|';
    const cacheKey = (isCompute ? `C|` : `R|${format}|${blendKey}`) + S._hash(finalCode) + ':' + finalCode.length;
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
    let lastResourcesObj = null;
    const validateResources = (resourceValues) => {
      const expected = schemaResult.resourceFields;
      const missing = [];
      const mismatched = [];
      const vals = resourceValues || {};
      for (const name of expected) {
        const info = schemaResult.resourceLayout?.[name];
        // Auto layout already dropped this binding (warned about above) and its entry is filtered
        // out — demanding a value for it would be asking for something we then throw away.
        if (strippedBindings.has(info?.binding)) continue;
        if (!(name in vals) || vals[name] == null) { missing.push(name); continue; }
        const v = vals[name];
        const expectedType = info?.wgslType ?? resources[name];
        // Heuristic checks to catch obvious mismatches while avoiding false positives
        if (info?.isBuf) {
          const isGPUBuffer = (v && (typeof v.mapAsync === 'function' || typeof v.getMappedRange === 'function')) || (v && v.buffer && (typeof v.buffer.mapAsync === 'function'));
          if (!isGPUBuffer) mismatched.push({ name, expected: expectedType, got: typeof v });
        } else if (info?.isTex) {
          const looksLikeTextureOrView = v && (typeof v.createView === 'function' || 'dimension' in v || 'mipLevelCount' in v);
          if (!looksLikeTextureOrView) mismatched.push({ name, expected: expectedType, got: typeof v });
        } else if (expectedType === 'sampler') {
          // Best-effort: sampler is opaque; skip strict check
        }
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
    const rebindResources = (resourceValues) => {
      if (bindGroup && resourceValues === lastResourcesObj) return; // skip unchanged ref
      lastResourcesObj = resourceValues;
      const baseEntries = schemaResult.uniformBuffer ? [{ binding: 0, resource: { buffer: schemaResult.uniformBuffer } }] : [];
      if (schemaResult.resourceFields.length > 0) validateResources(resourceValues || {});
      const resourceEntries = schemaResult.createResourceEntries(resourceValues || {});
      const entries = [...baseEntries, ...resourceEntries].filter(e => !strippedBindings.has(e.binding));
      S.device.pushErrorScope('validation');
      bindGroup = S.bindGroup(pipeline, 0, entries);
      S.device.popErrorScope().then(err => {
        if (err) console.error(
          `[TinyWebGPU] createBindGroup failed. If a schema resource is declared but only mentioned in comments/strings, ` +
          `auto layout still removed its binding — remove it from the schema or use it in the shader.\n${err.message}`);
      }).catch(() => { });   // scope pop rejects if the device is lost meanwhile
    };

    // Auto-init bind group ONLY when there are no extra resources in schema.
    // If resources exist, wait for user to provide them to avoid bind layout mismatches.
    if (schemaResult.uniformBuffer && schemaResult.resourceFields.length === 0) {
      rebindResources({});
    }

    // Applies this pipeline's state to a compute pass. Also stashed on the frame by use(), so a
    // pass torn down and reopened around a staged write comes back with the same state.
    const bind = pass => {
      pass.setPipeline(pipeline);
      if (bindGroup) pass.setBindGroup(0, bindGroup);
    };

    // Helper to execute compute/render pass
    const runPass = (args, encoder = null) => {
      const enc = encoder ?? S.frame.encoder ?? S.device.createCommandEncoder();
      // A chained compute pass (beginCompute) may still be open on the frame encoder;
      // close it before opening another pass — two open passes is a validation error.
      // _endPass, not endCompute: `enc` is that same encoder and must stay open to record into.
      if (enc === S.frame.encoder && S.frame.cpass) S._endPass();
      const pass = isCompute ? enc.beginComputePass() : enc.beginRenderPass(args.renderPassDesc);
      bind(pass);
      if (isCompute) pass.dispatchWorkgroups(...args.dispatch);
      else pass.draw(3, 1, 0, 0);
      pass.end();
      if (!encoder && !S.frame.encoder) S.device.queue.submit([enc.finish()]);
    };

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
      dispatch: (x = 1, y = 1, z = 1, encoder = null) => runPass({ dispatch: [x, y, z] }, encoder),
      dispatchIndirect: (buffer, byteOffset = 0, encoder = null) => {
        const enc = encoder ?? S.frame.encoder ?? S.device.createCommandEncoder();
        if (enc === S.frame.encoder && S.frame.cpass) S._endPass();
        const pass = enc.beginComputePass();
        bind(pass);
        pass.dispatchWorkgroupsIndirect(buffer, byteOffset);
        pass.end();
        if (!encoder && !S.frame.encoder) S.device.queue.submit([enc.finish()]);
      },
      // New: reuse an existing compute pass for chaining
      use: (pass = S.frame.cpass) => {
        if (!pass) throw new Error('No active compute pass. Call WG.beginCompute() first or pass a compute pass.');
        bind(pass);
        // Remember it: a staged write mid-chain has to close and reopen the pass, and the
        // reopened one starts with no pipeline bound.
        if (pass === S.frame.cpass) S.frame.bound = bind;
      },
      dispatchOn: (pass, x = 1, y = 1, z = 1) => {
        const p = pass ?? S.frame.cpass; if (!p) throw new Error('No active compute pass');
        p.dispatchWorkgroups(x, y, z);
      },
      dispatchIndirectOn: (pass, buffer, byteOffset = 0) => {
        const p = pass ?? S.frame.cpass; if (!p) throw new Error('No active compute pass');
        p.dispatchWorkgroupsIndirect(buffer, byteOffset);
      }
    }) : Object.assign(common, {
      drawTo: (view = S._view(), clear = [0, 0, 0, 1], encoder = null) => {
        const loadOp = clear === 'load' ? 'load' : 'clear';
        const cv = Array.isArray(clear) ? { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } : { r: 0, g: 0, b: 0, a: 1 };
        return runPass({
          renderPassDesc: {
            colorAttachments: [{ view, loadOp, storeOp: 'store', clearValue: cv }]
          }
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

    return makePipeline({ code, uniforms, resources, isCompute: true });
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
  S.makeRender = (frag, uniforms = {}, resources = {}, { format = S.format, blend = null } = {}) => {
    // Generate vertex + fragment shader code
    const code = `struct VSOut {@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
var ndc = array<vec2<f32>,3>(vec2<f32>(-1.,-3.),vec2<f32>(-1.,1.),vec2<f32>(3.,1.))[i];
var o: VSOut; o.pos = vec4<f32>(ndc, 0.0, 1.0); o.uv = ndc * 0.5 + vec2<f32>(0.5); return o;
}
${frag}
@fragment fn fs_main(vs: VSOut) -> @location(0) vec4<f32> { return frag(vs.uv); }
`.trim();

    return makePipeline({ code, uniforms, resources, format, isCompute: false, blend });
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
   * makeCompute + a `run(w?, h?, d?)` helper that dispatches ceil(w/wg[0]) × ceil(h/wg[1])
   * × ceil(d/wg[2]) workgroups. The body must use `gid` bounds checks for non-multiple sizes.
   * @returns {Promise<ComputePipeline & {run: (w?: number, h?: number, d?: number) => void}>}
   */
  S.compute2D = async ({ body, uniforms = {}, resources = {}, size = [1, 1], wg = [8, 8, 1] }) => {
    const p = await S.makeCompute(body, '', uniforms, resources, { wg });
    return Object.assign(p, {
      run: (w = size[0], h = size[1], d = 1) => p.dispatch(Math.ceil(w / wg[0]), Math.ceil(h / wg[1]), Math.ceil(d / (wg[2] ?? 1)))
    });
  };
  return S
}












