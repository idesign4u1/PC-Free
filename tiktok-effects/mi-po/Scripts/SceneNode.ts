/**
 * SceneNode — applies an ElementView (opacity / scale / offset / rotation) to an
 * Effect House SceneObject through APJS.
 *
 * APJS property names have shifted between Effect House releases, so every access is
 * feature-detected once in the constructor and cached. Whatever the object doesn't
 * support is skipped silently (e.g. an object without a Text/Image just moves).
 * The object's editor-set position / scale are used as the animation base.
 */
import type { ElementView } from './GameFlow';

type Rgb = readonly [number, number, number];

// Loosely-typed handles: APJS objects are native bindings, accessed via detected keys.
type AnyObj = { [key: string]: any };

const TRANSFORM_TYPES = ['ScreenTransform', 'Transform'];
const VISUAL_TYPES = ['Text', 'Image', 'ScreenImage', 'Sprite', 'MeshRenderer'];
const POSITION_KEYS = ['localPosition', 'anchoredPosition', 'position'];
const SCALE_KEYS = ['localScale', 'scale'];
const ROTATION_KEYS = ['localEulerAngles', 'localEulerAngle', 'rotation'];

const EPS = 0.0005;

export function tryGetComponent(obj: AnyObj | null | undefined, type: string): AnyObj | null {
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

export class SceneNode {
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
export function getChildren(object: AnyObj | null | undefined): AnyObj[] {
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
export class SoundPlayer {
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
