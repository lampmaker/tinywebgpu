// Regression tests for the uniform packer and the WGSL shorthand module.
// Runs in plain node — the GPU device is stubbed, only the JS-side layout logic is tested.
// Usage: node test/layout.test.mjs
//        TWG_ENTRY=<path> node test/layout.test.mjs   ← run against another build
// The entry is overridable so the same assertions can be run against the minified build.

const ENTRY = process.env.TWG_ENTRY ?? '../tinywebgpu.js';
const { WEBGPU } = await import(ENTRY);
import { shorthand, TOKENS, SHORT_TOKENS } from '../wgsl_shorthand.js';

let failures = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// --- stub device: capture uniform-buffer sizes and writes -------------------
globalThis.GPUBufferUsage ??= { UNIFORM: 64, STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256, MAP_READ: 1 };
const S = WEBGPU();
let lastWrite = null;
S.device = {
  createBuffer: ({ size }) => ({ size }),
  queue: { writeBuffer: (buf, off, ab) => { lastWrite = ab.slice(0); } },
};

const layoutOf = uniforms => {
  const r = S.makeUniformsAndResources(uniforms);
  return { byteSize: r.uniformBuffer.size, wgsl: r.wgsl, write: r.uniformWrite };
};

// --- scalar packs into a vec3 tail (offset 12, not 16) ---------------
{
  const { byteSize, write } = layoutOf({ pos: 'vec3<f32>', t: 'f32' });
  check('vec3+f32 struct size', byteSize, 16);
  write({ pos: [1, 2, 3], t: 9 });
  check('vec3+f32 written floats', [...new Float32Array(lastWrite)], [1, 2, 3, 9]);
}

// --- mixed struct: f32, vec3, f32, vec2 → WGSL offsets 0,16,28,32, size 48 --
{
  const { byteSize, write } = layoutOf({ a: 'f32', b: 'vec3<f32>', c: 'f32', d: 'vec2<f32>' });
  check('f32+vec3+f32+vec2 struct size', byteSize, 48);
  write({ a: 1, b: [2, 3, 4], c: 5, d: [6, 7] });
  check('f32+vec3+f32+vec2 floats',
    [...new Float32Array(lastWrite)],
    [1, 0, 0, 0, 2, 3, 4, 5, 6, 7, 0, 0]);
}

// --- mat4 after scalar: mat aligns to 16 bytes, total 80 --------------------
{
  const { byteSize, write } = layoutOf({ s: 'f32', m: 'mat4x4<f32>' });
  check('f32+mat4 struct size', byteSize, 80);
  const m = Array.from({ length: 16 }, (_, i) => i + 1);
  write({ s: 42, m });
  const f = [...new Float32Array(lastWrite)];
  check('f32+mat4 scalar at 0', f[0], 42);
  check('f32+mat4 matrix at float 4', f.slice(4, 20), m);
}

// --- u32 vec3 packs the same way -------------------------------------------
{
  const { byteSize, write } = layoutOf({ seed: 'vec3<u32>', n: 'u32' });
  check('vec3<u32>+u32 struct size', byteSize, 16);
  write({ seed: [10, 20, 30], n: 7 });
  check('vec3<u32>+u32 written uints', [...new Uint32Array(lastWrite)], [10, 20, 30, 7]);
}

// --- createStorageBuffer: size vs create-and-fill -------------------
{
  const bySize = S.createStorageBuffer(64);
  check('createStorageBuffer(bytes) sizes the buffer', bySize.b.size, 64);

  lastWrite = null;
  const data = Float32Array.from([1, 2, 3, 4]);
  const filled = S.createStorageBuffer(data);
  check('createStorageBuffer(data) sizes from byteLength', filled.b.size, 16);
  check('createStorageBuffer(data) fills in one call', [...new Float32Array(lastWrite)], [1, 2, 3, 4]);

  const odd = S.createStorageBuffer(new Uint8Array(6));
  check('createStorageBuffer(data) rounds size up to 4 bytes', odd.b.size, 8);
}

// --- wgsl_shorthand ---------------------------------------------------------
{
  const full = shorthand(TOKENS, SHORT_TOKENS);
  check('shorthand expands long tokens', full('fn f(a: VEC3) -> FLOAT'), 'fn f(a: vec3<f32>) -> f32');
  check('shorthand expands short tokens', full('var x: X = X(F(1), 2., 3., PI);'),
    'var x: vec4<f32> = vec4<f32>(f32(1), 2., 3., 3.14159265359);');
  check('U3 wins over U', full('var a: U3; var b: U;'), 'var a: vec3<u32>; var b: u32;');
  check('identifiers untouched', full('let Fresnel = myF + PIx;'), 'let Fresnel = myF + PIx;');
  const safe = shorthand();
  check('default set leaves one-letter names alone', safe('let F = 1.0; let v: VEC2;'),
    'let F = 1.0; let v: vec2<f32>;');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall tests passed');
