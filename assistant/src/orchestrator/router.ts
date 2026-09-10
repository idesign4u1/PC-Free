import type { Intent } from '../ai/intent-schema.js';
import type { IntentEngine, IntentResult } from '../ai/intent-engine.js';
import type { HandlerContext, HandlerResult } from './context.js';
import {
  handleCompleteTask,
  handleCreateTask,
  handleDeleteTask,
  handleListTasks,
  handlePrioritize,
  handleSearchTasks,
  handleSnoozeTask,
  handleUpdateTask,
} from './handlers/tasks.js';
import {
  handleCalendarQuery,
  handleCreateEvent,
  handleDeleteEvent,
  handleFreeTimeQuery,
} from './handlers/calendar.js';
import { handlePendingConfirmation } from './handlers/confirmations.js';
import { HELP_TEXT } from '../whatsapp/formatter.js';
import { addMinutes, describeInstantHe } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import { errorText } from '../utils/errors.js';

/**
 * The orchestration pipeline:
 *
 *   message → intent detection → structured JSON → validation
 *           → permission / safety check → tool handler → external API
 *           → result → natural-language response
 *
 * The model produces JSON and nothing else. Every side effect below runs in
 * ordinary typed code, so a bad model output can at worst produce a confused
 * reply — never an unintended delete or calendar write.
 */

/** Intents that are allowed to modify or destroy data. */
const MUTATING_INTENTS = new Set([
  'CREATE_TASK', 'UPDATE_TASK', 'COMPLETE_TASK', 'DELETE_TASK', 'SNOOZE_TASK',
  'CREATE_EVENT', 'UPDATE_EVENT', 'DELETE_EVENT',
]);

/** Below this, a mutating intent is questioned rather than executed. */
const MUTATION_CONFIDENCE_FLOOR = 0.55;

export interface RouteInput {
  text: string;
  /** Structured id of a tapped reply button, if any. */
  buttonId?: string | null;
  /** True for forwarded content, which the spec treats as untrusted input. */
  untrusted?: boolean;
}

export interface RouteOutput extends HandlerResult {
  intent: Intent | null;
  intentResult: IntentResult | null;
}

export class Router {
  constructor(private readonly engine: IntentEngine) {}

  async route(ctx: HandlerContext, input: RouteInput): Promise<RouteOutput> {
    // 1. A tapped button is unambiguous — no model, no guessing.
    if (input.buttonId) {
      const result = await this.handleButton(ctx, input.buttonId);
      if (result) return { ...result, intent: null, intentResult: null };
    }

    const text = input.text.trim();
    if (!text) return { reply: '', intent: null, intentResult: null };

    // 2. An open question takes precedence: a bare "2" or "כן" answers it.
    const pending = await ctx.repos.confirmations.findPending(ctx.user.id);
    if (pending) {
      const outcome = await handlePendingConfirmation(ctx, pending, text);
      if (outcome.handled && outcome.result) {
        return { ...outcome.result, intent: null, intentResult: null };
      }
    }

    // 3. Intent detection.
    const state = await ctx.repos.conversation.get(ctx.user.id);
    const lastTask = state?.last_task_id ? await ctx.repos.tasks.findById(ctx.user.id, state.last_task_id) : null;
    const intentResult = await this.engine.detect(text, {
      now: ctx.now,
      timezone: ctx.timezone,
      userName: ctx.user.display_name,
      pendingQuestion: pending ? { kind: pending.kind, prompt: pending.prompt } : null,
      lastTaskTitle: lastTask?.title ?? null,
      untrusted: input.untrusted ?? false,
    });

    await ctx.repos.ai.log({
      user_id: ctx.user.id,
      kind: 'intent',
      provider: intentResult.provider ?? 'rules',
      model: intentResult.model ?? 'rules',
      intent: intentResult.intent.intent,
      structured_output: intentResult.intent,
      tool_requested: intentResult.intent.intent,
      latency_ms: intentResult.latencyMs,
      input_tokens: intentResult.inputTokens,
      output_tokens: intentResult.outputTokens,
      error: intentResult.error ?? null,
    });

    if (intentResult.injectionFlags.length) {
      await ctx.repos.audit.log({
        user_id: ctx.user.id,
        action: 'PROMPT_INJECTION_FLAGGED',
        source: ctx.source,
        status: 'skipped',
        result: { flags: intentResult.injectionFlags },
      });
    }

    // 4. Safety gate before any handler runs.
    const intent = intentResult.intent;
    if (intentResult.error === 'ai_not_configured') {
      return {
        reply: 'המנוע החכם לא מוגדר עדיין (חסר AI_API_KEY), אז אני מבין רק פקודות בסיסיות.',
        intent,
        intentResult,
      };
    }
    if (intentResult.error && intent.intent === 'UNKNOWN') {
      logger().warn({ err: intentResult.error }, 'intent detection failed');
      return { reply: 'לא הצלחתי לעבד את ההודעה כרגע. אפשר לנסות שוב?', intent, intentResult };
    }
    if (MUTATING_INTENTS.has(intent.intent) && intent.confidence < MUTATION_CONFIDENCE_FLOOR) {
      return {
        reply: 'לא בטוח שהבנתי נכון. אפשר לנסח את זה קצת אחרת?',
        intent,
        intentResult,
      };
    }

    // 5. Dispatch.
    try {
      const result = await this.dispatch(ctx, intent);
      return { ...result, intent, intentResult };
    } catch (err) {
      logger().error({ err: errorText(err), intent: intent.intent }, 'handler failed');
      await ctx.repos.audit.log({
        user_id: ctx.user.id,
        action: intent.intent,
        source: ctx.source,
        status: 'failure',
        error: errorText(err),
      });
      return {
        reply: 'משהו השתבש אצלי בצד. רשמתי את זה בלוג — אפשר לנסות שוב.',
        intent,
        intentResult,
      };
    }
  }

  private async dispatch(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
    switch (intent.intent) {
      case 'CREATE_TASK':
        return handleCreateTask(ctx, intent);
      case 'UPDATE_TASK':
        return handleUpdateTask(ctx, intent);
      case 'COMPLETE_TASK':
        return handleCompleteTask(ctx, intent);
      case 'DELETE_TASK':
        return handleDeleteTask(ctx, intent);
      case 'SNOOZE_TASK':
        return handleSnoozeTask(ctx, intent);
      case 'LIST_TASKS':
        return handleListTasks(ctx, intent);
      case 'SEARCH_TASKS':
        return handleSearchTasks(ctx, intent);
      case 'PRIORITIZE':
        return handlePrioritize(ctx);
      case 'CALENDAR_QUERY':
        return handleCalendarQuery(ctx, intent);
      case 'FREE_TIME_QUERY':
        return handleFreeTimeQuery(ctx, intent);
      case 'CREATE_EVENT':
      case 'UPDATE_EVENT':
        return handleCreateEvent(ctx, intent);
      case 'DELETE_EVENT':
        return handleDeleteEvent(ctx, intent);
      case 'EMAIL_QUERY':
        return this.handleEmailQuery(ctx);
      case 'DAILY_BRIEFING':
        return this.briefingPlaceholder(ctx);
      case 'CONFIRM_YES':
      case 'CONFIRM_NO':
        // The pending-confirmation branch already ran; nothing is open.
        return { reply: 'אין לי שאלה פתוחה כרגע.' };
      case 'HELP':
        return { reply: HELP_TEXT };
      case 'UNKNOWN':
      default:
        return { reply: 'לא בטוח שהבנתי. אפשר לנסח אחרת, או לכתוב "עזרה" כדי לראות מה אני יודע לעשות.' };
    }
  }

  /**
   * Wired by the app to the real briefing service. Kept as an injectable
   * property so the router has no dependency on the scheduler.
   */
  briefingPlaceholder: (ctx: HandlerContext) => Promise<HandlerResult> = async () => ({
    reply: 'הסיכום היומי לא מוגדר עדיין.',
  });

  private async handleEmailQuery(ctx: HandlerContext): Promise<HandlerResult> {
    const pending = await ctx.repos.email.listCandidates(ctx.user.id, 'pending', 10);
    if (!pending.length) return { reply: '📧 אין משימות חדשות שזיהיתי במיילים.' };
    const lines = pending.map((c, i) => `${i + 1}. ${c.title}${c.due_date ? ` (עד ${c.due_date})` : ''}`);
    return { reply: `📧 משימות שזיהיתי במיילים וממתינות לאישור:\n\n${lines.join('\n')}` };
  }

  /**
   * Reply buttons carry a structured id we minted ourselves, so they bypass
   * intent detection entirely. Ids are `action:taskIdPrefix` — the prefix is
   * matched against recent tasks rather than trusted as a full id.
   */
  private async handleButton(ctx: HandlerContext, buttonId: string): Promise<HandlerResult | null> {
    const [action, ref] = buttonId.split(':');
    if (!action || !ref) return null;

    if (action.startsWith('cand_')) {
      const candidates = await ctx.repos.email.listCandidates(ctx.user.id, undefined, 30);
      const candidate = candidates.find((c) => c.id.startsWith(ref));
      if (!candidate) return { reply: 'ההצעה כבר לא רלוונטית.' };

      if (action === 'cand_skip') {
        await ctx.repos.email.setCandidateStatus(candidate.id, 'ignored');
        await ctx.repos.audit.log({
          user_id: ctx.user.id, action: 'EMAIL_TASK_IGNORED', entity_type: 'email_task_candidate',
          entity_id: candidate.id, status: 'skipped',
        });
        return { reply: 'התעלמתי.' };
      }
      if (action === 'cand_later') {
        await ctx.repos.email.setCandidateStatus(candidate.id, 'snoozed', null, addMinutes(ctx.now, 240));
        return { reply: 'אזכיר לך על זה מאוחר יותר.' };
      }
      const created = await ctx.tasks.create(
        {
          user: ctx.user,
          title: candidate.title,
          description: candidate.description,
          due: candidate.due_date ? { date: candidate.due_date, time: candidate.due_time } : null,
          source: 'gmail',
          sourceId: candidate.email_message_id,
          sourceMetadata: { candidate_id: candidate.id, thread_id: candidate.thread_id },
          aiGenerated: true,
          confidence: candidate.confidence,
        },
        ctx.settings,
      );
      await ctx.repos.email.setCandidateStatus(candidate.id, 'approved', created.task.id);
      await ctx.repos.audit.log({
        user_id: ctx.user.id, action: 'EMAIL_TASK_APPROVED', entity_type: 'task',
        entity_id: created.task.id, result: { candidate_id: candidate.id },
      });
      return { reply: `✅ הוספתי: ${created.task.title}`, focusTaskId: created.task.id };
    }

    const recent = await ctx.repos.tasks.list(ctx.user.id, { limit: 200, includeSnoozed: true });
    const task = recent.find((t) => t.id.startsWith(ref));
    if (!task) return { reply: 'לא מצאתי את המשימה הזו.' };

    switch (action) {
      case 'done': {
        const { task: done, nextTask } = await ctx.tasks.complete(ctx.user, task, ctx.settings);
        return {
          reply: `✅ סימנתי כבוצע: ${done.title}${nextTask?.due_date ? `\n🔁 המופע הבא: ${nextTask.due_date}` : ''}`,
          focusTaskId: null,
        };
      }
      case 'snooze60': {
        const until = addMinutes(ctx.now, 60);
        await ctx.tasks.snooze(ctx.user, task, until, ctx.settings);
        return { reply: `⏰ אזכיר ${describeInstantHe(until, ctx.timezone, ctx.now)}`, focusTaskId: task.id };
      }
      case 'tomorrow': {
        const until = addMinutes(ctx.now, 24 * 60);
        await ctx.tasks.snooze(ctx.user, task, until, ctx.settings);
        return { reply: `🌅 אזכיר ${describeInstantHe(until, ctx.timezone, ctx.now)}`, focusTaskId: task.id };
      }
      default:
        return null;
    }
  }
}
