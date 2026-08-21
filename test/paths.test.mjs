// Every path the demo pages reference has to resolve to a file that exists, and has to stay
// inside the repo.
//
// This exists because of a bug that a root-served dev server cannot show you. libselect.js used
// to import the library with a page-relative specifier — '../src/tinywebgpu.js' from a page one
// level down — but a dynamic import() resolves its specifier against the importing module's URL,
// which is libselect.js at the repo root, not the page's. Served from the root of an origin the
// stray '..' has nowhere to go and is clamped away, so `python3 -m http.server` was happy. Served
// from a subdirectory, as GitHub Pages serves this site at /tinywebgpu/, the same '..' walked out
// to the domain root and every example and the tutorial 404'd on their own library: the page
// loaded, nothing ran, and nothing said why.
//
// So the rule checked here is "resolve it the way the browser will, then look on disk for it",
// and the pages are checked as if served from a subdirectory, which is the case that fails.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { BUILDS } from '../libselect.js';

const root = new URL('../', import.meta.url);
const pages = [
  'index.html',
  'docs/tutorial.html',
  'docs/webgpu-check.html',
  ...readdirSync(fileURLToPath(new URL('examples/', root))).filter(f => f.endsWith('.html'))
    .map(f => 'examples/' + f),
];

// Mounting the site under a subdirectory is what separates a specifier that only looks right from
// one that is right: at the origin root a leading '..' is silently clamped, and here it is not.
const MOUNT = 'https://example.test/tinywebgpu/';
const inside = url => url.href.startsWith(MOUNT);

const MOUNT_PATH = new URL(MOUNT).pathname;               // '/tinywebgpu/'
const onDisk = url => new URL(decodeURIComponent(url.pathname).slice(MOUNT_PATH.length), root);

let checked = 0, failed = 0;
const fail = (what, spec, base, url, why) => {
  failed++;
  console.log(`  FAIL  ${what}\n        "${spec}" from ${base.href}\n        → ${url.href} (${why})`);
};

const check = (what, spec, base) => {
  // Absolute URLs, protocol-relative and bare fragments are somebody else's problem.
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(spec)) return;
  checked++;
  const url = new URL(spec, base);
  if (!inside(url)) return fail(what, spec, base, url, 'outside the site');
  const file = onDisk(url);
  if (!existsSync(fileURLToPath(file))) return fail(what, spec, base, url, 'no such file');
  // A link into the tutorial is only as good as the heading it points at.
  if (url.hash.length > 1 && file.pathname.endsWith('.html')) {
    const target = readFileSync(fileURLToPath(file), 'utf8');
    if (!target.includes(`id="${url.hash.slice(1)}"`))
      return fail(what, spec, base, url, `no id="${url.hash.slice(1)}" in that page`);
  }
};

console.log(`resolving demo-page paths as if served from ${MOUNT}\n`);

for (const page of pages) {
  const src = readFileSync(fileURLToPath(new URL(page, root)), 'utf8');
  const pageUrl = new URL(page, MOUNT);

  // src=/href= on the page resolve against the page itself.
  for (const m of src.matchAll(/\s(?:src|href)="([^"]+)"/g)) check(page, m[1], pageUrl);

  // A static import inside an inline module also resolves against the page.
  for (const mod of src.matchAll(/<script type="module">([\s\S]*?)<\/script>/g))
    for (const m of mod[1].matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) check(page, m[1], pageUrl);
}

// And the builds libselect.js reaches for resolve against libselect.js, wherever a page sits.
const libselect = new URL('libselect.js', MOUNT);
for (const b of Object.values(BUILDS)) check('libselect.js BUILDS', b.file, libselect);

// The invariant above only holds while the import is anchored to this module's own URL. Nothing
// else in the file's behaviour would change if that anchor were dropped, and no root-served page
// would notice, so say so here rather than finding out on a deployed site again.
const source = readFileSync(fileURLToPath(new URL('libselect.js', root)), 'utf8');
assert.match(source, /await import\(new URL\([^)]*import\.meta\.url\)/,
  'loadLib must resolve the build path against import.meta.url, not against the page');
console.log('  ok    loadLib anchors its dynamic import to import.meta.url');

console.log(`\n${checked} paths checked`);
if (failed) { console.error(`${failed} unresolvable`); process.exit(1); }
console.log('all demo-page paths resolve');
