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
import {
  bump, clamp01, decay, easeInCubic, easeInOutSine, easeOutBack, easeOutCubic, lerp, progress,
} from './Easing';
import { BURST_EMOJIS, COUNTDOWN_COLORS, LAYOUT, TIMING } from './GameConfig';
import { DEFAULT_EMOJI, QuestionEntry } from './Questions';
import { QuestionPicker, RandomFn } from './QuestionPicker';
import { wrapBalanced } from './TextLayout';

export type GameState = 'INTRO' | 'QUESTION' | 'COUNTDOWN' | 'REVEAL' | 'WAITING_FOR_NEXT';

export type SoundCue = 'whoosh' | 'tick' | 'now';

export interface ElementView {
  opacity: number;
  scale: number;
  /** Offset from the element's anchor, in reference pixels (1080×1920 frame). +y = down. */
  x: number;
  y: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export interface BurstParticleView extends ElementView {
  emoji: string;
}

export interface GameView {
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

export interface GameFlowOptions {
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

export class GameFlow {
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
