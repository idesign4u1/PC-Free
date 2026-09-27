/**
 * Hebrew text layout helpers:
 *  - wrapBalanced: smart line breaking into at most N balanced lines.
 *  - toVisualOrder: logical → visual reordering for renderers without bidi support.
 *
 * Effect House renderers that already shape RTL correctly should use the logical text
 * as-is ("native" mode). If Hebrew shows up reversed in Preview, switch to "visual" mode.
 */

export interface WrappedText {
  lines: string[];
  /** Longest line length, in characters. */
  longest: number;
  /** Scale factor (≤ 1) to fit the longest line into `maxChars`. */
  fitScale: number;
}

/**
 * Splits `text` into the fewest lines (≤ maxLines) whose longest line fits `maxChars`,
 * choosing break points that make lines as even as possible. If nothing fits, uses
 * `maxLines` lines and reports a `fitScale` < 1 so the caller can shrink the text.
 */
export function wrapBalanced(text: string, maxChars: number, maxLines = 3): WrappedText {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [''], longest: 0, fitScale: 1 };

  let best: string[] = [words.join(' ')];
  const lineCount = Math.min(maxLines, words.length);
  for (let n = 1; n <= lineCount; n++) {
    best = bestSplit(words, n);
    if (longestOf(best) <= maxChars) break;
  }
  const longest = longestOf(best);
  return { lines: best, longest, fitScale: longest > maxChars ? maxChars / longest : 1 };
}

function longestOf(lines: string[]): number {
  let max = 0;
  for (const line of lines) max = Math.max(max, charLength(line));
  return max;
}

/** Visible length (code points, ignoring variation selectors / ZWJ). */
function charLength(s: string): number {
  let n = 0;
  for (const cp of Array.from(s)) {
    const code = cp.codePointAt(0) as number;
    if (code !== 0xfe0f && code !== 0x200d) n++;
  }
  return n;
}

/** Minimizes the longest line when splitting `words` into exactly `n` lines. */
function bestSplit(words: string[], n: number): string[] {
  if (n <= 1) return [words.join(' ')];
  let bestLines: string[] = [];
  let bestScore = Infinity;

  const recurse = (start: number, remaining: number, acc: string[]): void => {
    if (remaining === 1) {
      const lines = acc.concat(words.slice(start).join(' '));
      const lengths = lines.map(charLength);
      // Primary: shortest longest-line. Secondary: prefer a slightly shorter last line
      // (the "pyramid" shape reads better for questions ending with "?").
      const score = Math.max(...lengths) * 100 + Math.abs(lengths[0] - lengths[lengths.length - 1]);
      if (score < bestScore) {
        bestScore = score;
        bestLines = lines;
      }
      return;
    }
    for (let end = start + 1; end <= words.length - (remaining - 1); end++) {
      recurse(end, remaining - 1, acc.concat(words.slice(start, end).join(' ')));
    }
  };
  recurse(0, n, []);
  return bestLines;
}

// ---------------------------------------------------------------------------
// Minimal bidi (RTL paragraph) — enough for Hebrew with digits, Latin words and emoji.
// ---------------------------------------------------------------------------

type BidiClass = 'R' | 'L' | 'EN' | 'N';

const MIRRORED: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

function classify(cluster: string): BidiClass {
  const code = cluster.codePointAt(0) as number;
  if ((code >= 0x0590 && code <= 0x05ff) || (code >= 0xfb1d && code <= 0xfb4f)) return 'R';
  if (code >= 0x30 && code <= 0x39) return 'EN';
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) return 'L';
  return 'N';
}

/** Splits into grapheme-like clusters so emoji (ZWJ, VS16, skin tones) never get split. */
function clusters(s: string): string[] {
  const out: string[] = [];
  const cps = Array.from(s);
  for (let i = 0; i < cps.length; i++) {
    let c = cps[i];
    while (i + 1 < cps.length) {
      const next = cps[i + 1].codePointAt(0) as number;
      const isJoiner = next === 0x200d;
      const isModifier = next === 0xfe0f || next === 0x20e3 || (next >= 0x1f3fb && next <= 0x1f3ff) || (next >= 0x0591 && next <= 0x05c7 && next !== 0x05be);
      if (isJoiner && i + 2 < cps.length) {
        c += cps[i + 1] + cps[i + 2];
        i += 2;
      } else if (isModifier) {
        c += cps[i + 1];
        i += 1;
      } else break;
    }
    out.push(c);
  }
  return out;
}

/**
 * Converts one line of logical-order text (RTL base direction) into left-to-right
 * visual order. Numbers and Latin words stay readable; neutrals follow the Unicode
 * rule N1 (digits count as R when resolving neutrals).
 */
export function toVisualOrder(line: string): string {
  const cl = clusters(line);
  const types = cl.map(classify);

  // Resolve neutrals: L only if both neighbours (skipping neutrals) are L; otherwise R.
  const strongAsR = (t: BidiClass): 'L' | 'R' => (t === 'L' ? 'L' : 'R');
  const resolved: ('L' | 'R' | 'EN')[] = types.map((t, i) => {
    if (t !== 'N') return t;
    let prev: 'L' | 'R' = 'R';
    for (let j = i - 1; j >= 0; j--) if (types[j] !== 'N') { prev = strongAsR(types[j]); break; }
    let next: 'L' | 'R' = 'R';
    for (let j = i + 1; j < types.length; j++) if (types[j] !== 'N') { next = strongAsR(types[j]); break; }
    return prev === 'L' && next === 'L' ? 'L' : 'R';
  });

  // Reverse the whole line, then restore left-to-right order inside L / EN runs.
  const out: string[] = [];
  let i = cl.length - 1;
  while (i >= 0) {
    const kind = resolved[i];
    if (kind === 'R') {
      out.push(MIRRORED[cl[i]] ?? cl[i]);
      i--;
      continue;
    }
    let start = i;
    while (start - 1 >= 0 && resolved[start - 1] === kind) start--;
    for (let k = start; k <= i; k++) out.push(cl[k]);
    i = start - 1;
  }
  return out.join('');
}

export type HebrewRenderMode = 'native' | 'visual';

/** Produces the final multi-line string for a Text component. */
export function formatForRenderer(lines: string[], mode: HebrewRenderMode): string {
  return (mode === 'visual' ? lines.map(toVisualOrder) : lines).join('\n');
}
