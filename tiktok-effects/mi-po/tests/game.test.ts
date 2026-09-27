import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameFlow, GameState, SoundCue } from '../Scripts/GameFlow';
import { TIMING } from '../Scripts/GameConfig';
import { QUESTIONS } from '../Scripts/Questions';
import { QuestionPicker } from '../Scripts/QuestionPicker';
import { toVisualOrder, wrapBalanced } from '../Scripts/TextLayout';

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const run = (flow: GameFlow, ms: number, step = 16): void => {
  for (let t = 0; t < ms; t += step) flow.update(step);
};

test('question bank: at least 80 unique, non-empty questions', () => {
  assert.ok(QUESTIONS.length >= 80, `only ${QUESTIONS.length} questions`);
  const texts = QUESTIONS.map((q) => q[0]);
  assert.equal(new Set(texts).size, texts.length, 'duplicate question text');
  for (const [text] of QUESTIONS) assert.match(text, /^מי /, `should start with "מי": ${text}`);
});

test('picker: never repeats within the last 5 picks', () => {
  const picker = new QuestionPicker(QUESTIONS, 5, seeded(42));
  const history: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const idx = picker.nextIndex();
    assert.ok(!history.slice(-5).includes(idx), `repeat of ${idx} at pick ${i}`);
    history.push(idx);
  }
  // Reasonably uniform: every question shows up.
  assert.equal(new Set(history).size, QUESTIONS.length);
});

test('picker: tiny pools still avoid immediate repeats', () => {
  const picker = new QuestionPicker(['a', 'b'], 5, seeded(1));
  let prev = picker.next();
  for (let i = 0; i < 200; i++) {
    const next = picker.next();
    assert.notEqual(next, prev);
    prev = next;
  }
  assert.throws(() => new QuestionPicker([], 5));
});

test('flow: INTRO → QUESTION → COUNTDOWN → REVEAL → WAITING, with cues', () => {
  const states: GameState[] = [];
  const cues: string[] = [];
  const flow = new GameFlow({
    questions: QUESTIONS,
    random: seeded(7),
    onStateChange: (s) => states.push(s),
    onCue: (c: SoundCue, i) => cues.push(c === 'tick' ? `tick${i}` : c),
  });
  assert.equal(flow.state, 'INTRO');
  run(flow, 1400);
  assert.equal(flow.state, 'INTRO', 'intro lasts ~1.5 s');
  run(flow, 200);
  assert.equal(flow.state, 'QUESTION');
  run(flow, 12000);
  assert.equal(flow.state, 'WAITING_FOR_NEXT', 'waits for a tap, never auto-advances');
  assert.deepEqual(states, ['QUESTION', 'COUNTDOWN', 'REVEAL', 'WAITING_FOR_NEXT']);
  assert.deepEqual(cues, ['whoosh', 'tick0', 'tick1', 'tick2', 'now']);
});

test('flow: countdown shows 3, 2, 1 in order', () => {
  const flow = new GameFlow({ questions: QUESTIONS, random: seeded(3) });
  while (flow.state !== 'COUNTDOWN') flow.update(16);
  const labels: string[] = [];
  while (flow.state === 'COUNTDOWN') {
    const v = flow.update(16);
    if (flow.state === 'COUNTDOWN' && labels[labels.length - 1] !== v.countdownLabel) labels.push(v.countdownLabel);
  }
  assert.deepEqual(labels, ['3', '2', '1']);
});

test('flow: taps are ignored during animations (no stacked countdowns)', () => {
  let ticks = 0;
  let whooshes = 0;
  const flow = new GameFlow({
    questions: QUESTIONS,
    random: seeded(9),
    onCue: (c) => { if (c === 'tick') ticks++; if (c === 'whoosh') whooshes++; },
  });
  // Hammer the screen every frame through intro, question, countdown and reveal.
  let accepted = 0;
  while (flow.state !== 'WAITING_FOR_NEXT') {
    if (flow.tap()) accepted++;
    flow.update(16);
  }
  assert.equal(accepted, 0);
  assert.equal(ticks, 3);
  assert.equal(whooshes, 1);

  // Burst of 10 taps in the same frame while waiting → exactly one new round.
  const before = flow.currentQuestion;
  let results = 0;
  for (let i = 0; i < 10; i++) if (flow.tap()) results++;
  assert.equal(results, 1);
  assert.equal(flow.state, 'QUESTION');
  assert.notEqual(flow.currentQuestion, before, 'new question differs from the previous one');
  run(flow, 6000);
  assert.equal(ticks, 6, 'second round ran exactly one countdown');
});

test('flow: 300 rapid rounds never show the same question twice in a row', () => {
  const flow = new GameFlow({ questions: QUESTIONS, random: seeded(11) });
  let prev = null as unknown;
  for (let round = 0; round < 300; round++) {
    while (flow.state !== 'WAITING_FOR_NEXT') flow.update(33);
    const q = flow.currentQuestion;
    assert.notEqual(q, prev);
    prev = q;
    flow.tap();
  }
});

test('flow: huge frame hitches are clamped, view values stay finite', () => {
  const flow = new GameFlow({ questions: QUESTIONS, random: seeded(5) });
  flow.update(10_000);
  assert.equal(flow.state, 'INTRO', `clamped to ${TIMING.maxFrameDelta} ms`);
  for (let i = 0; i < 2000; i++) {
    const v = flow.update(i % 7 === 0 ? 100 : 8);
    for (const key of ['card', 'countdown', 'now', 'tapHint', 'introTitle', 'questionEmoji'] as const) {
      const e = v[key];
      for (const n of [e.opacity, e.scale, e.x, e.y, e.rotation]) assert.ok(Number.isFinite(n), `${key} not finite`);
      assert.ok(e.opacity >= 0 && e.opacity <= 1.0001, `${key}.opacity out of range: ${e.opacity}`);
    }
    if ((flow.state as string) === 'WAITING_FOR_NEXT') flow.tap();
  }
});

test('layout: every question fits in ≤ 3 lines and stays legible', () => {
  for (const [text] of QUESTIONS) {
    const w = wrapBalanced(text, 15, 3);
    assert.ok(w.lines.length <= 3, text);
    assert.equal(w.lines.join(' '), text.trim().split(/\s+/).join(' '), 'no words lost');
    assert.ok(w.fitScale >= 0.75, `too long (${w.fitScale.toFixed(2)}): ${text}`);
  }
  assert.deepEqual(wrapBalanced('מי הכי מצחיק?', 15).lines, ['מי הכי מצחיק?']);
});

test('bidi: visual order keeps numbers and emoji intact', () => {
  assert.equal(toVisualOrder('שלום עולם'), 'םלוע םולש');
  assert.equal(toVisualOrder('רק עוד 5 דקות'), 'תוקד 5 דוע קר');
  assert.equal(toVisualOrder('ב-3...2...1'), '1...2...3-ב');
  assert.equal(toVisualOrder('👉 עכשיו!'), '!וישכע 👉');
  assert.equal(toVisualOrder('מי פה? 👀'), '👀 ?הפ ימ');
  assert.equal(toVisualOrder('Created by AiSolution'), 'Created by AiSolution');
  assert.equal(toVisualOrder('(שלום)'), '(םולש)');
});
