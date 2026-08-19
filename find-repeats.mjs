// Finds repeated substrings (min length 5) in a text file, via suffix array + LCP array.
// Usage: node find-repeats.mjs <file> [minLen] [topN]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function buildSuffixArray(s) {
  const n = s.length;
  const sa = new Array(n);
  for (let i = 0; i < n; i++) sa[i] = i;
  sa.sort((a, b) => {
    let i = a, j = b;
    while (i < n && j < n) {
      const ca = s.charCodeAt(i), cb = s.charCodeAt(j);
      if (ca !== cb) return ca - cb;
      i++; j++;
    }
    return (n - a) - (n - b);
  });
  return sa;
}

// Kasai's algorithm.
function buildLCPArray(s, sa) {
  const n = s.length;
  const rank = new Array(n);
  for (let i = 0; i < n; i++) rank[sa[i]] = i;
  const lcp = new Array(n).fill(0);
  let h = 0;
  for (let i = 0; i < n; i++) {
    if (rank[i] > 0) {
      const j = sa[rank[i] - 1];
      while (i + h < n && j + h < n && s[i + h] === s[j + h]) h++;
      lcp[rank[i]] = h;
      if (h > 0) h--;
    } else {
      h = 0;
    }
  }
  return lcp; // lcp[k] = LCP(sa[k-1], sa[k]); lcp[0] unused (0)
}

// Compares the suffix starting at sa[idx] against `pattern`, lexicographically,
// but only over pattern's length (so a suffix that's merely too short to hold
// the full pattern still resolves via char-by-char comparison up to its end).
function compareSuffixToPattern(s, sa, idx, pattern) {
  const start = sa[idx], n = s.length, m = pattern.length;
  for (let k = 0; k < m; k++) {
    if (start + k >= n) return -1;
    const c1 = s.charCodeAt(start + k), c2 = pattern.charCodeAt(k);
    if (c1 !== c2) return c1 - c2;
  }
  return 0;
}

// Returns [lo, hi) — the contiguous SA range of suffixes that start with pattern.
function occurrenceRange(s, sa, pattern) {
  const n = sa.length;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareSuffixToPattern(s, sa, mid, pattern) < 0) lo = mid + 1; else hi = mid;
  }
  const start = lo;
  lo = 0; hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareSuffixToPattern(s, sa, mid, pattern) <= 0) lo = mid + 1; else hi = mid;
  }
  return [start, lo];
}

// Greedily extends [start, start+len) left and right while its occurrence count
// stays unchanged — i.e. finds the true maximal repeat containing this span
// (can't grow either edge without dropping an occurrence).
function extendToMaximal(s, sa, start, len, count) {
  const n = s.length;
  while (start + len < n) {
    const [lo, hi] = occurrenceRange(s, sa, s.substring(start, start + len + 1));
    if (hi - lo !== count) break;
    len++;
  }
  while (start > 0) {
    const [lo, hi] = occurrenceRange(s, sa, s.substring(start - 1, start + len));
    if (hi - lo !== count) break;
    start--; len++;
  }
  return { start, len };
}

function findRepeats(text, minLen) {
  const n = text.length;
  const sa = buildSuffixArray(text);
  const lcp = buildLCPArray(text, sa);
  const seedCache = new Map(); // seed substring -> resolved final {str,len,count}
  const results = new Map();   // final (maximal) substring -> {str,len,count}

  for (let i = 1; i < n; i++) {
    const L = lcp[i];
    if (L < minLen) continue;
    const start0 = sa[i - 1];
    const seed = text.substring(start0, start0 + L);
    if (seedCache.has(seed)) continue; // already resolved via another seed
    const [lo, hi] = occurrenceRange(text, sa, seed);
    const count = hi - lo;
    const { start, len } = extendToMaximal(text, sa, start0, L, count);
    const str = text.substring(start, start + len);
    let resolved = results.get(str);
    if (!resolved) {
      resolved = { str, len, count };
      results.set(str, resolved);
    }
    seedCache.set(seed, resolved);
  }

  return [...results.values()];
}

function main() {
  const [, , file, minLenArg, topNArg] = process.argv;
  if (!file) {
    console.error('Usage: node find-repeats.mjs <file> [minLen=5] [topN=40]');
    process.exit(1);
  }
  const minLen = Number(minLenArg) || 5;
  const topN = Number(topNArg) || 40;

  const text = readFileSync(file, 'utf8');
  const repeats = findRepeats(text, minLen);

  repeats.sort((a, b) => (b.len * b.count) - (a.len * a.count));

  const rows = repeats.slice(0, topN).map(r => ({
    string: JSON.stringify(r.str),
    length: r.len,
    occurrences: r.count,
    total: r.len * r.count,
  }));
  console.table(rows);
  console.log(`${repeats.length} repeated substrings (len >= ${minLen}) found in ${file} (${text.length} chars). Showing top ${rows.length} by total length.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export { findRepeats };
