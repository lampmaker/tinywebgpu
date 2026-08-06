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

/**
 * Creates an independent toolkit instance. Call `await G.init(ctx?)` before anything else.
 * Also settable on the instance: `G.debug`, `G.pre`, `G.onDeviceLost` (see their comments).
 */
export let WEBGPU = (U) => {
  let S = {
    device: null, context: null, format: null,
    // performance + diagnostics
    debug: false,
    shaderCache: new Map(),
    pipelineCache: new Map(),
    frame: { encoder: null, view: null, cpass: null },
    // Frame API: batch multiple passes into one submission
    beginFrame: (opts = {}) => {
      // If a frame is already open, end it to avoid dangling encoders
      if (S.frame.encoder) {
        S.endCompute(); // an open compute pass would make finish() throw
        S._flushRing();
        try {
          S.device.queue.submit([S.frame.encoder.finish()]);
        } catch (e) {
          console.error('[TinyWebGPU] beginFrame: previous frame encoder could not be submitted — that frame was dropped.', e);
        }
      }
      const enc = S.device.createCommandEncoder({ label: 'frame' });
      const view = opts.view ?? (S.context?.getCurrentTexture()?.createView());
      S.frame.encoder = enc;
      S.frame.view = view ?? null;
      S.frame.cpass = null;
      return S.frame;
    },
    endFrame: () => {
      if (!S.frame.encoder) return;
      // Ensure any open compute pass is closed
      try { S.frame.cpass?.end(); } catch {}
      S.frame.cpass = null;
      S._flushRing();
      S.device.queue.submit([S.frame.encoder.finish()]);
      S.frame.encoder = null;
      S.frame.view = null;
    },
    // Keep a single compute pass open to chain dispatches
    beginCompute: (opts = {}) => {
      const enc = S.frame.encoder ?? S.device.createCommandEncoder();
      if (!S.frame.encoder) { S.frame.encoder = enc; }
      if (S.frame.cpass) return S.frame.cpass;
      const pass = enc.beginComputePass(opts);
      S.frame.cpass = pass;
      return pass;
    },
    endCompute: () => {
      if (!S.frame.cpass) return;
      try { S.frame.cpass.end(); } catch {}
      S.frame.cpass = null;
    },
    // Called when the GPU device is lost (context crash, driver reset, tab backgrounding).
    // Receives the GPUDeviceLostInfo. The library logs regardless; set this to recover/rebuild.
    onDeviceLost: null,
    //=============================================================================================================================
    // Staging ring: while a frame is open, uniform/buffer writes are staged CPU-side and
    // copyBufferToBuffer'd inside the frame encoder, so writes order against *dispatches*
    // (per-dispatch uniforms in one submit) instead of against whole submits. DESIGN.md §4.
    _ring: { chunks: [], i: 0, chunkSize: 1 << 18 },
    _stageCopy: (dst, dstOff, data, size) => {
      const r = S._ring;
      S.endCompute();                     // copies must be encoded outside any pass
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
      S.frame.encoder.copyBufferToBuffer(c.buf, c.cursor, dst, dstOff, need);
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
     * @returns {Promise<Object>} this instance, with device/context/format populated
     */
    init: async (ctx = null) => {
      if (!navigator.gpu) throw Error('WebGPU not supported');
      const a = await navigator.gpu.requestAdapter();
      if (!a) throw Error('No GPU adapter');

      // Request higher limits up to adapter capabilities (not exceeding)
      const requiredLimits = {
        maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize,
        maxBufferSize: a.limits.maxBufferSize,
      };

      const d = await a.requestDevice({ requiredLimits });
      d.lost.then(info => {
        console.error(`[TinyWebGPU] GPU device lost (${info.reason || 'unknown'}): ${info.message}`);
        S.onDeviceLost?.(info);
      });
      d.onuncapturederror = e => console.error('[TinyWebGPU] Uncaptured WebGPU error:', e.error?.message ?? e);
      const f = navigator.gpu.getPreferredCanvasFormat();
      if (ctx) ctx.configure({ device: d, format: f, alphaMode: 'opaque' });
      Object.assign(S, { device: d, context: ctx, format: f })
      return S;
    },
    //=============================================================================================================================
    /**
     * Compiles a WGSL shader module (cached; applies `G.pre`). Compile errors throw with a
     * pretty source-window log; warnings are logged.
     * @param {string} code @returns {Promise<GPUShaderModule>}
     */
    makeShader: code => {
      if (S.pre) code = S.pre(code);
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
        const hasError = msgs.some(m => m.type === 'error');
        if (hasError) {
          console.error(log);
          throw new Error('WGSL compilation failed. See log above.');
        }
        console.warn(log);
      }
      return module;
    },

    //=============================================================================================================================
    // Pipelines: render and compute
    makeRenderPipeline: (vsModule, fsModule, format, topology = 'triangle-list') => {
      return S.device.createRenderPipeline({
        layout: 'auto',                                       // 'auto' means use the default layout for this pipeline, which
        vertex: { module: vsModule, entryPoint: 'vs_main' },     // entryPoint is the function name in the WGSL module
        fragment: { module: fsModule, entryPoint: 'fs_main', targets: [{ format }] },  // targets is an array of output formats (usually one)
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
    createStorageBuffer: sizeOrData => {
      const init = typeof sizeOrData === 'number' ? null : sizeOrData;
      const n = init ? (init.byteLength + 3) & ~3 : sizeOrData;   // buffer sizes stay 4-byte aligned
      // Safety warnings for oversized buffers
      try {
        if (S.device && n > S.device.limits.maxBufferSize) {
          console.warn(`[TinyWebGPU] Requested buffer size (${n}) exceeds device.maxBufferSize (${S.device.limits.maxBufferSize}).`);
        }
        if (S.device && n > S.device.limits.maxStorageBufferBindingSize) {
          console.warn(`[TinyWebGPU] Requested storage buffer size (${n}) exceeds device.maxStorageBufferBindingSize (${S.device.limits.maxStorageBufferBindingSize}).`);
        }
      } catch {}
      const b = S.device.createBuffer({
        size: n, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: `storage ${n}B`
      });
      const w = (d, o = 0) => S.frame.encoder
        ? S._stageCopy(b, o, d, d.byteLength ?? d.length ?? n)   // frame open: order against dispatches
        : S.device.queue.writeBuffer(b, o, d.buffer ?? d, d.byteOffset ?? 0, d.byteLength ?? d.length ?? n);
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
        if (S.frame.encoder) { S.endCompute(); S.frame.encoder.clearBuffer(b, 0, n); return; }
        const enc = S.device.createCommandEncoder({ label: 'clear' });
        enc.clearBuffer(b, 0, n);
        S.device.queue.submit([enc.finish()]);
      };
      if (init) w(init);
      return { b, w, r,clear };  // b=GPUBuffer, w=write, r=read
    },

    // Generic buffer creator with explicit usage flags; minimal helpers
    createBuffer: (size, usage) => {
      // Safety warnings for oversized buffers
      try {
        if (S.device && size > S.device.limits.maxBufferSize) {
          console.warn(`[TinyWebGPU] Requested buffer size (${size}) exceeds device.maxBufferSize (${S.device.limits.maxBufferSize}).`);
        }
        // If storage usage, also compare against storage binding limit
        if (S.device && (usage & GPUBufferUsage.STORAGE) && size > S.device.limits.maxStorageBufferBindingSize) {
          console.warn(`[TinyWebGPU] Requested storage buffer size (${size}) exceeds device.maxStorageBufferBindingSize (${S.device.limits.maxStorageBufferBindingSize}).`);
        }
      } catch {}
      const b = S.device.createBuffer({ size, usage, label: `buffer ${size}B` });
      const w = (d, o = 0) => S.frame.encoder
        ? S._stageCopy(b, o, d, d.byteLength ?? d.length ?? size)
        : S.device.queue.writeBuffer(b, o, d.buffer ?? d, d.byteOffset ?? 0, d.byteLength ?? d.length ?? size);
      return { b, w };
    },

    // Convenience: 3*u32 dispatch indirect args buffer [x,y,z]
    createDispatchIndirectBuffer: () => {
      const usage = GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      return S.createBuffer(12, usage);
    },

    //=============================================================================================================================
    // Creates a normal 2D texture — good for images, render targets, post-process buffers.
    // Read-only in shaders (except as render pass output). Compact format by default.   
    createTexture2D: (width, height, format = 'rgba8unorm', usage) => S.device.createTexture({ size: { width, height }, format, mipLevelCount: 1, sampleCount: 1, usage: usage ?? (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC), label: `texture2D ${width}x${height} ${format}` }),
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
            resource = resource.createView();
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

  const makePipeline = async ({ code, uniforms = {}, resources = {}, format = S.format, isCompute = false, wg = [8, 8, 1] }) => {
    // Process dual schema
    const schemaResult = S.makeUniformsAndResources(uniforms, resources, { group: 0, startBinding: 0 });

    // Prepend schema-generated WGSL to shader code
    const finalCode = schemaResult.wgsl ? `${schemaResult.wgsl}\n${code}` : code;

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

    // Pipeline cache (hash + length: see makeShader collision note)
  const cacheKey = (isCompute ? `C|` : `R|${format}|`) + S._hash(finalCode) + ':' + finalCode.length;
    let pipeline = S.pipelineCache.get(cacheKey);
    if (!pipeline) {
      const module = await S.makeShader(finalCode);
      S.device.pushErrorScope('validation');
      pipeline = isCompute ? S.makeComputePipeline(module) : S.makeRenderPipeline(module, module, format);
      S.device.popErrorScope().then(err => {
        if (err) console.error(`[TinyWebGPU] Pipeline creation failed (${cacheKey}):\n${err.message}`);
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
        if (!(name in vals) || vals[name] == null) { missing.push(name); continue; }
        const v = vals[name];
        const info = schemaResult.resourceLayout?.[name];
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

    // Helper to execute compute/render pass
  const runPass = (args, encoder = null) => {
      const enc = encoder ?? S.frame.encoder ?? S.device.createCommandEncoder();
      // A chained compute pass (beginCompute) may still be open on the frame encoder;
      // close it before opening another pass — two open passes is a validation error.
      if (enc === S.frame.encoder && S.frame.cpass) S.endCompute();
      const pass = isCompute ? enc.beginComputePass() : enc.beginRenderPass(args.renderPassDesc);
      pass.setPipeline(pipeline);
      if (bindGroup) pass.setBindGroup(0, bindGroup);
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
        if (enc === S.frame.encoder && S.frame.cpass) S.endCompute();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        if (bindGroup) pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroupsIndirect(buffer, byteOffset);
        pass.end();
        if (!encoder && !S.frame.encoder) S.device.queue.submit([enc.finish()]);
      },
      // New: reuse an existing compute pass for chaining
      use: (pass = S.frame.cpass) => {
        if (!pass) throw new Error('No active compute pass. Call WG.beginCompute() first or pass a compute pass.');
        pass.setPipeline(pipeline);
        if (bindGroup) pass.setBindGroup(0, bindGroup);
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
      drawTo: (view = (S.frame.view ?? S.context.getCurrentTexture().createView()), clear = [0, 0, 0, 1], encoder = null) => {
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
    const code = `      
      ${body}
      @compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
      fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
        ${main}
      }
    `;

    return makePipeline({ code, uniforms, resources, isCompute: true, wg });
  };

  /**
   * Builds a fullscreen-triangle render pipeline. You provide
   * `fn frag(uv: vec2<f32>) -> vec4<f32>`; vertex shader and fs_main wrapper are generated.
   * @param {string} frag WGSL containing the frag function (plus any helpers)
   * @param {UniformSchema} [uniforms]
   * @param {ResourceSchema} [resources]
   * @param {{format?: string}} [opts] target format, default = canvas format
   * @returns {Promise<RenderPipeline>}
   */
  S.makeRender = (frag, uniforms = {}, resources = {}, { format = S.format } = {}) => {
    // Generate vertex + fragment shader code
    const code = `
      struct VSOut {@builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>};
      @vertex fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
        var ndc = array<vec2<f32>,3>(vec2<f32>(-1.,-3.),vec2<f32>(-1.,1.),vec2<f32>(3.,1.))[i];
        var o: VSOut; o.pos = vec4<f32>(ndc, 0.0, 1.0); o.uv = ndc * 0.5 + vec2<f32>(0.5); return o;
      }
      ${frag}
      @fragment fn fs_main(vs: VSOut) -> @location(0) vec4<f32> { return frag(vs.uv); }
    `.trim();

    return makePipeline({ code, uniforms, resources, format, isCompute: false });
  };

  //======================== One-liner helpers ========================
  /**
   * makeRender + a `run(uniformValues?, view?)` helper that uploads and draws in one call.
   * @returns {Promise<RenderPipeline & {run: (u?: Object, view?: GPUTextureView) => void}>}
   */
  S.drawQuad = async ({ frag, uniforms = {}, resources = {}, clear = [0, 0, 0, 1], format = S.format }) => {
    const p = await S.makeRender(frag, uniforms, resources, { format });
    return Object.assign(p, {
      run: (u = {}, view = (S.frame.view ?? S.context.getCurrentTexture().createView())) => {
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












