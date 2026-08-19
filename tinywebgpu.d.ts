// Type declarations for tinywebgpu — editor support only, zero runtime.
// The GPU* names come from TypeScript's own lib.dom (recent versions ship WebGPU). On an older
// TS, add `npm i -D @webgpu/types` and put "@webgpu/types" in tsconfig `types` yourself.

/** name → WGSL basic type: 'f32' | 'i32' | 'u32' | 'vec2/3/4<f32|u32|i32>' | 'matCxR<f32>'. */
export interface UniformSchema { [name: string]: string }
/**
 * name → full WGSL resource type: 'array<T>', 'struct Foo {...}', 'texture_2d<f32>',
 * 'texture_storage_2d<...>', 'sampler', or a bare primitive (auto-wrapped in a struct).
 */
export interface ResourceSchema { [name: string]: string }

export type BlendPreset = 'alpha' | 'premultiplied' | 'additive';
export type Blend = BlendPreset | GPUBlendState;
/** A clear colour, or 'load' to keep the target's contents. */
export type Clear = number[] | 'load';
/** What setResources accepts per name: a buffer handle, raw buffer, texture or view, or sampler. */
export type Resource = BufferHandle | GPUBuffer | GPUTexture | GPUTextureView | GPUSampler;

export interface TypedArrayCtor<T = any> { new(buffer: ArrayBuffer): T }

/**
 * Depth testing config for makeDraw/makeFrag: `true` = depth24plus, 'less', writes on, an
 * auto-managed depth texture sized to the target (pooled, shared across pipelines per target).
 */
export type Depth = boolean | {
  format?: GPUTextureFormat;
  compare?: GPUCompareFunction;
  write?: boolean;
  /** Your own depth attachment — you manage its size. */
  texture?: GPUTexture;
};

export interface BufferHandle {
  /** The raw buffer (alias: `buffer`). */
  b: GPUBuffer;
  buffer: GPUBuffer;
  /** Write; frame-ordered inside beginFrame(). `byteOffset` must be a multiple of 4. */
  w(data: BufferSource, byteOffset?: number): void;
  write(data: BufferSource, byteOffset?: number): void;
}

export interface StorageBufferHandle extends BufferHandle {
  /** Readback (debug tool — it stalls the pipeline). `r(Float32Array)` reads the whole buffer typed. */
  r(nbytes?: number, byteOffset?: number, Ctor?: TypedArrayCtor | null): Promise<any>;
  r<T>(Ctor: TypedArrayCtor<T>): Promise<T>;
  read: StorageBufferHandle['r'];
  /** Zero the buffer; frame-ordered inside beginFrame(). */
  clear(): void;
}

export interface PingPong<T> {
  read: T;
  write: T;
  swap(): void;
}

export interface Pipeline {
  pipeline: GPURenderPipeline | GPUComputePipeline;
  /** Merge values into the CPU struct and upload. Unknown names throw. */
  uniforms: Record<string, number | number[] | ArrayBufferView>;
  setUniforms(values: Record<string, number | number[] | ArrayBufferView>): void;
  setUniform(name: string, value: number | number[] | ArrayBufferView): void;
  /** (Re)build the bind group. Merged with what is bound; compared by value; cached per combination. */
  resources: Record<string, Resource>;
  setResources(values: Record<string, Resource>): void;
  readonly uniformFields: string[];
  readonly resourceFields: string[];
}

export interface ComputePipeline extends Pipeline {
  /** Dispatch workgroups. Joins an open beginCompute() chain; otherwise self-submits. */
  dispatch(x?: number, y?: number, z?: number, encoder?: GPUCommandEncoder | null): void;
  /** Dispatch by item count: divides by the workgroup size and rounds up. */
  run(w?: number, h?: number, d?: number, encoder?: GPUCommandEncoder | null): void;
  dispatchIndirect(buffer: GPUBuffer | BufferHandle, byteOffset?: number, encoder?: GPUCommandEncoder | null): void;
  /** Bind to a compute pass you opened yourself. Not needed for beginCompute() chains. */
  bindTo(pass?: GPUComputePassEncoder): void;
}

export interface RenderPipeline extends Pipeline {
  /**
   * Draw `count` × `instances`. Single target: a view or texture, default the canvas.
   * With `targets`: an object keyed by the targets schema, `drawTo({ name: viewOrTexture })`.
   */
  drawTo(view?: GPUTextureView | GPUTexture | Record<string, GPUTextureView | GPUTexture> | null,
    clear?: Clear, encoder?: GPUCommandEncoder | null): void;
  /** Vertices per instance — writable, no pipeline rebuild. */
  count: number;
  /** Instance count — writable, no pipeline rebuild. */
  instances: number;
}

export interface QuadPipeline extends RenderPipeline {
  /** Upload `uniforms` (if any) and draw in one call. */
  run(uniforms?: Record<string, number | number[] | ArrayBufferView>, view?: GPUTextureView | GPUTexture): void;
}

export interface InitOptions {
  /** Best-effort: unsupported features are dropped with a warning — check `G.features`. */
  features?: string[];
  limits?: Record<string, number>;
  /** Canvas alpha mode, default 'opaque'. */
  alphaMode?: GPUCanvasAlphaMode;
  /** Swapchain usage, default RENDER_ATTACHMENT. Add COPY_SRC to save/read the canvas itself. */
  canvasUsage?: number;
}

export interface MakeDrawOptions {
  /** Complete WGSL: `@vertex fn vs_main` and `@fragment fn fs_main`. Only the schema is prepended. */
  code: string;
  uniforms?: UniformSchema;
  resources?: ResourceSchema;
  /** Resources bound `var<storage, read>` — required for anything the vertex stage reads. */
  readOnly?: string[];
  count?: number;
  instances?: number;
  topology?: GPUPrimitiveTopology;
  format?: GPUTextureFormat | GPUTextureFormat[];
  blend?: Blend | null;
  /** Multiple render targets: { name: format }, drawn with `drawTo({ name: view })`. */
  targets?: Record<string, GPUTextureFormat> | null;
  depth?: Depth | null;
}

export interface MakeFragOptions {
  format?: GPUTextureFormat | GPUTextureFormat[];
  blend?: Blend | null;
  targets?: Record<string, GPUTextureFormat> | null;
  depth?: Depth | null;
}

export interface TinyWebGPU {
  // ─── Device & lifecycle ───────────────────────────────────────────────────────────────────
  device: GPUDevice;
  context: GPUCanvasContext | null;
  format: GPUTextureFormat;
  features: GPUSupportedFeatures | null;
  /** Extra per-uniform warnings (DIAG builds only). */
  debug: boolean;
  /** Optional WGSL preprocessing hook, applied before hashing/compiling. Must be deterministic. */
  pre: ((src: string) => string) | null;
  /** Called on device loss (not on G.destroy()). Set this to rebuild. */
  onDeviceLost: ((info: GPUDeviceLostInfo) => void) | null;

  /** Initialize WebGPU. Pass a 'webgpu' context, a canvas, a CSS selector — or nothing for compute-only. */
  init(ctx?: GPUCanvasContext | HTMLCanvasElement | OffscreenCanvas | string | null, opts?: InitOptions): Promise<TinyWebGPU>;
  /** Destroy the device, pooled resources and caches. The instance is not reusable afterwards. */
  destroy(): void;

  // ─── Pipelines ────────────────────────────────────────────────────────────────────────────
  /** Fullscreen pipeline from `fn frag(uv: vec2<f32>) -> vec4<f32>`; the vertex stage is generated. */
  makeFrag(frag: string, uniforms?: UniformSchema, resources?: ResourceSchema, opts?: MakeFragOptions): Promise<RenderPipeline>;
  /** Render pipeline with your own vertex stage. No vertex buffers — pull from storage buffers. */
  makeDraw(opts: MakeDrawOptions): Promise<RenderPipeline>;
  /** Compute pipeline: `body` = declarations, `main` = entry-point statements (gid/lid/wid in scope). */
  makeCompute(body: string, main: string, uniforms?: UniformSchema, resources?: ResourceSchema,
    opts?: { wg?: number[] }): Promise<ComputePipeline>;
  /** makeFrag plus `run(uniforms?, view?)`. All makeFrag options pass through. */
  makeQuad(opts: { frag: string; uniforms?: UniformSchema; resources?: ResourceSchema; clear?: Clear } & MakeFragOptions): Promise<QuadPipeline>;
  /** makeCompute with a default grid size, so `run()` with no arguments covers it. */
  makeCompute2D(opts: { body: string; decls?: string; uniforms?: UniformSchema; resources?: ResourceSchema;
    size?: number[]; wg?: number[] }): Promise<ComputePipeline>;

  // ─── Frame API ────────────────────────────────────────────────────────────────────────────
  /** One encoder + one swapchain view for the whole frame; endFrame() is the single submit. */
  beginFrame(opts?: { view?: GPUTextureView }): void;
  endFrame(): void;
  /** beginFrame/endFrame around `fn`, exception-safe. Returns fn's result. */
  frame<T>(fn: () => T, opts?: { view?: GPUTextureView }): T;
  /** Open a chained compute pass: dispatches join it and rebind only on pipeline change. */
  beginCompute(opts?: GPUComputePassDescriptor): GPUComputePassEncoder;
  endCompute(): void;

  // ─── Buffers ──────────────────────────────────────────────────────────────────────────────
  /** STORAGE|COPY_SRC|COPY_DST. Pass a byte length, or data to size-and-fill in one call. */
  createStorageBuffer(sizeOrData: number | ArrayBuffer | ArrayBufferView): StorageBufferHandle;
  /** Explicit usage flags; size rounded up to 4 bytes. */
  createBuffer(size: number, usage: number): BufferHandle;
  createUniformBuffer(byteLength: number): GPUBuffer;
  /** 12 bytes of [x,y,z] workgroup counts for dispatchIndirect. */
  createIndirectBuffer(): BufferHandle;
  writeUniforms(buffer: GPUBuffer, data: ArrayBufferView, byteOffset?: number): void;

  // ─── Textures & samplers ──────────────────────────────────────────────────────────────────
  /**
   * Render target / sampled texture. 4th argument: usage flags, or `{ usage, mips }` —
   * `mips: true` allocates the full mip chain (fill it with generateMipmaps).
   */
  createTexture(width: number, height: number, format?: GPUTextureFormat,
    usageOrOpts?: number | { usage?: number; mips?: boolean | number }): GPUTexture;
  /** textureStore/textureLoad texture for compute output and GPGPU. */
  createStorageTexture(width: number, height: number, format?: GPUTextureFormat, usage?: number): GPUTexture;
  /** Defaults nearest/clamp. wrapU/V/W map to addressModeU/V/W; everything else passes through. */
  createSampler(opts?: { magFilter?: GPUFilterMode; minFilter?: GPUFilterMode;
    wrapU?: GPUAddressMode; wrapV?: GPUAddressMode; wrapW?: GPUAddressMode } & Partial<GPUSamplerDescriptor>): GPUSampler;
  /** Raw pixel bytes in. Rows tightly packed unless bytesPerRow says otherwise. */
  writeTexture(tex: GPUTexture, data: BufferSource, opts?: { width?: number; height?: number;
    x?: number; y?: number; bytesPerRow?: number; mipLevel?: number }): GPUTexture;
  /** Image/URL/Blob/canvas/video into a texture. `mips: true` also builds the mip chain. */
  loadTexture(src: string | Blob | ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement,
    opts?: { texture?: GPUTexture; format?: GPUTextureFormat; usage?: number; flipY?: boolean;
      premultipliedAlpha?: boolean; colorSpace?: PredefinedColorSpace; mips?: boolean }): Promise<GPUTexture>;
  /** Pixels back out, tightly packed, typed from the format. Stalls the pipeline. */
  readTexture(tex: GPUTexture, opts?: { x?: number; y?: number; width?: number; height?: number;
    mipLevel?: number; Ctor?: TypedArrayCtor }): Promise<any>;
  /** Fill the smaller mip levels from level 0 by linear-filtered blits. */
  generateMipmaps(tex: GPUTexture): Promise<GPUTexture>;

  // ─── Ping-pong ────────────────────────────────────────────────────────────────────────────
  pingPong<T>(make: () => T): PingPong<T>;
  createPingPong(sizeOrData: number | ArrayBuffer | ArrayBufferView): PingPong<StorageBufferHandle>;
  createPingPongTexture(width: number, height: number, format?: GPUTextureFormat, usage?: number): PingPong<GPUTexture>;

  // ─── Canvas & inspection ──────────────────────────────────────────────────────────────────
  /** Size the backing store to CSS box × devicePixelRatio, clamped to the device max. */
  resizeCanvas(canvas?: HTMLCanvasElement | OffscreenCanvas, opts?: { dpr?: number }):
    { width: number; height: number; changed: boolean };
  /** Draw a texture onto a target (textureLoad — unfilterable formats work). */
  show(tex: GPUTexture, view?: GPUTextureView | GPUTexture, opts?: { format?: GPUTextureFormat;
    scale?: number[]; offset?: number[]; clear?: Clear; flipY?: boolean }): Promise<RenderPipeline>;
  /** Download a texture as an image file; returns the Blob. 8-bit RGBA/BGRA only. */
  save(tex: GPUTexture, filename?: string, opts?: { type?: string; quality?: number; download?: boolean;
    x?: number; y?: number; width?: number; height?: number; mipLevel?: number }): Promise<Blob>;

  // ─── Escape hatches ───────────────────────────────────────────────────────────────────────
  /** Compile a WGSL module, cached, applying G.pre. */
  makeShader(code: string, applyPre?: boolean): Promise<GPUShaderModule>;
  bindGroup(pipeline: GPURenderPipeline | GPUComputePipeline, groupIndex: number,
    entries: GPUBindGroupEntry[]): GPUBindGroup;
  /** The schema engine itself; the result carries `wgsl`, `uniformBuffer`, `uniformWrite`. */
  makeSchema(uniforms?: UniformSchema, resources?: ResourceSchema, opts?: {
    group?: number; startBinding?: number; structName?: string; varName?: string;
    readOnly?: string[]; emitUniform?: boolean;
  }): { wgsl: string; uniformBuffer: GPUBuffer | null; uniformWrite: (values: Record<string, any>) => void };
}

/** Creates an independent toolkit instance. Call `await G.init(ctx?)` before anything else. */
export function WEBGPU(): TinyWebGPU;
