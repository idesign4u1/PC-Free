/**
 * LOCAL TYPECHECK SHIM ONLY — do NOT import this into Effect House.
 * Effect House provides the real `APJS` namespace and decorators. This declares just
 * the subset GameManager/SceneNode use, so `npm run typecheck` works outside the editor.
 */
declare namespace APJS {
  class SceneObject {
    name: string;
    enabled: boolean;
    getComponent(type: string | Function): any;
  }
  class BasicScriptComponent {
    getSceneObject(): SceneObject;
  }
  interface IEvent {
    type: unknown;
    args: unknown[];
  }
  interface TouchData {
    phase: TouchPhase;
    position?: { x: number; y: number };
  }
  enum TouchPhase { Began, Moved, Stationary, Ended, Canceled }
  enum EventType { Touch }
  interface EventEmitter {
    on(type: EventType, listener: (event: IEvent) => void): void;
    off(type: EventType, listener: (event: IEvent) => void): void;
  }
  const EventManager: { getGlobalEmitter(): EventEmitter };
}
declare function component(): ClassDecorator;
declare function serializeProperty(): PropertyDecorator;
