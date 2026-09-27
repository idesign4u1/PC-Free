/**
 * Timings (ms), layout and copy for "מי פה? 👀".
 * Positions are in a 1080×1920 (9:16) reference frame, measured from the top-left.
 */
export const REFERENCE_WIDTH = 1080;
export const REFERENCE_HEIGHT = 1920;

export const TIMING = {
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
export const LAYOUT = {
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

export const COPY = {
  introTitle: 'מי פה? 👀',
  introSubtitle: 'תצביעו עליו ב-3...2...1',
  now: '👉 עכשיו!',
  tapHint: 'נגיעה למסך לשאלה הבאה 👀',
  branding: 'Created by AiSolution',
} as const;

/** Emojis thrown in the "עכשיו!" burst (cycled over the burst particles). */
export const BURST_EMOJIS = ['😂', '👀', '👉', '🔥', '✨', '😱'] as const;

/** Countdown accent colors (RGB 0–1): warm → hot as tension rises. */
export const COUNTDOWN_COLORS: readonly (readonly [number, number, number])[] = [
  [0.55, 0.85, 1.0], // 3 — cool cyan
  [1.0, 0.78, 0.25], // 2 — amber
  [1.0, 0.25, 0.45], // 1 — hot pink
];
