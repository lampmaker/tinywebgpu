// WGSL shorthand token expander — optional companion to tinywebgpu.js.
// The core never rewrites user WGSL; opt in via the G.pre hook:
//
//   import { shorthand, TOKENS, SHORT_TOKENS } from './wgsl_shorthand.js';
//   G.pre = shorthand();                        // long tokens + constants only (safe set)
//   G.pre = shorthand(TOKENS, SHORT_TOKENS);    // full legacy set incl. one-letter aliases
//   G.pre = shorthand({ RAY: 'MyRayStruct', ...TOKENS });   // custom map
//
// The returned function is deterministic and can be composed with other preprocessors:
//   G.pre = s => shorthand()(myMacros(s));

export const TOKENS = {
  FLOAT: 'f32', INT: 'i32',
  VEC2: 'vec2<f32>', VEC3: 'vec3<f32>', VEC4: 'vec4<f32>',
  MAT4: 'mat4x4<f32>',
  PI: '3.14159265359', TAU: '6.28318530718', EPS: '1e-5',
};

// One-letter aliases collide easily with user identifiers (F for Fresnel, U, PI...).
// They are deliberately NOT part of the default set — opt in explicitly.
export const SHORT_TOKENS = {
  F: 'f32', V: 'vec2<f32>', W: 'vec3<f32>', X: 'vec4<f32>',
  I: 'i32', U: 'u32', U3: 'vec3<u32>',
};

export const shorthand = (...maps) => {
  const map = Object.assign({}, ...(maps.length ? maps : [TOKENS]));
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // longest key first so e.g. U3 wins over U
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(?:${keys.map(esc).join('|')})\\b`, 'g');
  return src => src.replace(re, t => map[t]);
};
