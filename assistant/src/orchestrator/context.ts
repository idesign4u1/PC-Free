import type { Repositories } from '../db/repositories.js';
import type { Settings, User } from '../domain/types.js';
import type { TaskService } from '../tasks/service.js';
import type { CalendarService } from '../calendar/service.js';
import type { Messenger } from '../whatsapp/messenger.js';
import type { AiProvider } from '../ai/provider.js';

/** Everything a handler is allowed to touch. Handlers get no other globals. */
export interface HandlerContext {
  repos: Repositories;
  tasks: TaskService;
  calendar: CalendarService;
  messenger: Messenger;
  ai: AiProvider | null;
  user: User;
  settings: Settings;
  now: Date;
  /** Always `user.timezone`; hoisted so date helpers can take the context directly. */
  timezone: string;
  /** 'whatsapp' | 'whatsapp_voice' | 'api' — recorded on every action. */
  source: string;
}

export interface HandlerResult {
  /** Hebrew reply to send back. Empty string means "say nothing". */
  reply: string;
  buttons?: { id: string; title: string }[];
  /** Set when the handler asked a question that the next message answers. */
  pendingConfirmation?: {
    kind: string;
    payload: Record<string, unknown>;
    prompt: string;
    ttlMinutes?: number;
  };
  /** Task the user is now "on", so "דחה את זה" resolves. */
  focusTaskId?: string | null;
  /** Non-fatal degradation notes already folded into `reply`. */
  degraded?: string[];
}
