// Settings for the stock minified build — `npm run build:min` → tinywebgpu.min.js.
// build-min.mjs holds the machinery (feature registry, error table, transforms); this file
// holds the choices. CLI flags still override per run: --out=, --with=, --without=, --iife,
// --pack / --no-pack, --no-banner.

export default {
  out: 'tinywebgpu.min.js',

  // Feature switches: true = keep, false = strip the whole entry point from the build.
  // Every optional feature stays in the stock build. DIAG never ships — build-min.mjs forces
  // it off. The names double as the --with/--without vocabulary, which overrides this per run.
  features: {
    msg: true,       // human-readable error text; off, throws carry a number (see ERRORS in build-min.mjs)
    texio: true,     // writeTexture, loadTexture — CPU pixels into a texture
    read: true,      // GPU→CPU readback: buffer .r(), readTexture, and the staging pool behind them
    save: true,      // save() — download a texture as an image file; needs `read`
    show: true,      // show() — the one-call "let me look at that texture" blit
    pingpong: true,  // pingPong, createPingPong, createPingPongTexture — double-buffer helpers
    resize: true,    // resizeCanvas() — size the backing store to CSS box × devicePixelRatio
    blend: true,     // the named blend presets ('alpha' | 'premultiplied' | 'additive')
    depth: true,     // makeDraw({depth}) — depth testing with an auto-managed depth texture
    mips: true,      // generateMipmaps, and the `mips` option on createTexture/loadTexture
    staging: true,   // the staging ring: frame-ordered writes, so per-dispatch uniforms work in one frame
    aliases: true,   // the long spellings — buffer/write/read on handles, …Fields on pipelines
  },

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

  // A token table to seed G.defines with (see build.tiny.config.mjs for the
  // trade-off). Off for the stock build: assigning G.defines at runtime covers the same ground.
  shorthand: '',
};
