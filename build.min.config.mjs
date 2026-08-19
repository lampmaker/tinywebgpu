// Settings for the stock minified build — `npm run build:min` → tinywebgpu.min.js.
// build-min.mjs holds the machinery (feature registry, error table, transforms); this file
// holds the choices. CLI flags still override per run: --out=, --with=, --without=, --iife,
// --pack / --no-pack, --no-banner.

export default {
  out: 'tinywebgpu.min.js',

  // Every optional feature stays in. DIAG never ships — build-min.mjs forces it off.
  // Names are the --with/--without vocabulary; see FEATURES in build-min.mjs.
  features: ['msg', 'texio', 'read', 'save', 'show', 'pingpong', 'resize',
    'blend', 'depth', 'mips', 'staging', 'aliases'],

  banner: true,        // the /*! version | MIT */ header
  iife: false,         // false = ESM export; true = classic <script> assigning globalThis.WEBGPU

  // The name-table rewrite only pays in raw bytes, and this build is HTTP-delivered (gzipped),
  // so it stays off. packComment appends a /*pack:$a=…*/ legend when pack is on, and packNames
  // picks mnemonic codes for chosen names ({ createRenderPipeline: 'cRP' }).
  pack: false,
  packComment: false,
  packNames: {},

  // Renaming the library's own API (see RENAMES in build.tiny.config.mjs) is for private piece
  // builds; this build is the public library, so its API stays put.
  rename: false,
  renames: {},

  // Escape the newlines inside template literals after minifying, so the file is one line.
  singleLine: true,

  // A wgsl_shorthand token table to build into the library (see build.tiny.config.mjs for the
  // trade-off). Off for the stock build: G.pre + wgsl_shorthand.js covers the same ground.
  shorthand: '',
};
