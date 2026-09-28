/**
 * GameManager — "מי פה? 👀" (single-file build for Effect House).
 * GENERATED from Scripts/*.ts by tools/build-single.mjs — edit the sources, not this file.
 * Paste into a "New Script Component" named GameManager and attach it to the GameManager object.
 */

// ===== Easing.ts =====
/** Small, allocation-free easing & interpolation helpers. All inputs are clamped to [0, 1]. */

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Normalized progress of `t` inside the window [start, start + duration]. */
const progress = (t: number, start: number, duration: number): number =>
  duration <= 0 ? (t >= start ? 1 : 0) : clamp01((t - start) / duration);

const easeOutCubic = (t: number): number => {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
};

const easeInCubic = (t: number): number => {
  const c = clamp01(t);
  return c * c * c;
};

const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

/** Overshoots then settles — the "pop" feel. `overshoot` ~1.7 is classic, higher = bouncier. */
const easeOutBack = (t: number, overshoot = 1.70158): number => {
  const c = clamp01(t) - 1;
  return 1 + (overshoot + 1) * c * c * c + overshoot * c * c;
};

/** 0 → 1 → 0 bump, peaking at t = 0.5. */
const bump = (t: number): number => Math.sin(Math.PI * clamp01(t));

/** Quick hit that decays: 1 at t = 0, 0 at t = 1. */
const decay = (t: number): number => {
  const u = 1 - clamp01(t);
  return u * u;
};

// ===== GameConfig.ts =====
/**
 * Timings (ms), layout and copy for "מי פה? 👀".
 * Positions are in a 1080×1920 (9:16) reference frame, measured from the top-left.
 */
const REFERENCE_WIDTH = 1080;
const REFERENCE_HEIGHT = 1920;

const TIMING = {
  introDuration: 1500,
  introPopIn: 360,
  introOutStart: 1220,

  questionExit: 230,
  questionEnter: 340,
  questionHold: 650,

  countdownStep: 760,
  countdownSteps: 3,

  revealDuration: 1500,
  nowPop: 280,
  nowOutStart: 1150,
  flash: 220,
  burst: 900,

  tapHintDelay: 1000,
  tapHintFade: 320,

  /** Frame-time clamp so a hitch never skips a whole phase. */
  maxFrameDelta: 100,
} as const;

/**
 * Element anchor points (center) in the reference frame.
 * Safe area: top ~12% (TikTok status/tabs), bottom ~20% (caption & buttons),
 * right ~15% between 35%–85% height (like/comment/share rail).
 * The question card sits high so the faces in the middle stay visible.
 */
const LAYOUT = {
  intro: { x: 540, y: 800 },
  introSubtitle: { x: 540, y: 940 },
  card: { x: 540, y: 520, width: 820, height: 380 },
  questionEmoji: { x: 540, y: 330 },
  // Countdown / "עכשיו!" sit low (chest height) so they never cover faces for long.
  countdown: { x: 540, y: 1230 },
  now: { x: 540, y: 1230 },
  tapHint: { x: 540, y: 1430 },
  branding: { x: 540, y: 1515 },
  /** Max characters per question line before wrapping to the next line. */
  questionMaxChars: 15,
  questionMaxLines: 3,
  burstRadius: 340,
  burstInnerRadius: 230,
} as const;

const COPY = {
  introTitle: 'מי פה? 👀',
  introSubtitle: 'תצביעו עליו ב-3...2...1',
  now: '👉 עכשיו!',
  tapHint: 'נגיעה למסך לשאלה הבאה 👀',
  branding: 'Created by AiSolution',
} as const;

/** Emojis thrown in the "עכשיו!" burst (cycled over the burst particles). */
const BURST_EMOJIS = ['😂', '👀', '👉', '🔥', '✨', '😱'] as const;

/** Countdown accent colors (RGB 0–1): warm → hot as tension rises. */
const COUNTDOWN_COLORS: readonly (readonly [number, number, number])[] = [
  [0.55, 0.85, 1.0], // 3 — cool cyan
  [1.0, 0.78, 0.25], // 2 — amber
  [1.0, 0.25, 0.45], // 1 — hot pink
];

// ===== Questions.ts =====
/**
 * Question bank for "מי פה? 👀".
 *
 * Each entry is [text, emoji]. The emoji is kept separate from the text so it can be
 * rendered by its own Text object (sticker on the card) — this keeps the question
 * readable with a Hebrew-only font and lets the emoji bounce independently.
 * An empty emoji string means "no sticker" (a default one is used).
 */
type QuestionEntry = readonly [text: string, emoji: string];

const DEFAULT_EMOJI = '👀';

const QUESTIONS: readonly QuestionEntry[] = [
  // --- Core list ---
  ['מי פה הכי קמצן?', '😂'],
  ['מי תמיד מאחר?', '⏰'],
  ['מי מבזבז יותר כסף?', '💸'],
  ['מי יותר קנאי?', '👀'],
  ['מי מתאהב ראשון?', '❤️'],
  ['מי יותר דרמטי?', '🎭'],
  ['מי לא מסוגל לשמור סוד?', '🤐'],
  ['מי ינצח בוויכוח גם כשהוא טועה?', '😂'],
  ['מי ישרוד יותר זמן בלי טלפון?', '📱'],
  ['מי יגיע ראשון למיליון?', '💰'],
  ['מי הכי מפונק?', '👑'],
  ['מי אוכל הכי הרבה?', '🍔'],
  ['מי קם הכי מאוחר?', '😴'],
  ['מי הכי מכור לטלפון?', '📱'],
  ['מי הכי מצחיק?', '🤣'],
  ['מי יתחיל ריב ראשון?', '😤'],
  ['מי יתנצל ראשון?', '🥺'],
  ['מי הכי עקשן?', '🐐'],
  ['מי יותר רומנטי?', '❤️'],
  ['מי יותר פחדן?', '😨'],
  ['מי יכול להירדם בכל מקום?', '😴'],
  ['מי יברח ראשון מסרט אימה?', '😱'],
  ['מי הכי סביר שישכח יום הולדת?', '🎂'],
  ['מי הכי סביר שיזכה בלוטו?', '🍀'],
  ['מי הכי סביר שיבזבז את כל כספי הזכייה?', '💸'],
  ['מי יגיע ראשון לחתונה?', '💍'],
  ['מי הכי סביר שיתחתן בלי לספר לאף אחד?', '🤫'],
  ['מי מכיר את השני יותר טוב?', '🧠'],
  ['מי מדבר יותר?', '🗣️'],
  ['מי עושה יותר פדיחות?', '🙈'],
  ['מי מצלם יותר סלפי?', '🤳'],
  ['מי הכי סביר להפוך לוויראלי בטיקטוק?', '🚀'],
  ['מי מוחק הודעה אחרי ששלח אותה?', '🫣'],
  ['מי הכי סביר שיעשה סטוקינג באינסטגרם?', '👀'],
  ['מי הכי סביר שיגיד "אני בדרך" כשהוא עדיין בבית?', '🏠'],
  ['מי הכי רעב כרגע?', '🤤'],
  ['מי מזמין יותר אוכל?', '🛵'],
  ['מי הכי מסודר?', '🧹'],
  ['מי הכי מבולגן?', '🌪️'],
  ['מי הכי סביר שיאבד את המפתחות?', '🔑'],
  ['מי נוהג הכי גרוע?', '🚗'],
  ['מי הכי סביר לקבל קנס?', '🚨'],
  ['מי הכי סביר להירדם באמצע סרט?', '🍿'],
  ['מי הכי סביר שיעזוב קבוצה בווטסאפ?', '👋'],
  ['מי עונה הכי לאט להודעות?', '🐢'],
  ['מי הכי סביר לשלוח הודעה לאדם הלא נכון?', '😬'],
  ['מי הכי סביר לצחוק ברגע הלא מתאים?', '🤭'],
  ['מי עושה את הקניות הכי מיותרות?', '🛒'],
  ['מי הכי סביר לצאת מהבית בלי ארנק?', '👛'],
  ['מי הכי סביר לומר "רק עוד 5 דקות"?', '⏳'],

  // --- Extra questions, same style ---
  ['מי הכי סביר לבכות בסרט מצויר?', '🥲'],
  ['מי שר הכי מזייף?', '🎤'],
  ['מי יירדם ראשון במסיבה?', '🥱'],
  ['מי הכי סביר להזמין פיצה ב-3 בלילה?', '🍕'],
  ['מי הכי סביר להשתתף בריאליטי?', '📺'],
  ['מי הכי גרוע בלהסתיר הפתעות?', '🎁'],
  ['מי יתאהב בכלב של מישהו אחר?', '🐶'],
  ['מי רוקד הכי גרוע?', '💃'],
  ['מי צוחק מהבדיחות של עצמו?', '😆'],
  ['מי שוכח למה הוא נכנס לחדר?', '🤔'],
  ['מי מבלה הכי הרבה זמן מול המראה?', '💅'],
  ['מי הכי סביר לבכות מהתרגשות?', '🥹'],
  ['מי תמיד מתלונן שקר לו?', '🥶'],
  ['מי הכי סביר לשרוף את האוכל?', '🔥'],
  ['מי אוכל מהצלחת של אחרים?', '🍟'],
  ['מי שולח הכי הרבה הודעות קוליות?', '🎙️'],
  ['מי הכי סביר לפספס טיסה?', '✈️'],
  ['מי אורז ברגע האחרון?', '🧳'],
  ['מי תמיד שוכח את הסיסמה?', '🔐'],
  ['מי יראה עונה שלמה בלילה אחד?', '🍿'],
  ['מי מתחיל דיאטה כל יום ראשון?', '🥗'],
  ['מי הכי סביר לאמץ חתול מהרחוב?', '🐱'],
  ['מי הכי סביר להיות מפורסם?', '⭐'],
  ['מי יתעשר מרעיון מוזר?', '💡'],
  ['מי מתלבש הכי יפה?', '✨'],
  ['מי מצלם את האוכל לפני שאוכלים?', '📸'],
  ['מי מדבר עם עצמו?', '💬'],
  ['מי שר בקריוקי בלי שום בושה?', '🎶'],
  ['מי מתעצבן כשהוא רעב?', '😤'],
  ['מי לא עונה לשיחה ואז שולח "מה קרה?"', '📞'],
  ['מי קונה הכי הרבה בגדים?', '🛍️'],
  ['מי מתחיל תחביב חדש כל שבוע?', '🎨'],
  ['מי הכי סביר לעשות ספוילר?', '🙊'],
  ['מי הולך לאיבוד גם עם ניווט?', '🗺️'],
  ['מי נרדם עם הטלפון על הפנים?', '📱'],
  ['מי מתעורר הכי עצבני בבוקר?', '☕'],
  ['מי שוכח שמות של אנשים?', '😅'],
  ['מי יעשה ריקוד טיקטוק באמצע הרחוב?', '🕺'],
  ['מי מקבל הכי הרבה לייקים?', '❤️'],
  ['מי הראשון לעלות לרחבה?', '🪩'],
  ['מי קונה את המתנות הכי טובות?', '🎁'],
  ['מי הכי סביר לבכות בחתונה?', '💍'],
  ['מי תמיד שוכח לכבות את האור?', '💡'],
  ['מי הכי סביר לענות "סבבה" ולא להבין כלום?', '👍'],
  ['מי הכי סביר לאכול את הקינוח ראשון?', '🍰'],
];

// ===== QuestionPicker.ts =====
/**
 * Random question picker with a short "recently shown" history.
 *
 * - Never returns the same question twice in a row.
 * - Avoids the last `historySize` questions whenever the pool is big enough.
 */
type RandomFn = () => number;

class QuestionPicker<T> {
  private readonly recent: number[] = [];
  private readonly historySize: number;

  constructor(
    private readonly items: readonly T[],
    historySize = 5,
    private readonly random: RandomFn = Math.random,
  ) {
    if (items.length === 0) {
      throw new Error('QuestionPicker: question list is empty');
    }
    // Keep at least one candidate available (and "no repeat in a row" when possible).
    this.historySize = Math.max(0, Math.min(historySize, items.length - 1));
  }

  /** Returns the next random item. */
  next(): T {
    return this.items[this.nextIndex()];
  }

  /** Returns the index of the next random item (useful for tests). */
  nextIndex(): number {
    const candidates: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      if (this.recent.indexOf(i) === -1) candidates.push(i);
    }
    const pick = candidates[Math.floor(this.random() * candidates.length) % candidates.length];

    this.recent.push(pick);
    while (this.recent.length > this.historySize) this.recent.shift();
    return pick;
  }
}

// ===== TextLayout.ts =====
/**
 * Hebrew text layout helpers:
 *  - wrapBalanced: smart line breaking into at most N balanced lines.
 *  - toVisualOrder: logical → visual reordering for renderers without bidi support.
 *
 * Effect House renderers that already shape RTL correctly should use the logical text
 * as-is ("native" mode). If Hebrew shows up reversed in Preview, switch to "visual" mode.
 */

interface WrappedText {
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
function wrapBalanced(text: string, maxChars: number, maxLines = 3): WrappedText {
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
function toVisualOrder(line: string): string {
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

type HebrewRenderMode = 'native' | 'visual';

/** Produces the final multi-line string for a Text component. */
function formatForRenderer(lines: string[], mode: HebrewRenderMode): string {
  return (mode === 'visual' ? lines.map(toVisualOrder) : lines).join('\n');
}

// ===== GameFlow.ts =====
/**
 * Engine-agnostic game flow for "מי פה? 👀".
 *
 * GameFlow owns the state machine and produces a declarative per-frame view model
 * (opacity / scale / offset / rotation for every UI element + texts). A thin adapter
 * applies that model to the scene — Effect House (GameManager.ts) or the web preview.
 * Keeping all motion here means the preview shows exactly what the effect does.
 *
 * States: INTRO → QUESTION → COUNTDOWN → REVEAL → WAITING_FOR_NEXT → (tap) → QUESTION …
 */

type GameState = 'INTRO' | 'QUESTION' | 'COUNTDOWN' | 'REVEAL' | 'WAITING_FOR_NEXT';

type SoundCue = 'whoosh' | 'tick' | 'now';

interface ElementView {
  opacity: number;
  scale: number;
  /** Offset from the element's anchor, in reference pixels (1080×1920 frame). +y = down. */
  x: number;
  y: number;
  /** Degrees, clockwise. */
  rotation: number;
}

interface BurstParticleView extends ElementView {
  emoji: string;
}

interface GameView {
  overlay: ElementView;
  introTitle: ElementView;
  introSubtitle: ElementView;
  card: ElementView;
  cardGlow: ElementView;
  questionText: ElementView;
  questionEmoji: ElementView;
  countdown: ElementView;
  countdownGlow: ElementView;
  now: ElementView;
  flash: ElementView;
  burst: BurstParticleView[];
  tapHint: ElementView;
  branding: ElementView;

  /** Wrapped question lines (logical order). Changes only when `questionRevision` bumps. */
  questionLines: string[];
  questionEmojiChar: string;
  questionRevision: number;
  countdownLabel: string;
  /** RGB 0–1 accent of the current countdown step (also used for glows). */
  accentColor: readonly [number, number, number];
}

interface GameFlowOptions {
  questions: readonly QuestionEntry[];
  random?: RandomFn;
  historySize?: number;
  burstCount?: number;
  onCue?: (cue: SoundCue, index: number) => void;
  onStateChange?: (state: GameState) => void;
}

interface ShownQuestion {
  entry: QuestionEntry;
  lines: string[];
  fitScale: number;
}

interface BurstSeed {
  angle: number;
  distance: number;
  spin: number;
}

const newElement = (): ElementView => ({ opacity: 0, scale: 1, x: 0, y: 0, rotation: 0 });

const resetElement = (e: ElementView): void => {
  e.opacity = 0;
  e.scale = 1;
  e.x = 0;
  e.y = 0;
  e.rotation = 0;
};

class GameFlow {
  state: GameState = 'INTRO';
  /** Time spent in the current state (ms). */
  private stateTime = 0;
  /** Total running time (ms) — drives idle micro-animations. */
  private clock = 0;
  private lastTickIndex = -1;

  private current: ShownQuestion | null = null;
  private previous: ShownQuestion | null = null;
  private displayed: ShownQuestion | null = null;

  private readonly picker: QuestionPicker<QuestionEntry>;
  private readonly random: RandomFn;
  private readonly burstSeeds: BurstSeed[];
  readonly view: GameView;

  constructor(private readonly options: GameFlowOptions) {
    this.random = options.random ?? Math.random;
    this.picker = new QuestionPicker(options.questions, options.historySize ?? 5, this.random);

    const burstCount = options.burstCount ?? 10;
    this.burstSeeds = [];
    const burst: BurstParticleView[] = [];
    for (let i = 0; i < burstCount; i++) {
      this.burstSeeds.push({ angle: 0, distance: 1, spin: 0 });
      burst.push({ ...newElement(), emoji: BURST_EMOJIS[i % BURST_EMOJIS.length] });
    }

    this.view = {
      overlay: newElement(),
      introTitle: newElement(),
      introSubtitle: newElement(),
      card: newElement(),
      cardGlow: newElement(),
      questionText: newElement(),
      questionEmoji: newElement(),
      countdown: newElement(),
      countdownGlow: newElement(),
      now: newElement(),
      flash: newElement(),
      burst,
      tapHint: newElement(),
      branding: newElement(),
      questionLines: [''],
      questionEmojiChar: DEFAULT_EMOJI,
      questionRevision: 0,
      countdownLabel: '3',
      accentColor: COUNTDOWN_COLORS[0],
    };
    this.computeView();
  }

  /** The question currently in play (null during the intro). */
  get currentQuestion(): QuestionEntry | null {
    return this.current ? this.current.entry : null;
  }

  /**
   * Screen tap. Only accepted while waiting for the next question — taps during
   * animations are ignored, so rapid tapping can never stack countdowns.
   * Returns true if the tap started a new round.
   */
  tap(): boolean {
    if (this.state !== 'WAITING_FOR_NEXT') return false;
    this.stateTime = 0;
    this.beginQuestion();
    return true;
  }

  /** Advances the flow by `deltaMs` and refreshes `view`. */
  update(deltaMs: number): GameView {
    const dt = Math.min(Math.max(deltaMs, 0), TIMING.maxFrameDelta);
    this.clock += dt;
    this.stateTime += dt;

    // Walk through every phase boundary crossed this frame.
    for (let guard = 0; guard < 8; guard++) {
      const duration = this.stateDuration();
      if (this.stateTime < duration) break;
      this.stateTime -= duration;
      this.advance();
    }

    if (this.state === 'COUNTDOWN') {
      const step = Math.min(TIMING.countdownSteps - 1, Math.floor(this.stateTime / TIMING.countdownStep));
      if (step !== this.lastTickIndex) {
        this.lastTickIndex = step;
        this.emitCue('tick', step);
      }
    }

    this.computeView();
    return this.view;
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private stateDuration(): number {
    switch (this.state) {
      case 'INTRO':
        return TIMING.introDuration;
      case 'QUESTION':
        return this.exitDuration() + TIMING.questionEnter + TIMING.questionHold;
      case 'COUNTDOWN':
        return TIMING.countdownStep * TIMING.countdownSteps;
      case 'REVEAL':
        return TIMING.revealDuration;
      case 'WAITING_FOR_NEXT':
        return Infinity;
    }
  }

  private advance(): void {
    switch (this.state) {
      case 'INTRO':
        this.beginQuestion();
        break;
      case 'QUESTION':
        this.setState('COUNTDOWN');
        break;
      case 'COUNTDOWN':
        this.seedBurst();
        this.setState('REVEAL');
        this.emitCue('now', 0);
        break;
      case 'REVEAL':
        this.setState('WAITING_FOR_NEXT');
        break;
      case 'WAITING_FOR_NEXT':
        break;
    }
  }

  private beginQuestion(): void {
    this.previous = this.current;
    const entry = this.picker.next();
    const wrapped = wrapBalanced(entry[0], LAYOUT.questionMaxChars, LAYOUT.questionMaxLines);
    this.current = { entry, lines: wrapped.lines, fitScale: wrapped.fitScale };
    this.setState('QUESTION');
    this.emitCue('whoosh', 0);
  }

  private setState(next: GameState): void {
    this.state = next;
    if (next !== 'COUNTDOWN') this.lastTickIndex = -1;
    if (this.options.onStateChange) this.options.onStateChange(next);
  }

  private exitDuration(): number {
    return this.previous ? TIMING.questionExit : 0;
  }

  private emitCue(cue: SoundCue, index: number): void {
    if (this.options.onCue) this.options.onCue(cue, index);
  }

  private seedBurst(): void {
    const n = this.burstSeeds.length;
    for (let i = 0; i < n; i++) {
      const seed = this.burstSeeds[i];
      // Even spread + jitter, biased away from straight down (keeps the burst compact).
      seed.angle = (i / n) * Math.PI * 2 + (this.random() - 0.5) * 0.5;
      seed.distance = 0.65 + this.random() * 0.45;
      seed.spin = (this.random() - 0.5) * 120;
    }
  }

  // -------------------------------------------------------------------------
  // View model
  // -------------------------------------------------------------------------

  private setDisplayed(q: ShownQuestion | null): void {
    if (!q || q === this.displayed) return;
    this.displayed = q;
    this.view.questionLines = q.lines;
    this.view.questionEmojiChar = q.entry[1] || DEFAULT_EMOJI;
    this.view.questionRevision++;
  }

  private computeView(): void {
    const v = this.view;
    const t = this.stateTime;
    const seconds = this.clock / 1000;
    const float = Math.sin(seconds * Math.PI * 2 / 3.2) * 7;
    const floatTilt = Math.sin(seconds * Math.PI * 2 / 4.1) * 0.6;
    const idleBounce = decay(((seconds % 1.6) / 1.6) * 3); // small hop every 1.6 s

    resetElement(v.introTitle);
    resetElement(v.introSubtitle);
    resetElement(v.card);
    resetElement(v.cardGlow);
    resetElement(v.questionEmoji);
    resetElement(v.countdown);
    resetElement(v.countdownGlow);
    resetElement(v.now);
    resetElement(v.flash);
    resetElement(v.tapHint);
    for (const p of v.burst) resetElement(p);

    v.overlay.opacity = 0.85;
    v.overlay.scale = 1;
    v.branding.opacity = 0.5;
    v.questionText.opacity = 1;
    v.questionText.scale = this.displayed ? this.displayed.fitScale : 1;

    switch (this.state) {
      case 'INTRO': {
        const pop = progress(t, 0, TIMING.introPopIn);
        const out = progress(t, TIMING.introOutStart, TIMING.introDuration - TIMING.introOutStart);
        v.introTitle.opacity = Math.min(1, pop * 2) * (1 - out);
        v.introTitle.scale = lerp(0.55, 1, easeOutBack(pop, 2.2)) * (1 + 0.12 * easeInCubic(out));
        v.introTitle.y = float * 0.6 - 24 * out;
        v.introTitle.rotation = -4 * (1 - easeOutCubic(pop));

        const sub = progress(t, 160, TIMING.introPopIn);
        v.introSubtitle.opacity = easeOutCubic(sub) * (1 - out);
        v.introSubtitle.y = 36 * (1 - easeOutCubic(sub)) + float * 0.6 - 24 * out;
        break;
      }

      case 'QUESTION': {
        const exit = this.exitDuration();
        if (t < exit) {
          // Old question: scale down + fade out, drifting up slightly.
          this.setDisplayed(this.previous);
          const p = t / exit;
          v.card.opacity = 1 - easeOutCubic(p);
          v.card.scale = lerp(1.03, 0.86, easeInCubic(p));
          v.card.y = float - 30 * easeInCubic(p);
          v.cardGlow.opacity = 0.6 * (1 - p);
          v.cardGlow.scale = v.card.scale;
          v.cardGlow.y = v.card.y;
          v.questionEmoji.opacity = v.card.opacity;
          v.questionEmoji.scale = v.card.scale;
          v.questionEmoji.y = v.card.y;
        } else {
          // New question: scale up + fade in with a little overshoot and slide.
          this.setDisplayed(this.current);
          const local = t - exit;
          const p = progress(local, 0, TIMING.questionEnter);
          v.card.opacity = easeOutCubic(Math.min(1, p * 1.6));
          v.card.scale = lerp(0.8, 1, easeOutBack(p, 2.0));
          v.card.y = float + 60 * (1 - easeOutCubic(p));
          v.card.rotation = -3 * (1 - easeOutCubic(p)) + floatTilt;
          v.cardGlow.opacity = 0.28 * easeOutCubic(p);
          v.cardGlow.scale = v.card.scale;
          v.cardGlow.y = v.card.y;

          const e = progress(local, 120, 320);
          v.questionEmoji.opacity = Math.min(1, e * 2);
          v.questionEmoji.scale = easeOutBack(e, 2.6);
          v.questionEmoji.rotation = -24 * (1 - easeOutCubic(e));
          v.questionEmoji.y = v.card.y;
        }
        v.accentColor = COUNTDOWN_COLORS[0];
        break;
      }

      case 'COUNTDOWN': {
        this.setDisplayed(this.current);
        const step = Math.min(TIMING.countdownSteps - 1, Math.floor(t / TIMING.countdownStep));
        const lt = t - step * TIMING.countdownStep;
        const tension = step / (TIMING.countdownSteps - 1); // 0 → 1
        const hit = decay(lt / 240);

        v.card.opacity = 1;
        v.card.scale = 1 + 0.035 * hit;
        v.card.y = float;
        v.card.rotation = floatTilt;
        v.cardGlow.opacity = 0.32 + 0.4 * tension + 0.25 * decay(lt / 320);
        v.cardGlow.scale = v.card.scale * (1 + 0.03 * tension);
        v.cardGlow.y = v.card.y;

        v.questionEmoji.opacity = 1;
        v.questionEmoji.scale = 1 + 0.2 * hit;
        v.questionEmoji.y = v.card.y - 14 * hit;
        v.questionEmoji.rotation = (step % 2 === 0 ? -8 : 8) * hit;

        // The number: scale in → bounce → hold → scale out.
        const inP = progress(lt, 0, 200);
        const settle = progress(lt, 200, 130);
        const outP = progress(lt, 560, TIMING.countdownStep - 560);
        let scale = lerp(0.3, 1.15, easeOutCubic(inP));
        if (lt >= 200) scale = lerp(1.15, 1.0, easeInOutSine(settle));
        if (lt >= 330) scale = lerp(1.0, 1.04, progress(lt, 330, 230));
        if (lt >= 560) scale = lerp(1.04, 1.55, easeInCubic(outP));
        v.countdown.scale = scale * (1 + 0.08 * tension);
        v.countdown.opacity = Math.min(1, inP * 2.5) * (1 - easeInCubic(outP));
        v.countdown.rotation = (step % 2 === 0 ? 8 : -8) * (1 - easeOutCubic(progress(lt, 0, 260)));

        v.countdownGlow.opacity = v.countdown.opacity * (0.45 + 0.35 * tension);
        v.countdownGlow.scale = 0.8 + 0.45 * easeOutCubic(lt / TIMING.countdownStep) + 0.15 * tension;

        v.countdownLabel = String(TIMING.countdownSteps - step);
        v.accentColor = COUNTDOWN_COLORS[Math.min(step, COUNTDOWN_COLORS.length - 1)];
        v.overlay.opacity = 0.85 + 0.12 * tension;
        break;
      }

      case 'REVEAL': {
        this.setDisplayed(this.current);
        const accent = COUNTDOWN_COLORS[COUNTDOWN_COLORS.length - 1];
        v.accentColor = accent;
        v.overlay.opacity = 1 - 0.15 * progress(t, 600, 900);

        // "👉 עכשיו!" pop.
        const pop = progress(t, 0, TIMING.nowPop);
        const out = progress(t, TIMING.nowOutStart, TIMING.revealDuration - TIMING.nowOutStart);
        const pulse = t > TIMING.nowPop ? 0.04 * Math.sin((t - TIMING.nowPop) / 1000 * Math.PI * 2 * 2.2) : 0;
        v.now.opacity = Math.min(1, pop * 3) * (1 - easeInCubic(out));
        v.now.scale = (easeOutBack(pop, 3.2) + pulse) * lerp(1, 0.85, easeInCubic(out));
        v.now.rotation = -12 * (1 - easeOutCubic(pop));
        v.now.y = -40 * easeInCubic(out);

        v.flash.opacity = 0.3 * decay(t / TIMING.flash);

        // Accent shockwave behind "עכשיו!" (reuses the countdown glow).
        const wave = progress(t, 0, 520);
        v.countdownGlow.opacity = 0.95 * decay(wave);
        v.countdownGlow.scale = lerp(0.7, 1.7, easeOutCubic(wave));

        // Card highlight: pop, then settle slightly larger than rest.
        const cardPop = progress(t, 0, 260);
        v.card.opacity = 1;
        v.card.scale = t < 260
          ? lerp(1, 1.08, easeOutBack(cardPop, 2.4))
          : lerp(1.08, 1.04, easeInOutSine(progress(t, 260, 500)));
        v.card.y = float;
        v.card.rotation = floatTilt;
        v.cardGlow.opacity = lerp(1, 0.7, progress(t, 300, 900));
        v.cardGlow.scale = v.card.scale * 1.04;
        v.cardGlow.y = v.card.y;

        const jump = progress(t, 0, 420);
        v.questionEmoji.opacity = 1;
        v.questionEmoji.scale = 1 + 0.3 * bump(jump);
        v.questionEmoji.y = v.card.y - 46 * bump(jump);
        v.questionEmoji.rotation = 14 * bump(jump);

        // Emoji burst from behind "עכשיו!".
        const bp = progress(t, 0, TIMING.burst);
        for (let i = 0; i < v.burst.length; i++) {
          const p = v.burst[i];
          const seed = this.burstSeeds[i];
          // Start on a ring around the label so emojis never sit on top of the text.
          const d = LAYOUT.burstInnerRadius + (LAYOUT.burstRadius * seed.distance - LAYOUT.burstInnerRadius) * easeOutCubic(bp);
          // Wide ellipse: the label is much wider than it is tall.
          p.x = Math.cos(seed.angle) * d * 1.5;
          p.y = Math.sin(seed.angle) * d * 0.75 + 90 * bp * bp; // light gravity
          p.opacity = bp <= 0 || bp >= 1 ? 0 : bp < 0.55 ? Math.min(1, bp * 10) : 1 - (bp - 0.55) / 0.45;
          p.scale = (0.5 + 0.7 * easeOutBack(Math.min(1, bp * 2.5))) * (1 - 0.3 * bp);
          p.rotation = seed.spin * bp;
        }
        break;
      }

      case 'WAITING_FOR_NEXT': {
        this.setDisplayed(this.current);
        const breathe = Math.sin(seconds * Math.PI * 2 / 2.4);
        v.accentColor = COUNTDOWN_COLORS[COUNTDOWN_COLORS.length - 1];
        v.overlay.opacity = 0.85;

        v.card.opacity = 1;
        v.card.scale = lerp(1.04, 1.02, progress(t, 0, 400)) + 0.01 * breathe;
        v.card.y = float;
        v.card.rotation = floatTilt;
        v.cardGlow.opacity = 0.55 + 0.15 * breathe;
        v.cardGlow.scale = v.card.scale * (1.02 + 0.015 * breathe);
        v.cardGlow.y = v.card.y;

        v.questionEmoji.opacity = 1;
        v.questionEmoji.scale = 1 + 0.12 * idleBounce;
        v.questionEmoji.y = v.card.y - 18 * idleBounce;

        const hint = easeOutCubic(progress(t, TIMING.tapHintDelay, TIMING.tapHintFade));
        const hintPulse = Math.sin(seconds * Math.PI * 2 / 1.6);
        v.tapHint.opacity = hint * (0.82 + 0.18 * hintPulse);
        v.tapHint.scale = 1 + 0.025 * hintPulse * hint;
        v.tapHint.y = 16 * (1 - hint);
        break;
      }
    }

    v.overlay.opacity = clamp01(v.overlay.opacity);
  }
}

// ===== SceneNode.ts =====
/**
 * SceneNode — applies an ElementView (opacity / scale / offset / rotation) to an
 * Effect House SceneObject through APJS.
 *
 * APJS property names have shifted between Effect House releases, so every access is
 * feature-detected once in the constructor and cached. Whatever the object doesn't
 * support is skipped silently (e.g. an object without a Text/Image just moves).
 * The object's editor-set position / scale are used as the animation base.
 */

type Rgb = readonly [number, number, number];

// Loosely-typed handles: APJS objects are native bindings, accessed via detected keys.
type AnyObj = { [key: string]: any };

const TRANSFORM_TYPES = ['ScreenTransform', 'Transform'];
const VISUAL_TYPES = ['Text', 'Image', 'ScreenImage', 'Sprite', 'MeshRenderer'];
const POSITION_KEYS = ['localPosition', 'anchoredPosition', 'position'];
const SCALE_KEYS = ['localScale', 'scale'];
const ROTATION_KEYS = ['localEulerAngles', 'localEulerAngle', 'rotation'];

const EPS = 0.0005;

function tryGetComponent(obj: AnyObj | null | undefined, type: string): AnyObj | null {
  if (!obj || typeof obj.getComponent !== 'function') return null;
  try {
    const byName = obj.getComponent(type);
    if (byName) return byName;
  } catch (_) { /* string lookup unsupported in this version */ }
  try {
    const ctor = (APJS as AnyObj)[type];
    if (ctor) return obj.getComponent(ctor) || null;
  } catch (_) { /* type not available */ }
  return null;
}

function firstKey(target: AnyObj | null, keys: string[], test: (v: any) => boolean): string | null {
  if (!target) return null;
  for (const key of keys) {
    try {
      if (key in target && test(target[key])) return key;
    } catch (_) { /* getter threw — skip */ }
  }
  return null;
}

const isVec = (v: any): boolean => v != null && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number';
const isNum = (v: any): boolean => typeof v === 'number';

function makeVec(template: AnyObj, x: number, y: number, z?: number): AnyObj {
  const api = APJS as AnyObj;
  if (typeof template.z === 'number' && api.Vector3f) return new api.Vector3f(x, y, z ?? template.z);
  if (api.Vector2f) return new api.Vector2f(x, y);
  return { x, y };
}

class SceneNode {
  readonly object: AnyObj | null;
  private readonly transform: AnyObj | null;
  private readonly visuals: AnyObj[] = [];
  private readonly text: AnyObj | null;

  private readonly posKey: string | null;
  private readonly scaleKey: string | null;
  private readonly rotKey: string | null;
  private readonly rotIsVector: boolean;
  private readonly alphaMode: ('opacity' | 'alpha' | 'color' | null)[] = [];

  private readonly baseX: number = 0;
  private readonly baseY: number = 0;
  private readonly baseZ: number = 0;
  private readonly baseSX: number = 1;
  private readonly baseSY: number = 1;
  private readonly baseRot: number = 0;
  private readonly baseAlpha: number[] = [];

  private last: ElementView = { opacity: -1, scale: -1, x: NaN, y: NaN, rotation: NaN };
  private lastEnabled: boolean | null = null;
  private lastText: string | null = null;

  /**
   * @param unitsPerPixel scene units per reference pixel (1080×1920 frame).
   * @param toggleEnabled disable the object while fully transparent (saves draw calls).
   */
  constructor(object: AnyObj | null | undefined, private readonly unitsPerPixel = 1, private readonly toggleEnabled = true) {
    this.object = object || null;

    let transform: AnyObj | null = null;
    for (const type of TRANSFORM_TYPES) {
      transform = tryGetComponent(this.object, type);
      if (transform) break;
    }
    this.transform = transform;
    this.posKey = firstKey(transform, POSITION_KEYS, isVec);
    this.scaleKey = firstKey(transform, SCALE_KEYS, isVec);
    this.rotKey = firstKey(transform, ROTATION_KEYS, (v) => isNum(v) || isVec(v));
    this.rotIsVector = this.rotKey != null && isVec((transform as AnyObj)[this.rotKey]);

    if (transform && this.posKey) {
      const p = transform[this.posKey];
      this.baseX = p.x;
      this.baseY = p.y;
      this.baseZ = typeof p.z === 'number' ? p.z : 0;
    }
    if (transform && this.scaleKey) {
      const s = transform[this.scaleKey];
      this.baseSX = s.x;
      this.baseSY = s.y;
    }
    if (transform && this.rotKey) {
      const r = transform[this.rotKey];
      this.baseRot = this.rotIsVector ? r.z : r;
    }

    for (const type of VISUAL_TYPES) {
      const comp = tryGetComponent(this.object, type);
      if (!comp || this.visuals.indexOf(comp) !== -1) continue;
      const mode = firstKey(comp, ['opacity', 'alpha'], isNum) as 'opacity' | 'alpha' | null;
      const colorMode = mode ? null : firstKey(comp, ['color'], (c) => c != null && typeof c.a === 'number');
      this.visuals.push(comp);
      this.alphaMode.push(mode || (colorMode ? 'color' : null));
      this.baseAlpha.push(mode ? comp[mode] : colorMode ? comp.color.a : 1);
    }
    this.text = tryGetComponent(this.object, 'Text');
  }

  get valid(): boolean {
    return this.object != null;
  }

  apply(e: ElementView): void {
    if (!this.object) return;
    const last = this.last;

    if (this.toggleEnabled) {
      const enabled = e.opacity > 0.003;
      if (enabled !== this.lastEnabled) {
        this.lastEnabled = enabled;
        try { this.object.enabled = enabled; } catch (_) { /* not supported */ }
      }
      if (!enabled) return;
    }

    if (Math.abs(e.opacity - last.opacity) > EPS) {
      last.opacity = e.opacity;
      this.setAlpha(e.opacity);
    }

    const t = this.transform;
    if (!t) return;
    if (this.posKey && (Math.abs(e.x - last.x) > EPS || Math.abs(e.y - last.y) > EPS || last.x !== last.x)) {
      last.x = e.x;
      last.y = e.y;
      // Reference frame is y-down; scene space is y-up.
      t[this.posKey] = makeVec(t[this.posKey], this.baseX + e.x * this.unitsPerPixel, this.baseY - e.y * this.unitsPerPixel, this.baseZ);
    }
    if (this.scaleKey && Math.abs(e.scale - last.scale) > EPS) {
      last.scale = e.scale;
      const cur = t[this.scaleKey];
      t[this.scaleKey] = makeVec(cur, this.baseSX * e.scale, this.baseSY * e.scale, typeof cur.z === 'number' ? cur.z : undefined);
    }
    if (this.rotKey && (Math.abs(e.rotation - last.rotation) > EPS || last.rotation !== last.rotation)) {
      last.rotation = e.rotation;
      // Reference rotation is clockwise; scene rotation is counter-clockwise.
      const z = this.baseRot - e.rotation;
      if (this.rotIsVector) {
        const cur = t[this.rotKey];
        t[this.rotKey] = makeVec(cur, cur.x, cur.y, z);
      } else {
        t[this.rotKey] = z;
      }
    }
  }

  setText(value: string): void {
    if (!this.text || value === this.lastText) return;
    this.lastText = value;
    try { this.text.text = value; } catch (_) { /* read-only */ }
  }

  /** Tints the visual (keeps the current alpha). */
  setColor(rgb: Rgb): void {
    const api = APJS as AnyObj;
    for (const comp of this.visuals) {
      try {
        const c = comp.color;
        if (c == null || typeof c.r !== 'number' || !api.Color) continue;
        comp.color = new api.Color(rgb[0], rgb[1], rgb[2], c.a);
      } catch (_) { /* no color */ }
    }
  }

  private setAlpha(opacity: number): void {
    const api = APJS as AnyObj;
    for (let i = 0; i < this.visuals.length; i++) {
      const comp = this.visuals[i];
      const a = this.baseAlpha[i] * opacity;
      try {
        switch (this.alphaMode[i]) {
          case 'opacity': comp.opacity = a; break;
          case 'alpha': comp.alpha = a; break;
          case 'color': {
            const c = comp.color;
            comp.color = api.Color ? new api.Color(c.r, c.g, c.b, a) : { r: c.r, g: c.g, b: c.b, a };
            break;
          }
          default: break;
        }
      } catch (_) { /* unsupported */ }
    }
  }
}

/**
 * Returns the direct children of a SceneObject. APJS exposes children differently across
 * versions (on the object or on its transform), so each known shape is tried in turn.
 */
function getChildren(object: AnyObj | null | undefined): AnyObj[] {
  if (!object) return [];
  const toObject = (c: AnyObj | null): AnyObj | null => {
    if (!c) return null;
    if (typeof c.getComponent === 'function') return c;
    if (typeof c.getSceneObject === 'function') return c.getSceneObject();
    if (c.sceneObject) return c.sceneObject;
    return null;
  };
  const collect = (holder: AnyObj | null): AnyObj[] => {
    if (!holder) return [];
    try {
      const list = typeof holder.getChildren === 'function' ? holder.getChildren() : holder.children;
      if (list && typeof list.length === 'number') {
        const out: AnyObj[] = [];
        for (let i = 0; i < list.length; i++) {
          const o = toObject(list[i]);
          if (o) out.push(o);
        }
        if (out.length) return out;
      }
    } catch (_) { /* not supported */ }
    try {
      const count = typeof holder.getChildCount === 'function' ? holder.getChildCount() : holder.childCount;
      if (typeof count === 'number' && typeof holder.getChild === 'function') {
        const out: AnyObj[] = [];
        for (let i = 0; i < count; i++) {
          const o = toObject(holder.getChild(i));
          if (o) out.push(o);
        }
        return out;
      }
    } catch (_) { /* not supported */ }
    return [];
  };
  const direct = collect(object);
  if (direct.length) return direct;
  for (const type of TRANSFORM_TYPES) {
    const viaTransform = collect(tryGetComponent(object, type));
    if (viaTransform.length) return viaTransform;
  }
  return [];
}

/** Plays a one-shot sound from an Audio object, if one is assigned. */
class SoundPlayer {
  private readonly audio: AnyObj | null;

  constructor(object: AnyObj | null | undefined) {
    this.audio = tryGetComponent(object, 'AudioComponent') || tryGetComponent(object, 'AudioPlayer') || tryGetComponent(object, 'Audio');
  }

  play(): void {
    const a = this.audio;
    if (!a) return;
    try {
      if (typeof a.stop === 'function') a.stop();
      if (typeof a.play === 'function') a.play();
    } catch (_) { /* audio unavailable (e.g. muted preview) */ }
  }
}

// ===== GameManager.ts =====
/**
 * GameManager — Effect House entry point for "מי פה? 👀".
 *
 * Attach to an empty SceneObject named "GameManager" and assign the scene objects in the
 * Inspector (see README.md for the hierarchy). All logic lives in GameFlow; this component
 * only forwards time + taps and applies the resulting view model to the scene.
 */

@component()
export class GameManager extends APJS.BasicScriptComponent {
  // --- Scene objects (drag from the Hierarchy) ---
  @serializeProperty() backgroundOverlay: APJS.SceneObject | null = null;
  @serializeProperty() introTitle: APJS.SceneObject | null = null;
  @serializeProperty() introSubtitle: APJS.SceneObject | null = null;
  @serializeProperty() questionCard: APJS.SceneObject | null = null;
  @serializeProperty() cardGlow: APJS.SceneObject | null = null;
  @serializeProperty() questionText: APJS.SceneObject | null = null;
  @serializeProperty() questionEmoji: APJS.SceneObject | null = null;
  @serializeProperty() countdownText: APJS.SceneObject | null = null;
  @serializeProperty() countdownGlow: APJS.SceneObject | null = null;
  @serializeProperty() nowText: APJS.SceneObject | null = null;
  @serializeProperty() flash: APJS.SceneObject | null = null;
  /** Parent of the burst emoji Text objects — its children are used automatically. */
  @serializeProperty() fxContainer: APJS.SceneObject | null = null;
  @serializeProperty() tapHint: APJS.SceneObject | null = null;
  @serializeProperty() branding: APJS.SceneObject | null = null;

  // --- Optional SFX (Audio objects) ---
  @serializeProperty() sfxWhoosh: APJS.SceneObject | null = null;
  @serializeProperty() sfxTick: APJS.SceneObject | null = null;
  @serializeProperty() sfxNow: APJS.SceneObject | null = null;

  // --- Settings ---
  /** Turn on ONLY if Hebrew appears reversed (mirrored word order) in Preview. */
  @serializeProperty() hebrewVisualOrder: boolean = false;
  /** Scene units per reference pixel (1080×1920). Lower it if motion looks too large. */
  @serializeProperty() motionScale: number = 1;
  @serializeProperty() soundEnabled: boolean = true;
  @serializeProperty() brandingLabel: string = COPY.branding;

  private flow: GameFlow | null = null;
  private nodes: Record<string, SceneNode> = {};
  private burstNodes: SceneNode[] = [];
  private sounds: Record<SoundCue, SoundPlayer | null> = { whoosh: null, tick: null, now: null };
  private lastQuestionRevision = -1;
  private lastCountdownLabel = '';
  private lastAccent: GameView['accentColor'] | null = null;

  onStart(): void {
    const unit = this.motionScale;
    const node = (obj: APJS.SceneObject | null, toggle = true): SceneNode => new SceneNode(obj, unit, toggle);

    this.nodes = {
      // The overlay and branding never fully disappear — no enable toggling needed.
      overlay: node(this.backgroundOverlay, false),
      introTitle: node(this.introTitle),
      introSubtitle: node(this.introSubtitle),
      card: node(this.questionCard),
      cardGlow: node(this.cardGlow),
      questionText: node(this.questionText, false),
      questionEmoji: node(this.questionEmoji),
      countdown: node(this.countdownText),
      countdownGlow: node(this.countdownGlow),
      now: node(this.nowText),
      flash: node(this.flash),
      tapHint: node(this.tapHint),
      branding: node(this.branding, false),
    };
    this.burstNodes = getChildren(this.fxContainer).map((obj) => new SceneNode(obj, unit));

    if (this.soundEnabled) {
      this.sounds = {
        whoosh: new SoundPlayer(this.sfxWhoosh),
        tick: new SoundPlayer(this.sfxTick),
        now: new SoundPlayer(this.sfxNow),
      };
    }

    // Static copy goes through the same Hebrew pipeline as the questions.
    this.nodes.introTitle.setText(this.format(COPY.introTitle));
    this.nodes.introSubtitle.setText(this.format(COPY.introSubtitle));
    this.nodes.now.setText(this.format(COPY.now));
    this.nodes.tapHint.setText(this.format(COPY.tapHint));
    this.nodes.branding.setText(this.brandingLabel);

    this.flow = new GameFlow({
      questions: QUESTIONS,
      burstCount: this.burstNodes.length,
      onCue: (cue) => this.playCue(cue),
    });
    this.burstNodes.forEach((n, i) => n.setText(this.flow!.view.burst[i].emoji));
    this.applyView(this.flow.view);

    APJS.EventManager.getGlobalEmitter().on(APJS.EventType.Touch, this.onTouch);
  }

  onUpdate(deltaTime: number): void {
    if (!this.flow) return;
    // APJS passes seconds; guard against runtimes that pass milliseconds.
    const deltaMs = deltaTime > 5 ? deltaTime : deltaTime * 1000;
    this.applyView(this.flow.update(Math.min(deltaMs, TIMING.maxFrameDelta)));
  }

  onDestroy(): void {
    APJS.EventManager.getGlobalEmitter().off(APJS.EventType.Touch, this.onTouch);
    this.flow = null;
  }

  /** Arrow function so `this` stays bound when used as an event listener. */
  private onTouch = (event: APJS.IEvent): void => {
    if (!this.flow) return;
    const touch = event && event.args ? (event.args[0] as APJS.TouchData) : null;
    // Only the first finger-down counts; moves/ends/multi-touch are ignored.
    if (!touch || touch.phase !== APJS.TouchPhase.Began) return;
    this.flow.tap();
  };

  private format(text: string): string {
    const mode: HebrewRenderMode = this.hebrewVisualOrder ? 'visual' : 'native';
    return formatForRenderer([text], mode);
  }

  private playCue(cue: SoundCue): void {
    const player = this.sounds[cue];
    if (player) player.play();
  }

  private applyView(view: GameView): void {
    const n = this.nodes;

    if (view.questionRevision !== this.lastQuestionRevision) {
      this.lastQuestionRevision = view.questionRevision;
      const mode: HebrewRenderMode = this.hebrewVisualOrder ? 'visual' : 'native';
      n.questionText.setText(formatForRenderer(view.questionLines, mode));
      n.questionEmoji.setText(view.questionEmojiChar);
    }
    if (view.countdownLabel !== this.lastCountdownLabel) {
      this.lastCountdownLabel = view.countdownLabel;
      n.countdown.setText(view.countdownLabel);
    }
    if (view.accentColor !== this.lastAccent) {
      this.lastAccent = view.accentColor;
      n.countdown.setColor(view.accentColor);
      n.countdownGlow.setColor(view.accentColor);
      n.cardGlow.setColor(view.accentColor);
    }

    n.overlay.apply(view.overlay);
    n.introTitle.apply(view.introTitle);
    n.introSubtitle.apply(view.introSubtitle);
    n.card.apply(view.card);
    n.cardGlow.apply(view.cardGlow);
    n.questionText.apply(view.questionText);
    n.questionEmoji.apply(view.questionEmoji);
    n.countdown.apply(view.countdown);
    n.countdownGlow.apply(view.countdownGlow);
    n.now.apply(view.now);
    n.flash.apply(view.flash);
    n.tapHint.apply(view.tapHint);
    n.branding.apply(view.branding);
    for (let i = 0; i < this.burstNodes.length; i++) this.burstNodes[i].apply(view.burst[i]);
  }
}
