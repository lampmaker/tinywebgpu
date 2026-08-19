// Build picker shared by the demo pages (index.html, tutorial.html, examples/*).
//
// The library ships three ways — the readable source, the minified build, and the tiny build
// with the optional entry points removed. Every demo page reads `?lib=full|min|tiny` and imports
// the matching file, so each one doubles as a smoke test of the build it claims to run on.
// This module owns that choice: it resolves the parameter, draws the corner picker, carries the
// parameter across same-site links, and — because the stock tiny build drops whole entry points —
// lets a page declare what it needs, so a demo that reads results back or resizes its canvas can
// say "not in this build" instead of dying on a TypeError.

export const BUILDS = {
  full: { file: 'tinywebgpu.js',      note: 'readable source — all features, warnings on' },
  min:  { file: 'tinywebgpu.min.js',  note: 'minified — all features, console-free' },
  tiny: { file: 'tinywebgpu.tiny.js', note: 'minified — optional entry points removed, numbered errors' },
};

// What the stock tiny build (`npm run build:tiny`, no --with) leaves out, keyed by the feature
// names build-min.mjs uses, with the text a reader of a demo page should see.
export const TINY_DROPS = {
  read:     'GPU→CPU readback (buf.r(), readTexture)',
  texio:    'writeTexture / loadTexture',
  resize:   'resizeCanvas()',
  blend:    "the named blend presets ('alpha', …)",
  staging:  'frame-ordered uniform writes',
  pingpong: 'the ping-pong helpers',
  show:     'show()',
  save:     'save()',
  depth:    'the depth option',
  mips:     'mipmaps',
};

// The tiny build also drops its error text (MSG=false): errors throw a number. This mirrors
// ERRORS in build-min.mjs so the tutorial can translate them back.
export const TINY_ERRORS = {
  1: 'WebGPU not supported',
  2: 'No GPU adapter',
  3: 'WGSL compilation failed',
  4: 'unknown blend preset',
  5: 'buffer write: not a TypedArray or ArrayBuffer',
  6: 'buffer write: byteOffset must be a multiple of 4',
  7: 'no render target — init() had no canvas context and no view was passed',
  8: 'resizeCanvas: no canvas',
  9: 'writeTexture: unknown bytes-per-texel, pass bytesPerRow',
  10: 'loadTexture: could not determine source dimensions',
  11: 'readTexture: unknown bytes-per-texel',
  12: 'unknown uniform type',
  13: 'unknown uniform name',
  14: 'bind group resource validation failed',
  15: 'no resources bound — call setResources() first',
  17: 'no active compute pass — call beginCompute() first',
  18: 'drawTo: no view for a named target',
  19: 'save: needs an 8-bit RGBA texture',
  20: 'loadTexture: the fetch for a URL source failed',
  21: 'depth: target size unknown — pass a GPUTexture to drawTo, or supply depth.texture',
  22: 'unknown resource name in setResources',
  23: 'init: the CSS selector matched nothing',
};

export const current = () => {
  const l = new URLSearchParams(location.search).get('lib');
  return BUILDS[l] ? l : 'full';
};

// Which of a page's needs a given build lacks. Only tiny lacks anything.
export const missing = (needs = [], lib = current()) =>
  lib === 'tiny' ? needs.filter(n => n in TINY_DROPS) : [];

// Turn an error into readable text. Tiny-build errors are bare numbers; look them up.
export const explain = (e, lib = current()) => {
  const m = e?.message ?? String(e);
  return lib === 'tiny' && TINY_ERRORS[m]
    ? `error ${m}: ${TINY_ERRORS[m]} (the tiny build throws numbers — its error text is stripped)`
    : m;
};

const sameUrlWith = lib => {
  const u = new URL(location.href);
  if (lib === 'full') u.searchParams.delete('lib'); else u.searchParams.set('lib', lib);
  return u.href;
};

// Draw the corner picker and, when the chosen build cannot serve this page, a warning strip.
// `needs` is the page's feature list (keys of TINY_DROPS). Returns the chosen build name.
export const initPicker = (needs = []) => {
  const lib = current();

  const style = document.createElement('style');
  style.textContent = `
    #libpicker {
      position: fixed; top: .55rem; right: .6rem; z-index: 99; display: flex;
      background: rgba(18, 18, 24, .88); border: 1px solid rgba(255, 255, 255, .18);
      border-radius: 999px; padding: .15rem; backdrop-filter: blur(4px);
      font: 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #libpicker a {
      color: #cfcfda; text-decoration: none; padding: .35rem .6rem; border-radius: 999px;
    }
    #libpicker a:hover { color: #fff; }
    #libpicker a.on { background: #2f6df6; color: #fff; }
    #libpicker a.na { opacity: .55; }
    #libwarn {
      background: #2c2413; color: #e8c983; border-bottom: 1px solid rgba(232, 201, 131, .35);
      padding: .6rem 5.5rem .6rem 1rem; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
    }
    #libwarn code { font-family: ui-monospace, Menlo, Consolas, monospace; }
  `;
  document.head.append(style);

  // Same-site links keep the chosen build, so browsing the demos stays on one flavour.
  // (Done before the picker exists, so its own links are left alone.)
  if (lib !== 'full') {
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (/^[a-z]+:|^\/\/|^#/.test(href) || !/\.html(\?|#|$)/.test(href)) continue;
      const u = new URL(href, location.href);
      u.searchParams.set('lib', lib);
      a.href = u.href;
    }
  }

  const picker = document.createElement('div');
  picker.id = 'libpicker';
  picker.setAttribute('aria-label', 'TinyWebGPU build');
  for (const [name, b] of Object.entries(BUILDS)) {
    const a = document.createElement('a');
    const miss = missing(needs, name);
    a.textContent = miss.length ? name + '*' : name;
    a.href = sameUrlWith(name);
    a.className = (name === lib ? 'on ' : '') + (miss.length ? 'na' : '');
    a.title = `${b.file} — ${b.note}` +
      (miss.length ? `\n\nThis page uses features this build drops:\n· ${miss.map(m => TINY_DROPS[m]).join('\n· ')}` : '');
    picker.append(a);
  }
  document.body.append(picker);

  const miss = missing(needs, lib);
  if (miss.length) {
    const warn = document.createElement('div');
    warn.id = 'libwarn';
    warn.innerHTML = `<b>Heads-up:</b> the <code>tiny</code> build leaves out ` +
      `${miss.map(m => `<b>${TINY_DROPS[m]}</b>`).join(', ')} — parts of this page will not run. ` +
      `Switch to <code>full</code> or <code>min</code> in the corner to see everything.`;
    document.body.prepend(warn);
  }
  return lib;
};

// One call for the example pages: draw the picker and import the chosen build.
// `base` is the path from the page to the repo root (examples pass '..').
export const loadLib = async (needs = [], base = '.') => {
  const lib = initPicker(needs);
  const { WEBGPU } = await import(`${base}/${BUILDS[lib].file}`);
  return { WEBGPU, lib, missing: missing(needs, lib) };
};
