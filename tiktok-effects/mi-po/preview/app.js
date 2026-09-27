"use strict";
(() => {
  // Scripts/GameConfig.ts
  var REFERENCE_WIDTH = 1080;
  var REFERENCE_HEIGHT = 1920;
  var TIMING = {
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
    tapHintDelay: 1e3,
    tapHintFade: 320,
    /** Frame-time clamp so a hitch never skips a whole phase. */
    maxFrameDelta: 100
  };
  var LAYOUT = {
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
    burstInnerRadius: 230
  };
  var COPY = {
    introTitle: "\u05DE\u05D9 \u05E4\u05D4? \u{1F440}",
    introSubtitle: "\u05EA\u05E6\u05D1\u05D9\u05E2\u05D5 \u05E2\u05DC\u05D9\u05D5 \u05D1-3...2...1",
    now: "\u{1F449} \u05E2\u05DB\u05E9\u05D9\u05D5!",
    tapHint: "\u05E0\u05D2\u05D9\u05E2\u05D4 \u05DC\u05DE\u05E1\u05DA \u05DC\u05E9\u05D0\u05DC\u05D4 \u05D4\u05D1\u05D0\u05D4 \u{1F440}",
    branding: "Created by AiSolution"
  };
  var BURST_EMOJIS = ["\u{1F602}", "\u{1F440}", "\u{1F449}", "\u{1F525}", "\u2728", "\u{1F631}"];
  var COUNTDOWN_COLORS = [
    [0.55, 0.85, 1],
    // 3 — cool cyan
    [1, 0.78, 0.25],
    // 2 — amber
    [1, 0.25, 0.45]
    // 1 — hot pink
  ];

  // Scripts/Easing.ts
  var clamp01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
  var lerp = (a, b, t) => a + (b - a) * t;
  var progress = (t, start, duration) => duration <= 0 ? t >= start ? 1 : 0 : clamp01((t - start) / duration);
  var easeOutCubic = (t) => {
    const u = 1 - clamp01(t);
    return 1 - u * u * u;
  };
  var easeInCubic = (t) => {
    const c = clamp01(t);
    return c * c * c;
  };
  var easeInOutSine = (t) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
  var easeOutBack = (t, overshoot = 1.70158) => {
    const c = clamp01(t) - 1;
    return 1 + (overshoot + 1) * c * c * c + overshoot * c * c;
  };
  var bump = (t) => Math.sin(Math.PI * clamp01(t));
  var decay = (t) => {
    const u = 1 - clamp01(t);
    return u * u;
  };

  // Scripts/Questions.ts
  var DEFAULT_EMOJI = "\u{1F440}";
  var QUESTIONS = [
    // --- Core list ---
    ["\u05DE\u05D9 \u05E4\u05D4 \u05D4\u05DB\u05D9 \u05E7\u05DE\u05E6\u05DF?", "\u{1F602}"],
    ["\u05DE\u05D9 \u05EA\u05DE\u05D9\u05D3 \u05DE\u05D0\u05D7\u05E8?", "\u23F0"],
    ["\u05DE\u05D9 \u05DE\u05D1\u05D6\u05D1\u05D6 \u05D9\u05D5\u05EA\u05E8 \u05DB\u05E1\u05E3?", "\u{1F4B8}"],
    ["\u05DE\u05D9 \u05D9\u05D5\u05EA\u05E8 \u05E7\u05E0\u05D0\u05D9?", "\u{1F440}"],
    ["\u05DE\u05D9 \u05DE\u05EA\u05D0\u05D4\u05D1 \u05E8\u05D0\u05E9\u05D5\u05DF?", "\u2764\uFE0F"],
    ["\u05DE\u05D9 \u05D9\u05D5\u05EA\u05E8 \u05D3\u05E8\u05DE\u05D8\u05D9?", "\u{1F3AD}"],
    ["\u05DE\u05D9 \u05DC\u05D0 \u05DE\u05E1\u05D5\u05D2\u05DC \u05DC\u05E9\u05DE\u05D5\u05E8 \u05E1\u05D5\u05D3?", "\u{1F910}"],
    ["\u05DE\u05D9 \u05D9\u05E0\u05E6\u05D7 \u05D1\u05D5\u05D5\u05D9\u05DB\u05D5\u05D7 \u05D2\u05DD \u05DB\u05E9\u05D4\u05D5\u05D0 \u05D8\u05D5\u05E2\u05D4?", "\u{1F602}"],
    ["\u05DE\u05D9 \u05D9\u05E9\u05E8\u05D5\u05D3 \u05D9\u05D5\u05EA\u05E8 \u05D6\u05DE\u05DF \u05D1\u05DC\u05D9 \u05D8\u05DC\u05E4\u05D5\u05DF?", "\u{1F4F1}"],
    ["\u05DE\u05D9 \u05D9\u05D2\u05D9\u05E2 \u05E8\u05D0\u05E9\u05D5\u05DF \u05DC\u05DE\u05D9\u05DC\u05D9\u05D5\u05DF?", "\u{1F4B0}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05DE\u05E4\u05D5\u05E0\u05E7?", "\u{1F451}"],
    ["\u05DE\u05D9 \u05D0\u05D5\u05DB\u05DC \u05D4\u05DB\u05D9 \u05D4\u05E8\u05D1\u05D4?", "\u{1F354}"],
    ["\u05DE\u05D9 \u05E7\u05DD \u05D4\u05DB\u05D9 \u05DE\u05D0\u05D5\u05D7\u05E8?", "\u{1F634}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05DE\u05DB\u05D5\u05E8 \u05DC\u05D8\u05DC\u05E4\u05D5\u05DF?", "\u{1F4F1}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05DE\u05E6\u05D7\u05D9\u05E7?", "\u{1F923}"],
    ["\u05DE\u05D9 \u05D9\u05EA\u05D7\u05D9\u05DC \u05E8\u05D9\u05D1 \u05E8\u05D0\u05E9\u05D5\u05DF?", "\u{1F624}"],
    ["\u05DE\u05D9 \u05D9\u05EA\u05E0\u05E6\u05DC \u05E8\u05D0\u05E9\u05D5\u05DF?", "\u{1F97A}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E2\u05E7\u05E9\u05DF?", "\u{1F410}"],
    ["\u05DE\u05D9 \u05D9\u05D5\u05EA\u05E8 \u05E8\u05D5\u05DE\u05E0\u05D8\u05D9?", "\u2764\uFE0F"],
    ["\u05DE\u05D9 \u05D9\u05D5\u05EA\u05E8 \u05E4\u05D7\u05D3\u05DF?", "\u{1F628}"],
    ["\u05DE\u05D9 \u05D9\u05DB\u05D5\u05DC \u05DC\u05D4\u05D9\u05E8\u05D3\u05DD \u05D1\u05DB\u05DC \u05DE\u05E7\u05D5\u05DD?", "\u{1F634}"],
    ["\u05DE\u05D9 \u05D9\u05D1\u05E8\u05D7 \u05E8\u05D0\u05E9\u05D5\u05DF \u05DE\u05E1\u05E8\u05D8 \u05D0\u05D9\u05DE\u05D4?", "\u{1F631}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05E9\u05DB\u05D7 \u05D9\u05D5\u05DD \u05D4\u05D5\u05DC\u05D3\u05EA?", "\u{1F382}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05D6\u05DB\u05D4 \u05D1\u05DC\u05D5\u05D8\u05D5?", "\u{1F340}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05D1\u05D6\u05D1\u05D6 \u05D0\u05EA \u05DB\u05DC \u05DB\u05E1\u05E4\u05D9 \u05D4\u05D6\u05DB\u05D9\u05D9\u05D4?", "\u{1F4B8}"],
    ["\u05DE\u05D9 \u05D9\u05D2\u05D9\u05E2 \u05E8\u05D0\u05E9\u05D5\u05DF \u05DC\u05D7\u05EA\u05D5\u05E0\u05D4?", "\u{1F48D}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05EA\u05D7\u05EA\u05DF \u05D1\u05DC\u05D9 \u05DC\u05E1\u05E4\u05E8 \u05DC\u05D0\u05E3 \u05D0\u05D7\u05D3?", "\u{1F92B}"],
    ["\u05DE\u05D9 \u05DE\u05DB\u05D9\u05E8 \u05D0\u05EA \u05D4\u05E9\u05E0\u05D9 \u05D9\u05D5\u05EA\u05E8 \u05D8\u05D5\u05D1?", "\u{1F9E0}"],
    ["\u05DE\u05D9 \u05DE\u05D3\u05D1\u05E8 \u05D9\u05D5\u05EA\u05E8?", "\u{1F5E3}\uFE0F"],
    ["\u05DE\u05D9 \u05E2\u05D5\u05E9\u05D4 \u05D9\u05D5\u05EA\u05E8 \u05E4\u05D3\u05D9\u05D7\u05D5\u05EA?", "\u{1F648}"],
    ["\u05DE\u05D9 \u05DE\u05E6\u05DC\u05DD \u05D9\u05D5\u05EA\u05E8 \u05E1\u05DC\u05E4\u05D9?", "\u{1F933}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D4\u05E4\u05D5\u05DA \u05DC\u05D5\u05D5\u05D9\u05E8\u05D0\u05DC\u05D9 \u05D1\u05D8\u05D9\u05E7\u05D8\u05D5\u05E7?", "\u{1F680}"],
    ["\u05DE\u05D9 \u05DE\u05D5\u05D7\u05E7 \u05D4\u05D5\u05D3\u05E2\u05D4 \u05D0\u05D7\u05E8\u05D9 \u05E9\u05E9\u05DC\u05D7 \u05D0\u05D5\u05EA\u05D4?", "\u{1FAE3}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05E2\u05E9\u05D4 \u05E1\u05D8\u05D5\u05E7\u05D9\u05E0\u05D2 \u05D1\u05D0\u05D9\u05E0\u05E1\u05D8\u05D2\u05E8\u05DD?", "\u{1F440}"],
    ['\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05D2\u05D9\u05D3 "\u05D0\u05E0\u05D9 \u05D1\u05D3\u05E8\u05DA" \u05DB\u05E9\u05D4\u05D5\u05D0 \u05E2\u05D3\u05D9\u05D9\u05DF \u05D1\u05D1\u05D9\u05EA?', "\u{1F3E0}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E8\u05E2\u05D1 \u05DB\u05E8\u05D2\u05E2?", "\u{1F924}"],
    ["\u05DE\u05D9 \u05DE\u05D6\u05DE\u05D9\u05DF \u05D9\u05D5\u05EA\u05E8 \u05D0\u05D5\u05DB\u05DC?", "\u{1F6F5}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05DE\u05E1\u05D5\u05D3\u05E8?", "\u{1F9F9}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05DE\u05D1\u05D5\u05DC\u05D2\u05DF?", "\u{1F32A}\uFE0F"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05D0\u05D1\u05D3 \u05D0\u05EA \u05D4\u05DE\u05E4\u05EA\u05D7\u05D5\u05EA?", "\u{1F511}"],
    ["\u05DE\u05D9 \u05E0\u05D5\u05D4\u05D2 \u05D4\u05DB\u05D9 \u05D2\u05E8\u05D5\u05E2?", "\u{1F697}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E7\u05D1\u05DC \u05E7\u05E0\u05E1?", "\u{1F6A8}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D4\u05D9\u05E8\u05D3\u05DD \u05D1\u05D0\u05DE\u05E6\u05E2 \u05E1\u05E8\u05D8?", "\u{1F37F}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05E9\u05D9\u05E2\u05D6\u05D5\u05D1 \u05E7\u05D1\u05D5\u05E6\u05D4 \u05D1\u05D5\u05D5\u05D8\u05E1\u05D0\u05E4?", "\u{1F44B}"],
    ["\u05DE\u05D9 \u05E2\u05D5\u05E0\u05D4 \u05D4\u05DB\u05D9 \u05DC\u05D0\u05D8 \u05DC\u05D4\u05D5\u05D3\u05E2\u05D5\u05EA?", "\u{1F422}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E9\u05DC\u05D5\u05D7 \u05D4\u05D5\u05D3\u05E2\u05D4 \u05DC\u05D0\u05D3\u05DD \u05D4\u05DC\u05D0 \u05E0\u05DB\u05D5\u05DF?", "\u{1F62C}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E6\u05D7\u05D5\u05E7 \u05D1\u05E8\u05D2\u05E2 \u05D4\u05DC\u05D0 \u05DE\u05EA\u05D0\u05D9\u05DD?", "\u{1F92D}"],
    ["\u05DE\u05D9 \u05E2\u05D5\u05E9\u05D4 \u05D0\u05EA \u05D4\u05E7\u05E0\u05D9\u05D5\u05EA \u05D4\u05DB\u05D9 \u05DE\u05D9\u05D5\u05EA\u05E8\u05D5\u05EA?", "\u{1F6D2}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E6\u05D0\u05EA \u05DE\u05D4\u05D1\u05D9\u05EA \u05D1\u05DC\u05D9 \u05D0\u05E8\u05E0\u05E7?", "\u{1F45B}"],
    ['\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D5\u05DE\u05E8 "\u05E8\u05E7 \u05E2\u05D5\u05D3 5 \u05D3\u05E7\u05D5\u05EA"?', "\u23F3"],
    // --- Extra questions, same style ---
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D1\u05DB\u05D5\u05EA \u05D1\u05E1\u05E8\u05D8 \u05DE\u05E6\u05D5\u05D9\u05E8?", "\u{1F972}"],
    ["\u05DE\u05D9 \u05E9\u05E8 \u05D4\u05DB\u05D9 \u05DE\u05D6\u05D9\u05D9\u05E3?", "\u{1F3A4}"],
    ["\u05DE\u05D9 \u05D9\u05D9\u05E8\u05D3\u05DD \u05E8\u05D0\u05E9\u05D5\u05DF \u05D1\u05DE\u05E1\u05D9\u05D1\u05D4?", "\u{1F971}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D4\u05D6\u05DE\u05D9\u05DF \u05E4\u05D9\u05E6\u05D4 \u05D1-3 \u05D1\u05DC\u05D9\u05DC\u05D4?", "\u{1F355}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D4\u05E9\u05EA\u05EA\u05E3 \u05D1\u05E8\u05D9\u05D0\u05DC\u05D9\u05D8\u05D9?", "\u{1F4FA}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05D2\u05E8\u05D5\u05E2 \u05D1\u05DC\u05D4\u05E1\u05EA\u05D9\u05E8 \u05D4\u05E4\u05EA\u05E2\u05D5\u05EA?", "\u{1F381}"],
    ["\u05DE\u05D9 \u05D9\u05EA\u05D0\u05D4\u05D1 \u05D1\u05DB\u05DC\u05D1 \u05E9\u05DC \u05DE\u05D9\u05E9\u05D4\u05D5 \u05D0\u05D7\u05E8?", "\u{1F436}"],
    ["\u05DE\u05D9 \u05E8\u05D5\u05E7\u05D3 \u05D4\u05DB\u05D9 \u05D2\u05E8\u05D5\u05E2?", "\u{1F483}"],
    ["\u05DE\u05D9 \u05E6\u05D5\u05D7\u05E7 \u05DE\u05D4\u05D1\u05D3\u05D9\u05D7\u05D5\u05EA \u05E9\u05DC \u05E2\u05E6\u05DE\u05D5?", "\u{1F606}"],
    ["\u05DE\u05D9 \u05E9\u05D5\u05DB\u05D7 \u05DC\u05DE\u05D4 \u05D4\u05D5\u05D0 \u05E0\u05DB\u05E0\u05E1 \u05DC\u05D7\u05D3\u05E8?", "\u{1F914}"],
    ["\u05DE\u05D9 \u05DE\u05D1\u05DC\u05D4 \u05D4\u05DB\u05D9 \u05D4\u05E8\u05D1\u05D4 \u05D6\u05DE\u05DF \u05DE\u05D5\u05DC \u05D4\u05DE\u05E8\u05D0\u05D4?", "\u{1F485}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D1\u05DB\u05D5\u05EA \u05DE\u05D4\u05EA\u05E8\u05D2\u05E9\u05D5\u05EA?", "\u{1F979}"],
    ["\u05DE\u05D9 \u05EA\u05DE\u05D9\u05D3 \u05DE\u05EA\u05DC\u05D5\u05E0\u05DF \u05E9\u05E7\u05E8 \u05DC\u05D5?", "\u{1F976}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E9\u05E8\u05D5\u05E3 \u05D0\u05EA \u05D4\u05D0\u05D5\u05DB\u05DC?", "\u{1F525}"],
    ["\u05DE\u05D9 \u05D0\u05D5\u05DB\u05DC \u05DE\u05D4\u05E6\u05DC\u05D7\u05EA \u05E9\u05DC \u05D0\u05D7\u05E8\u05D9\u05DD?", "\u{1F35F}"],
    ["\u05DE\u05D9 \u05E9\u05D5\u05DC\u05D7 \u05D4\u05DB\u05D9 \u05D4\u05E8\u05D1\u05D4 \u05D4\u05D5\u05D3\u05E2\u05D5\u05EA \u05E7\u05D5\u05DC\u05D9\u05D5\u05EA?", "\u{1F399}\uFE0F"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E4\u05E1\u05E4\u05E1 \u05D8\u05D9\u05E1\u05D4?", "\u2708\uFE0F"],
    ["\u05DE\u05D9 \u05D0\u05D5\u05E8\u05D6 \u05D1\u05E8\u05D2\u05E2 \u05D4\u05D0\u05D7\u05E8\u05D5\u05DF?", "\u{1F9F3}"],
    ["\u05DE\u05D9 \u05EA\u05DE\u05D9\u05D3 \u05E9\u05D5\u05DB\u05D7 \u05D0\u05EA \u05D4\u05E1\u05D9\u05E1\u05DE\u05D4?", "\u{1F510}"],
    ["\u05DE\u05D9 \u05D9\u05E8\u05D0\u05D4 \u05E2\u05D5\u05E0\u05D4 \u05E9\u05DC\u05DE\u05D4 \u05D1\u05DC\u05D9\u05DC\u05D4 \u05D0\u05D7\u05D3?", "\u{1F37F}"],
    ["\u05DE\u05D9 \u05DE\u05EA\u05D7\u05D9\u05DC \u05D3\u05D9\u05D0\u05D8\u05D4 \u05DB\u05DC \u05D9\u05D5\u05DD \u05E8\u05D0\u05E9\u05D5\u05DF?", "\u{1F957}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D0\u05DE\u05E5 \u05D7\u05EA\u05D5\u05DC \u05DE\u05D4\u05E8\u05D7\u05D5\u05D1?", "\u{1F431}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D4\u05D9\u05D5\u05EA \u05DE\u05E4\u05D5\u05E8\u05E1\u05DD?", "\u2B50"],
    ["\u05DE\u05D9 \u05D9\u05EA\u05E2\u05E9\u05E8 \u05DE\u05E8\u05E2\u05D9\u05D5\u05DF \u05DE\u05D5\u05D6\u05E8?", "\u{1F4A1}"],
    ["\u05DE\u05D9 \u05DE\u05EA\u05DC\u05D1\u05E9 \u05D4\u05DB\u05D9 \u05D9\u05E4\u05D4?", "\u2728"],
    ["\u05DE\u05D9 \u05DE\u05E6\u05DC\u05DD \u05D0\u05EA \u05D4\u05D0\u05D5\u05DB\u05DC \u05DC\u05E4\u05E0\u05D9 \u05E9\u05D0\u05D5\u05DB\u05DC\u05D9\u05DD?", "\u{1F4F8}"],
    ["\u05DE\u05D9 \u05DE\u05D3\u05D1\u05E8 \u05E2\u05DD \u05E2\u05E6\u05DE\u05D5?", "\u{1F4AC}"],
    ["\u05DE\u05D9 \u05E9\u05E8 \u05D1\u05E7\u05E8\u05D9\u05D5\u05E7\u05D9 \u05D1\u05DC\u05D9 \u05E9\u05D5\u05DD \u05D1\u05D5\u05E9\u05D4?", "\u{1F3B6}"],
    ["\u05DE\u05D9 \u05DE\u05EA\u05E2\u05E6\u05D1\u05DF \u05DB\u05E9\u05D4\u05D5\u05D0 \u05E8\u05E2\u05D1?", "\u{1F624}"],
    ['\u05DE\u05D9 \u05DC\u05D0 \u05E2\u05D5\u05E0\u05D4 \u05DC\u05E9\u05D9\u05D7\u05D4 \u05D5\u05D0\u05D6 \u05E9\u05D5\u05DC\u05D7 "\u05DE\u05D4 \u05E7\u05E8\u05D4?"', "\u{1F4DE}"],
    ["\u05DE\u05D9 \u05E7\u05D5\u05E0\u05D4 \u05D4\u05DB\u05D9 \u05D4\u05E8\u05D1\u05D4 \u05D1\u05D2\u05D3\u05D9\u05DD?", "\u{1F6CD}\uFE0F"],
    ["\u05DE\u05D9 \u05DE\u05EA\u05D7\u05D9\u05DC \u05EA\u05D7\u05D1\u05D9\u05D1 \u05D7\u05D3\u05E9 \u05DB\u05DC \u05E9\u05D1\u05D5\u05E2?", "\u{1F3A8}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E2\u05E9\u05D5\u05EA \u05E1\u05E4\u05D5\u05D9\u05DC\u05E8?", "\u{1F64A}"],
    ["\u05DE\u05D9 \u05D4\u05D5\u05DC\u05DA \u05DC\u05D0\u05D9\u05D1\u05D5\u05D3 \u05D2\u05DD \u05E2\u05DD \u05E0\u05D9\u05D5\u05D5\u05D8?", "\u{1F5FA}\uFE0F"],
    ["\u05DE\u05D9 \u05E0\u05E8\u05D3\u05DD \u05E2\u05DD \u05D4\u05D8\u05DC\u05E4\u05D5\u05DF \u05E2\u05DC \u05D4\u05E4\u05E0\u05D9\u05DD?", "\u{1F4F1}"],
    ["\u05DE\u05D9 \u05DE\u05EA\u05E2\u05D5\u05E8\u05E8 \u05D4\u05DB\u05D9 \u05E2\u05E6\u05D1\u05E0\u05D9 \u05D1\u05D1\u05D5\u05E7\u05E8?", "\u2615"],
    ["\u05DE\u05D9 \u05E9\u05D5\u05DB\u05D7 \u05E9\u05DE\u05D5\u05EA \u05E9\u05DC \u05D0\u05E0\u05E9\u05D9\u05DD?", "\u{1F605}"],
    ["\u05DE\u05D9 \u05D9\u05E2\u05E9\u05D4 \u05E8\u05D9\u05E7\u05D5\u05D3 \u05D8\u05D9\u05E7\u05D8\u05D5\u05E7 \u05D1\u05D0\u05DE\u05E6\u05E2 \u05D4\u05E8\u05D7\u05D5\u05D1?", "\u{1F57A}"],
    ["\u05DE\u05D9 \u05DE\u05E7\u05D1\u05DC \u05D4\u05DB\u05D9 \u05D4\u05E8\u05D1\u05D4 \u05DC\u05D9\u05D9\u05E7\u05D9\u05DD?", "\u2764\uFE0F"],
    ["\u05DE\u05D9 \u05D4\u05E8\u05D0\u05E9\u05D5\u05DF \u05DC\u05E2\u05DC\u05D5\u05EA \u05DC\u05E8\u05D7\u05D1\u05D4?", "\u{1FAA9}"],
    ["\u05DE\u05D9 \u05E7\u05D5\u05E0\u05D4 \u05D0\u05EA \u05D4\u05DE\u05EA\u05E0\u05D5\u05EA \u05D4\u05DB\u05D9 \u05D8\u05D5\u05D1\u05D5\u05EA?", "\u{1F381}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D1\u05DB\u05D5\u05EA \u05D1\u05D7\u05EA\u05D5\u05E0\u05D4?", "\u{1F48D}"],
    ["\u05DE\u05D9 \u05EA\u05DE\u05D9\u05D3 \u05E9\u05D5\u05DB\u05D7 \u05DC\u05DB\u05D1\u05D5\u05EA \u05D0\u05EA \u05D4\u05D0\u05D5\u05E8?", "\u{1F4A1}"],
    ['\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05E2\u05E0\u05D5\u05EA "\u05E1\u05D1\u05D1\u05D4" \u05D5\u05DC\u05D0 \u05DC\u05D4\u05D1\u05D9\u05DF \u05DB\u05DC\u05D5\u05DD?', "\u{1F44D}"],
    ["\u05DE\u05D9 \u05D4\u05DB\u05D9 \u05E1\u05D1\u05D9\u05E8 \u05DC\u05D0\u05DB\u05D5\u05DC \u05D0\u05EA \u05D4\u05E7\u05D9\u05E0\u05D5\u05D7 \u05E8\u05D0\u05E9\u05D5\u05DF?", "\u{1F370}"]
  ];

  // Scripts/QuestionPicker.ts
  var QuestionPicker = class {
    constructor(items, historySize = 5, random = Math.random) {
      this.items = items;
      this.random = random;
      this.recent = [];
      if (items.length === 0) {
        throw new Error("QuestionPicker: question list is empty");
      }
      this.historySize = Math.max(0, Math.min(historySize, items.length - 1));
    }
    /** Returns the next random item. */
    next() {
      return this.items[this.nextIndex()];
    }
    /** Returns the index of the next random item (useful for tests). */
    nextIndex() {
      const candidates = [];
      for (let i = 0; i < this.items.length; i++) {
        if (this.recent.indexOf(i) === -1) candidates.push(i);
      }
      const pick = candidates[Math.floor(this.random() * candidates.length) % candidates.length];
      this.recent.push(pick);
      while (this.recent.length > this.historySize) this.recent.shift();
      return pick;
    }
  };

  // Scripts/TextLayout.ts
  function wrapBalanced(text, maxChars, maxLines = 3) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { lines: [""], longest: 0, fitScale: 1 };
    let best = [words.join(" ")];
    const lineCount = Math.min(maxLines, words.length);
    for (let n = 1; n <= lineCount; n++) {
      best = bestSplit(words, n);
      if (longestOf(best) <= maxChars) break;
    }
    const longest = longestOf(best);
    return { lines: best, longest, fitScale: longest > maxChars ? maxChars / longest : 1 };
  }
  function longestOf(lines) {
    let max = 0;
    for (const line of lines) max = Math.max(max, charLength(line));
    return max;
  }
  function charLength(s) {
    let n = 0;
    for (const cp of Array.from(s)) {
      const code = cp.codePointAt(0);
      if (code !== 65039 && code !== 8205) n++;
    }
    return n;
  }
  function bestSplit(words, n) {
    if (n <= 1) return [words.join(" ")];
    let bestLines = [];
    let bestScore = Infinity;
    const recurse = (start, remaining, acc) => {
      if (remaining === 1) {
        const lines = acc.concat(words.slice(start).join(" "));
        const lengths = lines.map(charLength);
        const score = Math.max(...lengths) * 100 + Math.abs(lengths[0] - lengths[lengths.length - 1]);
        if (score < bestScore) {
          bestScore = score;
          bestLines = lines;
        }
        return;
      }
      for (let end = start + 1; end <= words.length - (remaining - 1); end++) {
        recurse(end, remaining - 1, acc.concat(words.slice(start, end).join(" ")));
      }
    };
    recurse(0, n, []);
    return bestLines;
  }

  // Scripts/GameFlow.ts
  var newElement = () => ({ opacity: 0, scale: 1, x: 0, y: 0, rotation: 0 });
  var resetElement = (e) => {
    e.opacity = 0;
    e.scale = 1;
    e.x = 0;
    e.y = 0;
    e.rotation = 0;
  };
  var GameFlow = class {
    constructor(options) {
      this.options = options;
      this.state = "INTRO";
      /** Time spent in the current state (ms). */
      this.stateTime = 0;
      /** Total running time (ms) — drives idle micro-animations. */
      this.clock = 0;
      this.lastTickIndex = -1;
      this.current = null;
      this.previous = null;
      this.displayed = null;
      var _a4, _b, _c;
      this.random = (_a4 = options.random) != null ? _a4 : Math.random;
      this.picker = new QuestionPicker(options.questions, (_b = options.historySize) != null ? _b : 5, this.random);
      const burstCount = (_c = options.burstCount) != null ? _c : 10;
      this.burstSeeds = [];
      const burst = [];
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
        questionLines: [""],
        questionEmojiChar: DEFAULT_EMOJI,
        questionRevision: 0,
        countdownLabel: "3",
        accentColor: COUNTDOWN_COLORS[0]
      };
      this.computeView();
    }
    /** The question currently in play (null during the intro). */
    get currentQuestion() {
      return this.current ? this.current.entry : null;
    }
    /**
     * Screen tap. Only accepted while waiting for the next question — taps during
     * animations are ignored, so rapid tapping can never stack countdowns.
     * Returns true if the tap started a new round.
     */
    tap() {
      if (this.state !== "WAITING_FOR_NEXT") return false;
      this.stateTime = 0;
      this.beginQuestion();
      return true;
    }
    /** Advances the flow by `deltaMs` and refreshes `view`. */
    update(deltaMs) {
      const dt = Math.min(Math.max(deltaMs, 0), TIMING.maxFrameDelta);
      this.clock += dt;
      this.stateTime += dt;
      for (let guard = 0; guard < 8; guard++) {
        const duration = this.stateDuration();
        if (this.stateTime < duration) break;
        this.stateTime -= duration;
        this.advance();
      }
      if (this.state === "COUNTDOWN") {
        const step = Math.min(TIMING.countdownSteps - 1, Math.floor(this.stateTime / TIMING.countdownStep));
        if (step !== this.lastTickIndex) {
          this.lastTickIndex = step;
          this.emitCue("tick", step);
        }
      }
      this.computeView();
      return this.view;
    }
    // -------------------------------------------------------------------------
    // State machine
    // -------------------------------------------------------------------------
    stateDuration() {
      switch (this.state) {
        case "INTRO":
          return TIMING.introDuration;
        case "QUESTION":
          return this.exitDuration() + TIMING.questionEnter + TIMING.questionHold;
        case "COUNTDOWN":
          return TIMING.countdownStep * TIMING.countdownSteps;
        case "REVEAL":
          return TIMING.revealDuration;
        case "WAITING_FOR_NEXT":
          return Infinity;
      }
    }
    advance() {
      switch (this.state) {
        case "INTRO":
          this.beginQuestion();
          break;
        case "QUESTION":
          this.setState("COUNTDOWN");
          break;
        case "COUNTDOWN":
          this.seedBurst();
          this.setState("REVEAL");
          this.emitCue("now", 0);
          break;
        case "REVEAL":
          this.setState("WAITING_FOR_NEXT");
          break;
        case "WAITING_FOR_NEXT":
          break;
      }
    }
    beginQuestion() {
      this.previous = this.current;
      const entry = this.picker.next();
      const wrapped = wrapBalanced(entry[0], LAYOUT.questionMaxChars, LAYOUT.questionMaxLines);
      this.current = { entry, lines: wrapped.lines, fitScale: wrapped.fitScale };
      this.setState("QUESTION");
      this.emitCue("whoosh", 0);
    }
    setState(next) {
      this.state = next;
      if (next !== "COUNTDOWN") this.lastTickIndex = -1;
      if (this.options.onStateChange) this.options.onStateChange(next);
    }
    exitDuration() {
      return this.previous ? TIMING.questionExit : 0;
    }
    emitCue(cue, index) {
      if (this.options.onCue) this.options.onCue(cue, index);
    }
    seedBurst() {
      const n = this.burstSeeds.length;
      for (let i = 0; i < n; i++) {
        const seed = this.burstSeeds[i];
        seed.angle = i / n * Math.PI * 2 + (this.random() - 0.5) * 0.5;
        seed.distance = 0.65 + this.random() * 0.45;
        seed.spin = (this.random() - 0.5) * 120;
      }
    }
    // -------------------------------------------------------------------------
    // View model
    // -------------------------------------------------------------------------
    setDisplayed(q) {
      if (!q || q === this.displayed) return;
      this.displayed = q;
      this.view.questionLines = q.lines;
      this.view.questionEmojiChar = q.entry[1] || DEFAULT_EMOJI;
      this.view.questionRevision++;
    }
    computeView() {
      const v = this.view;
      const t = this.stateTime;
      const seconds = this.clock / 1e3;
      const float = Math.sin(seconds * Math.PI * 2 / 3.2) * 7;
      const floatTilt = Math.sin(seconds * Math.PI * 2 / 4.1) * 0.6;
      const idleBounce = decay(seconds % 1.6 / 1.6 * 3);
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
        case "INTRO": {
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
        case "QUESTION": {
          const exit = this.exitDuration();
          if (t < exit) {
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
            this.setDisplayed(this.current);
            const local = t - exit;
            const p = progress(local, 0, TIMING.questionEnter);
            v.card.opacity = easeOutCubic(Math.min(1, p * 1.6));
            v.card.scale = lerp(0.8, 1, easeOutBack(p, 2));
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
        case "COUNTDOWN": {
          this.setDisplayed(this.current);
          const step = Math.min(TIMING.countdownSteps - 1, Math.floor(t / TIMING.countdownStep));
          const lt = t - step * TIMING.countdownStep;
          const tension = step / (TIMING.countdownSteps - 1);
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
          const inP = progress(lt, 0, 200);
          const settle = progress(lt, 200, 130);
          const outP = progress(lt, 560, TIMING.countdownStep - 560);
          let scale = lerp(0.3, 1.15, easeOutCubic(inP));
          if (lt >= 200) scale = lerp(1.15, 1, easeInOutSine(settle));
          if (lt >= 330) scale = lerp(1, 1.04, progress(lt, 330, 230));
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
        case "REVEAL": {
          this.setDisplayed(this.current);
          const accent = COUNTDOWN_COLORS[COUNTDOWN_COLORS.length - 1];
          v.accentColor = accent;
          v.overlay.opacity = 1 - 0.15 * progress(t, 600, 900);
          const pop = progress(t, 0, TIMING.nowPop);
          const out = progress(t, TIMING.nowOutStart, TIMING.revealDuration - TIMING.nowOutStart);
          const pulse = t > TIMING.nowPop ? 0.04 * Math.sin((t - TIMING.nowPop) / 1e3 * Math.PI * 2 * 2.2) : 0;
          v.now.opacity = Math.min(1, pop * 3) * (1 - easeInCubic(out));
          v.now.scale = (easeOutBack(pop, 3.2) + pulse) * lerp(1, 0.85, easeInCubic(out));
          v.now.rotation = -12 * (1 - easeOutCubic(pop));
          v.now.y = -40 * easeInCubic(out);
          v.flash.opacity = 0.3 * decay(t / TIMING.flash);
          const wave = progress(t, 0, 520);
          v.countdownGlow.opacity = 0.95 * decay(wave);
          v.countdownGlow.scale = lerp(0.7, 1.7, easeOutCubic(wave));
          const cardPop = progress(t, 0, 260);
          v.card.opacity = 1;
          v.card.scale = t < 260 ? lerp(1, 1.08, easeOutBack(cardPop, 2.4)) : lerp(1.08, 1.04, easeInOutSine(progress(t, 260, 500)));
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
          const bp = progress(t, 0, TIMING.burst);
          for (let i = 0; i < v.burst.length; i++) {
            const p = v.burst[i];
            const seed = this.burstSeeds[i];
            const d = LAYOUT.burstInnerRadius + (LAYOUT.burstRadius * seed.distance - LAYOUT.burstInnerRadius) * easeOutCubic(bp);
            p.x = Math.cos(seed.angle) * d * 1.5;
            p.y = Math.sin(seed.angle) * d * 0.75 + 90 * bp * bp;
            p.opacity = bp <= 0 || bp >= 1 ? 0 : bp < 0.55 ? Math.min(1, bp * 10) : 1 - (bp - 0.55) / 0.45;
            p.scale = (0.5 + 0.7 * easeOutBack(Math.min(1, bp * 2.5))) * (1 - 0.3 * bp);
            p.rotation = seed.spin * bp;
          }
          break;
        }
        case "WAITING_FOR_NEXT": {
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
  };

  // preview/src/main.ts
  var params = new URLSearchParams(location.search);
  var $ = (id) => document.getElementById(id);
  var stage = $("stage");
  var frame = $("frame");
  var assetBase = document.body.dataset.assets || "../Assets/";
  function el(id, className, anchor, parent = stage, text = "") {
    const node = document.createElement("div");
    node.id = id;
    node.className = `node ${className}`;
    node.style.left = `${anchor.x}px`;
    node.style.top = `${anchor.y}px`;
    if (text) node.textContent = text;
    parent.appendChild(node);
    return node;
  }
  var center = { x: REFERENCE_WIDTH / 2, y: REFERENCE_HEIGHT / 2 };
  var fx = { x: LAYOUT.now.x, y: LAYOUT.now.y };
  var nodes = {
    overlay: el("BackgroundOverlay", "overlay", center),
    flash: el("Flash", "flash", center),
    introTitle: el("IntroTitle", "intro-title", LAYOUT.intro, stage, COPY.introTitle),
    introSubtitle: el("IntroSubtitle", "intro-subtitle", LAYOUT.introSubtitle, stage, COPY.introSubtitle),
    cardGlow: el("CardGlow", "card-glow tint", LAYOUT.card),
    card: el("QuestionCard", "card", LAYOUT.card),
    questionEmoji: el("QuestionEmoji", "question-emoji", LAYOUT.questionEmoji),
    countdownGlow: el("CountdownGlow", "countdown-glow tint", LAYOUT.countdown),
    countdown: el("CountdownText", "countdown", LAYOUT.countdown, stage, "3"),
    // FXContainer sits behind "עכשיו!" so the burst never covers the label.
    fx: el("FXContainer", "fx", fx),
    now: el("NowText", "now", LAYOUT.now, stage, COPY.now),
    tapHint: el("TapHint", "tap-hint", LAYOUT.tapHint, stage, COPY.tapHint),
    branding: el("Branding", "branding", LAYOUT.branding, stage, COPY.branding)
  };
  var questionText = el("QuestionText", "question-text", { x: 0, y: 0 }, nodes.card);
  questionText.style.left = "50%";
  questionText.style.top = "50%";
  questionText.setAttribute("dir", "rtl");
  for (const n of [nodes.introTitle, nodes.introSubtitle, nodes.now, nodes.tapHint]) n.setAttribute("dir", "rtl");
  var fxContainer = nodes.fx;
  fxContainer.style.visibility = "visible";
  var flow = new GameFlow({
    questions: QUESTIONS,
    burstCount: 10,
    onCue: (cue) => sound.play(cue)
  });
  var burstNodes = flow.view.burst.map((p, i) => el(`BurstEmoji_${i + 1}`, "burst", { x: 0, y: 0 }, fxContainer, p.emoji));
  function apply(node, e) {
    const visible = e.opacity > 3e-3;
    node.style.visibility = visible ? "visible" : "hidden";
    if (!visible) return;
    node.style.opacity = e.opacity.toFixed(3);
    node.style.transform = `translate(-50%, -50%) translate(${e.x.toFixed(1)}px, ${e.y.toFixed(1)}px) rotate(${e.rotation.toFixed(2)}deg) scale(${e.scale.toFixed(4)})`;
  }
  var lastRevision = -1;
  var lastAccent = null;
  function render(v) {
    if (v.questionRevision !== lastRevision) {
      lastRevision = v.questionRevision;
      questionText.innerHTML = "";
      for (const line of v.questionLines) {
        const span = document.createElement("span");
        span.textContent = line;
        questionText.appendChild(span);
      }
      nodes.questionEmoji.textContent = v.questionEmojiChar;
    }
    if (nodes.countdown.textContent !== v.countdownLabel) nodes.countdown.textContent = v.countdownLabel;
    if (v.accentColor !== lastAccent) {
      lastAccent = v.accentColor;
      const [r, g, b] = v.accentColor.map((c) => Math.round(c * 255));
      frame.style.setProperty("--accent", `rgb(${r}, ${g}, ${b})`);
    }
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
  var sound = (() => {
    let ctx = null;
    const buffers = {};
    let muted = params.get("mute") === "1";
    const files = { whoosh: "sfx_whoosh.wav", tick: "sfx_tick.wav", now: "sfx_now.wav" };
    async function unlock() {
      if (ctx || muted) return;
      try {
        ctx = new AudioContext();
        await Promise.all(Object.keys(files).map(async (cue) => {
          const res = await fetch(`${assetBase}Audio/${files[cue]}`);
          buffers[cue] = await ctx.decodeAudioData(await res.arrayBuffer());
        }));
      } catch (_) {
        ctx = null;
      }
    }
    function play(cue) {
      const buf = buffers[cue];
      if (!ctx || !buf || muted) return;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = cue === "whoosh" ? 0.5 : 0.8;
      src.buffer = buf;
      src.connect(gain).connect(ctx.destination);
      src.start();
    }
    return {
      unlock,
      play,
      toggle() {
        muted = !muted;
        if (!muted) void unlock();
        return muted;
      },
      get muted() {
        return muted;
      }
    };
  })();
  var taps = 0;
  var acceptedTaps = 0;
  function onTap() {
    void sound.unlock();
    taps++;
    if (flow.tap()) acceptedTaps++;
  }
  stage.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    onTap();
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      onTap();
    }
  });
  var video = $("camera");
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 1080, height: 1920 }, audio: false });
      video.srcObject = stream;
      await video.play();
      frame.classList.add("has-camera");
      return true;
    } catch (_) {
      frame.classList.remove("has-camera");
      return false;
    }
  }
  var toolbar = {
    camera: document.getElementById("btn-camera"),
    safe: document.getElementById("btn-safe"),
    sound: document.getElementById("btn-sound")
  };
  var _a;
  (_a = toolbar.camera) == null ? void 0 : _a.addEventListener("click", async () => {
    const ok = await startCamera();
    toolbar.camera.textContent = ok ? "\u{1F4F7} \u05DE\u05E6\u05DC\u05DE\u05D4 \u05E4\u05E2\u05D9\u05DC\u05D4" : "\u{1F4F7} \u05D0\u05D9\u05DF \u05D2\u05D9\u05E9\u05D4 \u05DC\u05DE\u05E6\u05DC\u05DE\u05D4";
  });
  var _a2;
  (_a2 = toolbar.safe) == null ? void 0 : _a2.addEventListener("click", () => {
    frame.classList.toggle("show-safe");
    toolbar.safe.setAttribute("aria-pressed", String(frame.classList.contains("show-safe")));
  });
  var _a3;
  (_a3 = toolbar.sound) == null ? void 0 : _a3.addEventListener("click", () => {
    const m = sound.toggle();
    toolbar.sound.textContent = m ? "\u{1F507} \u05E1\u05D0\u05D5\u05E0\u05D3 \u05DB\u05D1\u05D5\u05D9" : "\u{1F50A} \u05E1\u05D0\u05D5\u05E0\u05D3 \u05E4\u05E2\u05D9\u05DC";
  });
  if (params.get("safe") === "1") frame.classList.add("show-safe");
  if (params.get("camera") === "1") void startCamera();
  function fit() {
    const scale = frame.clientWidth / REFERENCE_WIDTH;
    stage.style.transform = `scale(${scale})`;
  }
  new ResizeObserver(fit).observe(frame);
  fit();
  var manual = params.get("manual") === "1";
  var lastTime = performance.now();
  function frameLoop(now) {
    render(flow.update(now - lastTime));
    lastTime = now;
    requestAnimationFrame(frameLoop);
  }
  render(flow.view);
  if (!manual) requestAnimationFrame(frameLoop);
  window.__miPo = {
    flow,
    step(ms, frameMs = 16) {
      for (let t = 0; t < ms; t += frameMs) render(flow.update(frameMs));
      return flow.state;
    },
    tap: onTap,
    stats: () => ({ state: flow.state, taps, acceptedTaps, question: flow.currentQuestion })
  };
})();
