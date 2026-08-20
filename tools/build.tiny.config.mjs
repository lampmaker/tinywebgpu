// Settings for the fully stripped inline/on-chain build — `npm run build:tiny` →
// dist/tinywebgpu.tiny.js. Start from nothing and add features back per piece:
//   node tools/build-min.mjs tiny --with=show,blend
// CLI flags override this file per run: --out=, --with=, --without=, --iife,
// --pack / --no-pack, --no-banner.

// The rename table: short codes for the library's *own* API names, applied with `--rename` (or
// `rename: true` below). The build then truly renames them — `p.setResources(...)` becomes
// `p.sR(...)` — and a piece written against the renamed build saves the bytes on both sides of
// every call. A `/*renamed:sR=setResources,…*/` legend at the end of the output is the contract.
// Platform names (createRenderPipeline, createTexture, writeTexture, destroy, …) and WebGPU
// dictionary keys can NOT go in here — the browser owns those; the name-table `pack` below
// aliases them instead, and build-min.mjs refuses them loudly. Extend or trim freely; option
// keys you pass as objects (uniforms:, resources:, …) rename too, so write the short keys.
export const RENAMES = {
  // pipeline factories
  makeFrag: 'mF', makeDraw: 'mD', makeCompute: 'mC', makeQuad: 'mQ', makeCompute2D: 'mC2',
  makeShader: 'mSh', makeSchema: 'mS',
  // buffers & textures
  createStorageBuffer: 'cSB', createUniformBuffer: 'cUB', createIndirectBuffer: 'cIB',
  createStorageTexture: 'cST', createPingPong: 'cPP', createPingPongTexture: 'cPPT',
  pingPong: 'pP', writeUniforms: 'wU', loadTexture: 'lT', readTexture: 'rT',
  generateMipmaps: 'gM', resizeCanvas: 'rC',
  // frame & passes
  beginFrame: 'bF', endFrame: 'eF', beginCompute: 'bC', endCompute: 'eC',
  // pipeline members (uniforms/resources are the setter properties and the option keys)
  setUniforms: 'sU', setUniform: 'sU1', setResources: 'sR', uniforms: 'uS', resources: 'rS',
  drawTo: 'dT', dispatchIndirect: 'dI', bindTo: 'bT',
  uniformFields: 'uF', resourceFields: 'rF',
  pipeline: 'pl', count: 'cN', instances: 'iN',
  // the makeSchema result shape (wgsl / uniformBuffer / uniformWrite are its documented keys)
  wgsl: 'wG', uniformBuffer: 'uB', uniformWrite: 'uW',
};

export default {
  out: 'dist/tinywebgpu.tiny.js',

  // Feature switches: true = keep, false = strip the whole entry point from the build.
  // Everything optional is off here — flip a feature on for your piece, or per run with
  // --with= (and back off with --without=). DIAG never ships; build-min.mjs forces it off.
  features: {
    msg: false,      // human-readable error text; off, throws carry a number (see ERRORS in build-min.mjs)
    texio: false,    // writeTexture, loadTexture — CPU pixels into a texture
    read: false,     // GPU→CPU readback: buffer .r(), readTexture, and the staging pool behind them
    save: false,     // save() — download a texture as an image file; needs `read`
    show: false,     // show() — the one-call "let me look at that texture" blit
    pingpong: false, // pingPong, createPingPong, createPingPongTexture — double-buffer helpers
    resize: false,   // resizeCanvas() — size the backing store to CSS box × devicePixelRatio
    blend: false,    // the named blend presets ('alpha' | 'premultiplied' | 'additive')
    depth: false,    // makeDraw({depth}) — depth testing with an auto-managed depth texture
    mips: false,     // generateMipmaps, and the `mips` option on createTexture/loadTexture
    staging: false,  // the staging ring: frame-ordered writes; without it, the last in-frame write wins
    aliases: false,  // the long spellings — buffer/write/read on handles, …Fields on pipelines
  },

  banner: true,
  iife: false,         // pass --iife for the classic-<script> flavour

  // Raw bytes are the target here — inline builds never gzip — so the name-table pack is on,
  // and the legend comment makes the packed output readable ($a=beginComputePass, …).
  pack: true,
  packComment: true,
  // Mnemonic ids for chosen packed names instead of $x — e.g. { createRenderPipeline: 'cRP' }
  // gives `[cRP](` in the output. Costs the extra id length once per use; the legend already
  // names the $x codes for free, so this is purely a readability preference.
  packNames: {},

  // Apply the RENAMES table above (also per run: --rename, or --rename=name:code,…). Off for
  // the shipped artifact — the demos, tutorial and tests call the long names.
  rename: false,
  renames: RENAMES,

  // One line of code out: newlines inside template literals become \n escapes after minifying.
  // The legend comments (pack/renamed) then sit on their own lines below it.
  singleLine: true,

  // A token table to seed G.defines with (same format: `TOKEN replacement` entries split on
  // commas/newlines): the library's own WGSL ships compressed to any generic-type tokens in it,
  // and the piece's WGSL may use every token without setting G.defines itself. The expander is
  // always in the core — building the table in costs only the table string, offset by what the
  // library's own strings save. The seeded tokens are load-bearing: the library's shaders need
  // them at compile time, so the piece must append to G.defines (`+=`), never replace it.
  // Schema type strings are never expanded; spell those out.
  shorthand: '',   // e.g. 'F f32, V vec2<f32>, W vec3<f32>, X vec4<f32>'
};
