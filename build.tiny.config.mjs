// Settings for the fully stripped inline/on-chain build — `npm run build:tiny` →
// tinywebgpu.tiny.js. Start from nothing and add features back per piece:
//   node build-min.mjs tiny --with=show,blend
// CLI flags override this file per run: --out=, --with=, --without=, --iife,
// --pack / --no-pack, --no-banner.

// Imported so the `shorthand` option below is one edit away; unused while it stays ''.
import { SHORT_TOKENS } from './wgsl_shorthand.js';

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
};

export default {
  out: 'tinywebgpu.tiny.js',

  // Everything optional off; --with= names what a piece needs (see FEATURES in build-min.mjs).
  features: [],

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

  // One line out: newlines inside template literals become \n escapes after minifying.
  singleLine: true,

  // Set to SHORT_TOKENS to build the one-letter WGSL tokens in: the library's own WGSL ships
  // compressed (V for vec2<f32>, X for vec4<f32>, …) and the piece's WGSL may use the same
  // tokens without shipping wgsl_shorthand.js. Measured on the bare build: the expander costs
  // ~145 B and the library's own strings save 93 B, a ~50 B net loss — so this pays once your
  // piece's WGSL uses ~7 or more tokens (each V saves 8 B). Schema type strings are never
  // expanded; spell those out.
  shorthand: '',   // e.g. SHORT_TOKENS
};
