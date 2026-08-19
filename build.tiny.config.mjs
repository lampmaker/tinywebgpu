// Settings for the fully stripped inline/on-chain build — `npm run build:tiny` →
// tinywebgpu.tiny.js. Start from nothing and add features back per piece:
//   node build-min.mjs tiny --with=show,blend
// CLI flags override this file per run: --out=, --with=, --without=, --iife,
// --pack / --no-pack, --no-banner.

// Imported so the `shorthand` option below is one edit away; unused while it stays ''.
import { SHORT_TOKENS } from './wgsl_shorthand.js';

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
