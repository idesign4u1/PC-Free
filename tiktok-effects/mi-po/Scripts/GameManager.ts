/**
 * GameManager — Effect House entry point for "מי פה? 👀".
 *
 * Attach to an empty SceneObject named "GameManager" and assign the scene objects in the
 * Inspector (see README.md for the hierarchy). All logic lives in GameFlow; this component
 * only forwards time + taps and applies the resulting view model to the scene.
 */
import { COPY, TIMING } from './GameConfig';
import { GameFlow, GameView, SoundCue } from './GameFlow';
import { QUESTIONS } from './Questions';
import { SceneNode, SoundPlayer } from './SceneNode';
import { formatForRenderer, HebrewRenderMode } from './TextLayout';

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
  @serializeProperty() burstParticles: APJS.SceneObject[] = [];
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
    this.burstNodes = (this.burstParticles || []).map((obj) => node(obj));

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
