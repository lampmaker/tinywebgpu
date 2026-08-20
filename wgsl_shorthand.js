// Ready-made WGSL define tables — optional companion to tinywebgpu.js.
// The core expands `G.defines` — WGSL's missing #define — in every shader it compiles.
// A table is one string: entries separated by commas or newlines, each entry
// `TOKEN replacement` — so replacements may contain spaces, but not commas, and
// composing tables is string concatenation:
//
//   import { TOKENS, SHORT_TOKENS } from './wgsl_shorthand.js';
//   G.defines = TOKENS;                     // the safe stock set
//   G.defines = TOKENS + SHORT_TOKENS;      // + the one-letter aliases
//   G.defines += '\nRAY MyRayStruct';       // custom additions

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
