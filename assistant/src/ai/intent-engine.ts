import { DateTime } from 'luxon';
import type { AiProvider } from './provider.js';
import { AiUnavailableError } from './provider.js';
import { INTENT_JSON_SCHEMA, IntentSchema, emptyIntent, type Intent } from './intent-schema.js';
import {
  parseHebrewDateTime,
  stripDateExpression,
  stripLeadPhrases,
} from '../nlp/hebrew-datetime.js';
import { hebrewWeekdayName, type LocalDate } from '../utils/time.js';
import { sanitizeUntrusted } from './sanitize.js';

export interface IntentContext {
  now: Date;
  timezone: string;
  userName: string;
  /** Set when the last outbound message asked a question. */
  pendingQuestion?: { kind: string; prompt: string; options?: string[] } | null;
  /** Title of the task the user most recently touched, for "דחה את זה". */
  lastTaskTitle?: string | null;
  /**
   * True when the text did not originate from the user themselves (a forwarded
   * message, quoted email text). Untrusted text has every injection heuristic
   * applied, not just the instruction-override ones.
   */
  untrusted?: boolean;
}

export interface IntentResult {
  intent: Intent;
  /** 'rules' when resolved without an LLM call. */
  resolvedBy: 'rules' | 'model';
  model: string | null;
  provider: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  injectionFlags: string[];
  error?: string;
}

/* --------------------------------------------------------------- fast path */

interface Rule {
  re: RegExp;
  build: (m: RegExpExecArray, text: string, ctx: IntentContext) => Intent | null;
}

function normalise(input: string): string {
  return input.replace(/[־–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic rules for the phrasings that make up the bulk of daily traffic.
 * Every one of these would otherwise cost a model round-trip and introduce a
 * chance of misreading. They are checked first; anything else falls through to
 * the model.
 */
const RULES: Rule[] = [
  // Plain confirmations answering a pending question.
  {
    re: /^(כן|אישור|בטח|אוקיי|אוקי|ok|yes|כן בבקשה|תעשה|קדימה|אשר)$/iu,
    build: (_m, _t, ctx) => (ctx.pendingQuestion ? { ...emptyIntent('CONFIRM_YES', 0.99) } : null),
  },
  {
    re: /^(לא|לא תודה|בטל|ביטול|עזוב|no|cancel|התעלם)$/iu,
    build: (_m, _t, ctx) => (ctx.pendingQuestion ? { ...emptyIntent('CONFIRM_NO', 0.99) } : null),
  },
  // Completion replies to a reminder.
  {
    re: /^(בוצע|סיימתי|עשיתי|נעשה|done|✅|✔️|גמרתי|טופל|כבר עשיתי את זה|עזוב,? כבר עשיתי)$/iu,
    build: () => ({ ...emptyIntent('COMPLETE_TASK', 0.97) }),
  },
  // Snooze replies.
  {
    re: /^(דחה|דחי|תדחה)\s*(ב)?שעה$|^שעה$|^עוד שעה$/u,
    build: () => ({ ...emptyIntent('SNOOZE_TASK', 0.95), snooze: { until: null, minutes: 60 } }),
  },
  {
    re: /^(דחה|תדחה)?\s*למחר$|^מחר$|^🌅$/u,
    build: () => ({
      ...emptyIntent('SNOOZE_TASK', 0.95),
      snooze: { until: { date: null, time: null, relative_expression: 'מחר' }, minutes: null },
    }),
  },
  // Task listings.
  {
    re: /^(מה ה?משימות שלי|מה המשימות|משימות|תראה לי משימות|רשימת משימות|מה יש לי לעשות)\??$/u,
    build: () => ({ ...emptyIntent('LIST_TASKS', 0.96), query: emptyQuery({ range: 'all' }) }),
  },
  {
    re: /^(מה לא הספקתי|מה באיחור|משימות באיחור|מה עבר את הזמן|איזה משימות באיחור)\??$/u,
    build: () => ({ ...emptyIntent('LIST_TASKS', 0.95), query: emptyQuery({ range: 'overdue' }) }),
  },
  {
    re: /^(מה דחוף( לי)?( היום)?|מה הכי דחוף)\??$/u,
    build: () => ({
      ...emptyIntent('LIST_TASKS', 0.94),
      query: emptyQuery({ range: 'today', priority: 'urgent' }),
    }),
  },
  {
    re: /^(מה הכי חשוב( שאעשה)?( עכשיו)?|מה לעשות עכשיו|במה להתחיל|מה אני צריך לעשות עכשיו)\??$/u,
    build: () => ({ ...emptyIntent('PRIORITIZE', 0.94) }),
  },
  // Calendar questions.
  {
    re: /^(מה יש לי היום|מה יש לי ביומן היום|מה התוכניות שלי היום|היומן שלי היום)\??$/u,
    build: () => ({
      ...emptyIntent('CALENDAR_QUERY', 0.96),
      query: emptyQuery({ range: 'today' }),
    }),
  },
  {
    re: /^(מה יש לי מחר|מה יש לי ביומן מחר|היומן שלי מחר)\??$/u,
    build: () => ({
      ...emptyIntent('CALENDAR_QUERY', 0.96),
      query: emptyQuery({ range: 'tomorrow' }),
    }),
  },
  {
    re: /^(מה יש לי השבוע|היומן שלי השבוע)\??$/u,
    build: () => ({
      ...emptyIntent('CALENDAR_QUERY', 0.95),
      query: emptyQuery({ range: 'this_week' }),
    }),
  },
  {
    re: /^(בוקר טוב|סיכום יומי|תן לי סיכום של היום|מה התוכנית להיום)\??$/u,
    build: () => ({ ...emptyIntent('DAILY_BRIEFING', 0.93) }),
  },
  {
    re: /^(עזרה|help|מה אתה יודע לעשות|מה אפשר לעשות|\?)$/iu,
    build: () => ({ ...emptyIntent('HELP', 0.98) }),
  },
];

function emptyQuery(
  overrides: Partial<NonNullable<Intent['query']>> = {},
): NonNullable<Intent['query']> {
  return {
    range: null,
    date: null,
    end_date: null,
    status: null,
    priority: null,
    search_text: null,
    project: null,
    client: null,
    contact: null,
    slot_minutes: null,
    ...overrides,
  };
}

/**
 * "תזכיר לי מחר ב-10 להתקשר לדני" is unambiguous: an explicit reminder verb
 * plus a resolvable date. We build the CREATE_TASK intent locally and skip the
 * model entirely.
 */
function tryReminderFastPath(text: string, ctx: IntentContext): Intent | null {
  // Note: \b is an ASCII word boundary and never matches next to a Hebrew
  // letter — use an explicit lookahead instead.
  if (!/^(תזכיר|תזכירי|הזכר|להזכיר|תזכור)\s+לי(?=\s|$)/u.test(text)) return null;
  const parsed = parseHebrewDateTime(text, { now: ctx.now, timezone: ctx.timezone });
  if (!parsed.date || parsed.confidence < 0.8) return null;
  const title = stripLeadPhrases(stripDateExpression(text, parsed));
  if (title.length < 2) return null;
  return {
    ...emptyIntent('CREATE_TASK', 0.93),
    reasoning: 'ניסוח תזכורת מפורש עם תאריך חד־משמעי',
    task: {
      title,
      description: null,
      priority: null,
      status: null,
      project: null,
      client: null,
      tags: [],
      due: parsed.isDeadline
        ? { date: parsed.date, time: parsed.time, relative_expression: null }
        : null,
      reminder: { date: parsed.date, time: parsed.time, relative_expression: null },
      recurrence: null,
    },
  };
}

export function resolveByRules(rawText: string, ctx: IntentContext): Intent | null {
  const text = normalise(rawText);
  if (!text) return null;
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) {
      const built = rule.build(m, text, ctx);
      if (built) return built;
    }
  }
  return tryReminderFastPath(text, ctx);
}

/* -------------------------------------------------------------- LLM prompt */

function buildSystemPrompt(ctx: IntentContext): string {
  const now = DateTime.fromJSDate(ctx.now, { zone: ctx.timezone });
  const today = now.toFormat('yyyy-MM-dd');
  const weekday = hebrewWeekdayName(today, ctx.timezone);
  return `אתה מנוע זיהוי כוונות (intent engine) של עוזר אישי לניהול משימות ויומן עבור ${ctx.userName}.
המשתמש כותב בעברית טבעית, לעיתים עם מילים באנגלית. אתה לא עונה למשתמש — אתה רק ממלא JSON לפי הסכימה.

ההקשר הנוכחי:
- עכשיו: ${now.toFormat('yyyy-MM-dd HH:mm')} (יום ${weekday}), אזור זמן ${ctx.timezone}
- השבוע בישראל מתחיל ביום ראשון.
${ctx.lastTaskTitle ? `- המשימה האחרונה שהמשתמש התייחס אליה: "${ctx.lastTaskTitle}"` : ''}
${ctx.pendingQuestion ? `- שאלה פתוחה שנשאלה כרגע: "${ctx.pendingQuestion.prompt}"` : ''}

כללים מחייבים:
1. הבחן בין TASK (משהו שצריך לבצע) לבין CALENDAR EVENT (משהו שקורה בזמן מסוים).
   "להכין מצגת לאורקל" = CREATE_TASK. "פגישה עם יוסי ביום שני ב-14:00" = CREATE_EVENT.
   אל תהפוך משימה לאירוע ביומן אלא אם המשתמש ביקש לקבוע/לשריין זמן.
2. תאריכים: אם המשתמש נקב בביטוי יחסי בעברית ("מחר בבוקר", "עוד שעתיים", "ביום ראשון",
   "בסוף החודש") — החזר אותו כמות שהוא בשדה relative_expression והשאר date ו-time ריקים (null).
   אל תחשב תאריכים בעצמך. רק אם המשתמש נקב בתאריך מפורש (12/10) או שעה מפורשת (14:30),
   מלא date/time.
3. due הוא מועד היעד של המשימה. reminder הוא מתי להזכיר. הם לא אותו דבר:
   "צריך לשלוח עד 18:00, תזכיר לי ב-15:00" → due=18:00, reminder=15:00.
   אם נאמר רק "תזכיר לי מחר ב-10" — מלא reminder בלבד.
   אם נאמר רק "עד יום ראשון" — מלא due בלבד.
4. אל תמציא כותרת, פרויקט, לקוח או תאריך שלא נאמרו. שדה שלא נאמר = null.
5. priority: הצע עדיפות רק כשיש רמז ברור בטקסט ("דחוף", "בהקדם", "קריטי"). אחרת null.
6. אם המשתמש מתייחס למשימה קיימת בלי לצטט אותה במדויק ("סיימתי את המשימה של דני",
   "תעביר את זה למחר") — שים את הביטוי בשדה task_reference ואל תמלא task.title.
7. is_bulk=true כשהבקשה נוגעת להרבה פריטים בבת אחת ("מחק את כל המשימות", "סמן הכל כבוצע").
8. confidence: 0.9+ כשהכוונה ברורה לגמרי; 0.5-0.8 כשיש ניחוש; מתחת ל-0.5 השתמש ב-UNKNOWN.
9. אם אינך מבין — intent=UNKNOWN. אל תנחש פעולה הרסנית.

דוגמאות:
- "צריך לשלוח הצעה לאביב עד יום ראשון" → CREATE_TASK, title="לשלוח הצעה לאביב",
  due.relative_expression="יום ראשון", reminder=null, client/project=null (אביב הוא איש קשר, לא לקוח מוצהר).
- "קבע לי ביום ראשון ב-13:00 שעה לעבוד על המצגת לאורקל" → CREATE_EVENT,
  event.title="לעבוד על המצגת לאורקל", event.start.relative_expression="יום ראשון",
  event.start.time="13:00", duration_minutes=60.
- "מתי אני פנוי מחר לשעה?" → FREE_TIME_QUERY, query.range="tomorrow", query.slot_minutes=60.
- "תראה לי רק דברים של aisolution" → SEARCH_TASKS, query.search_text="aisolution".
- "מה מחכה לי מדני?" → SEARCH_TASKS, query.contact="דני".
- "תעביר את המשימה של אביב ליום ראשון" → UPDATE_TASK, task_reference="המשימה של אביב",
  task.due.relative_expression="יום ראשון".`;
}

/* --------------------------------------------------------------- resolving */

/**
 * Turns a DateSpec into a concrete local date/time. A `relative_expression`
 * from the model is resolved by the deterministic Hebrew parser, so the model
 * never performs date arithmetic.
 */
export function resolveDateSpec(
  spec: { date: string | null; time: string | null; relative_expression: string | null } | null,
  ctx: { now: Date; timezone: string },
): { date: LocalDate | null; time: string | null; explicitTime: boolean } {
  if (!spec) return { date: null, time: null, explicitTime: false };

  if (spec.relative_expression) {
    const parsed = parseHebrewDateTime(spec.relative_expression, {
      now: ctx.now,
      timezone: ctx.timezone,
    });
    if (parsed.date) {
      return {
        date: parsed.date,
        time: spec.time ?? parsed.time,
        explicitTime: Boolean(spec.time) || parsed.explicitTime,
      };
    }
  }
  if (spec.date && /^\d{4}-\d{2}-\d{2}$/.test(spec.date)) {
    return { date: spec.date, time: spec.time, explicitTime: Boolean(spec.time) };
  }
  if (spec.time && !spec.date) {
    // A time with no date: resolve through the parser so "past time → tomorrow"
    // behaves identically to the rules path.
    const parsed = parseHebrewDateTime(`ב-${spec.time}`, { now: ctx.now, timezone: ctx.timezone });
    return { date: parsed.date, time: parsed.time ?? spec.time, explicitTime: true };
  }
  return { date: null, time: null, explicitTime: false };
}

export class IntentEngine {
  constructor(private readonly provider: AiProvider | null) {}

  async detect(rawText: string, ctx: IntentContext): Promise<IntentResult> {
    const sanitized = sanitizeUntrusted(rawText, 4000);

    const byRules = resolveByRules(sanitized.content, ctx);
    if (byRules) {
      return {
        intent: byRules,
        resolvedBy: 'rules',
        model: null,
        provider: null,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        injectionFlags: sanitized.flags,
      };
    }

    if (!this.provider) {
      return {
        intent: emptyIntent('UNKNOWN', 0),
        resolvedBy: 'rules',
        model: null,
        provider: null,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        injectionFlags: sanitized.flags,
        error: 'ai_not_configured',
      };
    }

    try {
      const res = await this.provider.generateStructured<unknown>({
        name: 'assistant_intent',
        schema: INTENT_JSON_SCHEMA,
        system: buildSystemPrompt(ctx),
        user: sanitized.content,
      });

      if (res.refused) {
        return {
          intent: emptyIntent('UNKNOWN', 0),
          resolvedBy: 'model',
          model: res.model,
          provider: res.provider,
          latencyMs: res.latencyMs,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          injectionFlags: sanitized.flags,
          error: 'model_refused',
        };
      }

      const parsed = IntentSchema.safeParse(res.data);
      if (!parsed.success) {
        return {
          intent: emptyIntent('UNKNOWN', 0),
          resolvedBy: 'model',
          model: res.model,
          provider: res.provider,
          latencyMs: res.latencyMs,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          injectionFlags: sanitized.flags,
          error: `schema_validation_failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        };
      }

      let intent = parsed.data;
      // An instruction-override attempt can never produce a high-confidence
      // intent. A destructive *request* from the user is legitimate — it is
      // gated by the confirmation flow, not suppressed here.
      const suppress =
        sanitized.overrideFlags.length > 0 ||
        (ctx.untrusted === true && sanitized.flags.length > 0);
      if (suppress) intent = { ...intent, confidence: Math.min(intent.confidence, 0.4) };

      return {
        intent,
        resolvedBy: 'model',
        model: res.model,
        provider: res.provider,
        latencyMs: res.latencyMs,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        injectionFlags: sanitized.flags,
      };
    } catch (err) {
      return {
        intent: emptyIntent('UNKNOWN', 0),
        resolvedBy: 'model',
        model: this.provider.model,
        provider: this.provider.name,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        injectionFlags: sanitized.flags,
        error: err instanceof AiUnavailableError ? err.message : String(err),
      };
    }
  }
}
