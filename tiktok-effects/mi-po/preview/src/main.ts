/**
 * Web preview for "מי פה? 👀" — runs the exact same GameFlow as the Effect House script
 * and renders its view model with DOM/CSS in a 9:16 frame over the webcam (or a demo
 * backdrop). Used to check motion, Hebrew rendering, safe areas and tap handling.
 */
import { COPY, LAYOUT, REFERENCE_HEIGHT, REFERENCE_WIDTH } from '../../Scripts/GameConfig';
import { ElementView, GameFlow, GameView, SoundCue } from '../../Scripts/GameFlow';
import { QUESTIONS } from '../../Scripts/Questions';

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stage = $('stage');
const frame = $('frame');
const assetBase = document.body.dataset.assets || '../Assets/';

// ---------------------------------------------------------------------------
// Scene construction (mirrors the Effect House hierarchy)
// ---------------------------------------------------------------------------

interface Anchor { x: number; y: number }

function el(id: string, className: string, anchor: Anchor, parent: HTMLElement = stage, text = ''): HTMLElement {
  const node = document.createElement('div');
  node.id = id;
  node.className = `node ${className}`;
  node.style.left = `${anchor.x}px`;
  node.style.top = `${anchor.y}px`;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

const center: Anchor = { x: REFERENCE_WIDTH / 2, y: REFERENCE_HEIGHT / 2 };
const fx = { x: LAYOUT.now.x, y: LAYOUT.now.y };

const nodes = {
  overlay: el('BackgroundOverlay', 'overlay', center),
  flash: el('Flash', 'flash', center),
  introTitle: el('IntroTitle', 'intro-title', LAYOUT.intro, stage, COPY.introTitle),
  introSubtitle: el('IntroSubtitle', 'intro-subtitle', LAYOUT.introSubtitle, stage, COPY.introSubtitle),
  cardGlow: el('CardGlow', 'card-glow tint', LAYOUT.card),
  card: el('QuestionCard', 'card', LAYOUT.card),
  questionEmoji: el('QuestionEmoji', 'question-emoji', LAYOUT.questionEmoji),
  countdownGlow: el('CountdownGlow', 'countdown-glow tint', LAYOUT.countdown),
  countdown: el('CountdownText', 'countdown', LAYOUT.countdown, stage, '3'),
  // FXContainer sits behind "עכשיו!" so the burst never covers the label.
  fx: el('FXContainer', 'fx', fx),
  now: el('NowText', 'now', LAYOUT.now, stage, COPY.now),
  tapHint: el('TapHint', 'tap-hint', LAYOUT.tapHint, stage, COPY.tapHint),
  branding: el('Branding', 'branding', LAYOUT.branding, stage, COPY.branding),
};
const questionText = el('QuestionText', 'question-text', { x: 0, y: 0 }, nodes.card);
questionText.style.left = '50%';
questionText.style.top = '50%';
questionText.setAttribute('dir', 'rtl');
for (const n of [nodes.introTitle, nodes.introSubtitle, nodes.now, nodes.tapHint]) n.setAttribute('dir', 'rtl');

const fxContainer = nodes.fx;
fxContainer.style.visibility = 'visible';

const flow = new GameFlow({
  questions: QUESTIONS,
  burstCount: 10,
  onCue: (cue) => sound.play(cue),
});
const burstNodes = flow.view.burst.map((p, i) => el(`BurstEmoji_${i + 1}`, 'burst', { x: 0, y: 0 }, fxContainer, p.emoji));

// ---------------------------------------------------------------------------
// View application
// ---------------------------------------------------------------------------

function apply(node: HTMLElement, e: ElementView): void {
  const visible = e.opacity > 0.003;
  node.style.visibility = visible ? 'visible' : 'hidden';
  if (!visible) return;
  node.style.opacity = e.opacity.toFixed(3);
  node.style.transform =
    `translate(-50%, -50%) translate(${e.x.toFixed(1)}px, ${e.y.toFixed(1)}px) rotate(${e.rotation.toFixed(2)}deg) scale(${e.scale.toFixed(4)})`;
}

let lastRevision = -1;
let lastAccent: GameView['accentColor'] | null = null;

function render(v: GameView): void {
  if (v.questionRevision !== lastRevision) {
    lastRevision = v.questionRevision;
    questionText.innerHTML = '';
    for (const line of v.questionLines) {
      const span = document.createElement('span');
      span.textContent = line;
      questionText.appendChild(span);
    }
    nodes.questionEmoji.textContent = v.questionEmojiChar;
  }
  if (nodes.countdown.textContent !== v.countdownLabel) nodes.countdown.textContent = v.countdownLabel;
  if (v.accentColor !== lastAccent) {
    lastAccent = v.accentColor;
    const [r, g, b] = v.accentColor.map((c) => Math.round(c * 255));
    frame.style.setProperty('--accent', `rgb(${r}, ${g}, ${b})`);
  }

  // Question text only carries the auto-fit scale (it's a child of the card).
  questionText.style.transform = `translate(-50%, -50%) scale(${v.questionText.scale.toFixed(3)})`;

  apply(nodes.overlay, v.overlay);
  apply(nodes.flash, v.flash);
  apply(nodes.introTitle, v.introTitle);
  apply(nodes.introSubtitle, v.introSubtitle);
  apply(nodes.cardGlow, v.cardGlow);
  apply(nodes.card, v.card);
  apply(nodes.questionEmoji, v.questionEmoji);
  apply(nodes.countdownGlow, v.countdownGlow);
  apply(nodes.countdown, v.countdown);
  apply(nodes.now, v.now);
  apply(nodes.tapHint, v.tapHint);
  apply(nodes.branding, v.branding);
  for (let i = 0; i < burstNodes.length; i++) apply(burstNodes[i], v.burst[i]);
}

// ---------------------------------------------------------------------------
// Sound (Web Audio; unlocked on the first tap, effect works fine muted)
// ---------------------------------------------------------------------------

const sound = (() => {
  let ctx: AudioContext | null = null;
  const buffers: Partial<Record<SoundCue, AudioBuffer>> = {};
  let muted = params.get('mute') === '1';
  const files: Record<SoundCue, string> = { whoosh: 'sfx_whoosh.wav', tick: 'sfx_tick.wav', now: 'sfx_now.wav' };

  async function unlock(): Promise<void> {
    if (ctx || muted) return;
    try {
      ctx = new AudioContext();
      await Promise.all((Object.keys(files) as SoundCue[]).map(async (cue) => {
        const res = await fetch(`${assetBase}Audio/${files[cue]}`);
        buffers[cue] = await ctx!.decodeAudioData(await res.arrayBuffer());
      }));
    } catch (_) {
      ctx = null; // no audio available — silently continue
    }
  }
  function play(cue: SoundCue): void {
    const buf = buffers[cue];
    if (!ctx || !buf || muted) return;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = cue === 'whoosh' ? 0.5 : 0.8;
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }
  return {
    unlock, play,
    toggle(): boolean { muted = !muted; if (!muted) void unlock(); return muted; },
    get muted(): boolean { return muted; },
  };
})();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

let taps = 0;
let acceptedTaps = 0;
function onTap(): void {
  void sound.unlock();
  taps++;
  if (flow.tap()) acceptedTaps++;
}
stage.addEventListener('pointerdown', (e) => { e.preventDefault(); onTap(); });
window.addEventListener('keydown', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); onTap(); } });

// ---------------------------------------------------------------------------
// Camera / backdrop
// ---------------------------------------------------------------------------

const video = $<HTMLVideoElement>('camera');
async function startCamera(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1080, height: 1920 }, audio: false });
    video.srcObject = stream;
    await video.play();
    frame.classList.add('has-camera');
    return true;
  } catch (_) {
    frame.classList.remove('has-camera');
    return false;
  }
}

const toolbar = {
  camera: document.getElementById('btn-camera'),
  safe: document.getElementById('btn-safe'),
  sound: document.getElementById('btn-sound'),
};
toolbar.camera?.addEventListener('click', async () => {
  const ok = await startCamera();
  toolbar.camera!.textContent = ok ? '📷 מצלמה פעילה' : '📷 אין גישה למצלמה';
});
toolbar.safe?.addEventListener('click', () => {
  frame.classList.toggle('show-safe');
  toolbar.safe!.setAttribute('aria-pressed', String(frame.classList.contains('show-safe')));
});
toolbar.sound?.addEventListener('click', () => {
  const m = sound.toggle();
  toolbar.sound!.textContent = m ? '🔇 סאונד כבוי' : '🔊 סאונד פעיל';
});
if (params.get('safe') === '1') frame.classList.add('show-safe');
if (params.get('camera') === '1') void startCamera();

// ---------------------------------------------------------------------------
// Fit the 1080×1920 stage into the frame & run the loop
// ---------------------------------------------------------------------------

function fit(): void {
  const scale = frame.clientWidth / REFERENCE_WIDTH;
  stage.style.transform = `scale(${scale})`;
}
new ResizeObserver(fit).observe(frame);
fit();

// Deterministic stepping for automated checks: ?manual=1 disables the RAF loop.
const manual = params.get('manual') === '1';
let lastTime = performance.now();
function frameLoop(now: number): void {
  render(flow.update(now - lastTime));
  lastTime = now;
  requestAnimationFrame(frameLoop);
}
render(flow.view);
if (!manual) requestAnimationFrame(frameLoop);

// Test hook (used by the Playwright checks in tools/preview-check.mjs).
(window as unknown as Record<string, unknown>).__miPo = {
  flow,
  step(ms: number, frameMs = 16): string {
    for (let t = 0; t < ms; t += frameMs) render(flow.update(frameMs));
    return flow.state;
  },
  tap: onTap,
  stats: () => ({ state: flow.state, taps, acceptedTaps, question: flow.currentQuestion }),
};
