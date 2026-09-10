import type { Task } from '../domain/types.js';

/**
 * Resolves a free-text reference ("המשימה של דני") to a task.
 *
 * The rule from the spec: one clear match → act on it; several plausible
 * matches → ask, never guess. This module produces the ranking; the caller
 * decides based on `isAmbiguous`.
 */

export interface MatchResult {
  best: Task | null;
  candidates: Task[];
  isAmbiguous: boolean;
  score: number;
}

const STOPWORDS = new Set([
  'את',
  'של',
  'עם',
  'על',
  'לגבי',
  'המשימה',
  'משימה',
  'ה',
  'לי',
  'זה',
  'הזאת',
  'הזה',
  'ל',
  'מ',
  'ב',
  'ו',
  'כל',
  'אני',
  'צריך',
  'the',
  'to',
  'a',
  'for',
  'my',
  'task',
]);

export function tokenize(text: string): string[] {
  return text
    .replace(/[־–—]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Strips a single Hebrew prefix letter so "לדני" matches "דני". */
function stripHebrewPrefix(token: string): string {
  return /^[בלהמושכ]\p{L}{2,}$/u.test(token) ? token.slice(1) : token;
}

function tokenMatches(needle: string, haystackToken: string): boolean {
  const a = stripHebrewPrefix(needle);
  const b = stripHebrewPrefix(haystackToken);
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

export function scoreTask(reference: string, task: Task): number {
  const refTokens = tokenize(reference);
  if (!refTokens.length) return 0;
  const haystack = tokenize(
    [
      task.title,
      task.description ?? '',
      task.project ?? '',
      task.client ?? '',
      task.tags.join(' '),
    ].join(' '),
  );
  if (!haystack.length) return 0;

  let hits = 0;
  for (const token of refTokens) {
    if (haystack.some((h) => tokenMatches(token, h))) hits += 1;
  }
  const coverage = hits / refTokens.length;

  // An exact substring of the title is a much stronger signal than token overlap.
  const normRef = reference.trim().toLowerCase();
  const exact = normRef.length >= 3 && task.title.toLowerCase().includes(normRef) ? 0.35 : 0;

  return Math.min(1, coverage * 0.8 + exact);
}

/**
 * `ambiguityMargin` is how much clearer the top match must be than the runner-up
 * before we act without asking.
 */
export function matchTask(
  reference: string,
  tasks: Task[],
  opts: { minScore?: number; ambiguityMargin?: number; maxCandidates?: number } = {},
): MatchResult {
  const minScore = opts.minScore ?? 0.4;
  const margin = opts.ambiguityMargin ?? 0.2;
  const maxCandidates = opts.maxCandidates ?? 5;

  const scored = tasks
    .map((task) => ({ task, score: scoreTask(reference, task) }))
    .filter((s) => s.score >= minScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.task.due_at?.getTime() ?? Infinity) - (b.task.due_at?.getTime() ?? Infinity),
    );

  if (!scored.length) return { best: null, candidates: [], isAmbiguous: false, score: 0 };

  const top = scored[0]!;
  const runnerUp = scored[1];
  // Epsilon guard: scores are sums of floats, so an intended gap of exactly
  // `margin` can compute as 0.19999999999999996 and read as ambiguous.
  const ambiguous = Boolean(runnerUp && top.score - runnerUp.score < margin - 1e-9);

  return {
    best: ambiguous ? null : top.task,
    candidates: scored.slice(0, maxCandidates).map((s) => s.task),
    isAmbiguous: ambiguous,
    score: top.score,
  };
}
