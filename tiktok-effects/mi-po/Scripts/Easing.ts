/** Small, allocation-free easing & interpolation helpers. All inputs are clamped to [0, 1]. */

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Normalized progress of `t` inside the window [start, start + duration]. */
export const progress = (t: number, start: number, duration: number): number =>
  duration <= 0 ? (t >= start ? 1 : 0) : clamp01((t - start) / duration);

export const easeOutCubic = (t: number): number => {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
};

export const easeInCubic = (t: number): number => {
  const c = clamp01(t);
  return c * c * c;
};

export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

/** Overshoots then settles — the "pop" feel. `overshoot` ~1.7 is classic, higher = bouncier. */
export const easeOutBack = (t: number, overshoot = 1.70158): number => {
  const c = clamp01(t) - 1;
  return 1 + (overshoot + 1) * c * c * c + overshoot * c * c;
};

/** 0 → 1 → 0 bump, peaking at t = 0.5. */
export const bump = (t: number): number => Math.sin(Math.PI * clamp01(t));

/** Quick hit that decays: 1 at t = 0, 0 at t = 1. */
export const decay = (t: number): number => {
  const u = 1 - clamp01(t);
  return u * u;
};
