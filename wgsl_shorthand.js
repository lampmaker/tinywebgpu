// WGSL shorthand token expander — optional companion to tinywebgpu.js.
// The core never rewrites user WGSL; opt in via the G.pre hook:
//
//   import { shorthand, TOKENS, SHORT_TOKENS } from './wgsl_shorthand.js';
//   G.pre = shorthand();                          // the safe stock set (TOKENS)
//   G.pre = shorthand(TOKENS + SHORT_TOKENS);     // + the one-letter aliases
//   G.pre = shorthand('RAY MyRayStruct\n' + TOKENS);          // custom additions
//   G.pre = s => shorthand()(myMacros(s));                    // compose freely
//
// A table is one string: entries separated by commas or newlines, each entry
// `TOKEN replacement` — so replacements may contain spaces, but not commas.
// The returned function is deterministic, as G.pre requires.

export let TOKENS = `
FLOAT f32
INT i32
VEC2 vec2<f32>
VEC3 vec3<f32>
VEC4 vec4<f32>
MAT4 mat4x4<f32>
PI 3.14159265359
TAU 6.28318530718
EPS 1e-5
`;

// One-letter aliases collide easily with user identifiers (F for Fresnel, U, PI...).
// They are deliberately NOT part of the default set — opt in with TOKENS + SHORT_TOKENS.
export let SHORT_TOKENS = `
F f32, I i32, U u32
V vec2<f32>, W vec3<f32>, X vec4<f32>
U3 vec3<u32>
`;

export let shorthand = (defs = TOKENS) => {
  let map = {};
  for (let e of defs.split(/[,\n]/)) {
    let m = /^(\S+)\s+(.+)/.exec(e.trim());
    if (m) map[m[1]] = m[2];
  }
  // longest token first so e.g. U3 wins over U
  let keys = Object.keys(map).sort((a, b) => b.length - a.length)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let re = new RegExp(`\\b(?:${keys.join('|')})\\b`, 'g');
  return src => src.replace(re, t => map[t]);
};
