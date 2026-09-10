import { z } from 'zod';

/**
 * The intent contract.
 *
 * The model is never asked to "figure out what to do". It fills in one typed
 * envelope, validated here before anything is executed. Anything the schema
 * does not describe cannot reach a tool handler.
 *
 * Dates: the model may return either an absolute `date` (YYYY-MM-DD) or a
 * Hebrew `relative_expression`. Relative expressions are resolved locally by
 * `hebrew-datetime.ts` — the model does no date arithmetic, so DST and "next
 * Sunday" can never be wrong because a prompt hallucinated a calendar.
 */

export const INTENT_TYPES = [
  'CREATE_TASK',
  'UPDATE_TASK',
  'COMPLETE_TASK',
  'DELETE_TASK',
  'SNOOZE_TASK',
  'LIST_TASKS',
  'SEARCH_TASKS',
  'CREATE_EVENT',
  'UPDATE_EVENT',
  'DELETE_EVENT',
  'CALENDAR_QUERY',
  'FREE_TIME_QUERY',
  'EMAIL_QUERY',
  'DAILY_BRIEFING',
  'PRIORITIZE',
  'CONFIRM_YES',
  'CONFIRM_NO',
  'HELP',
  'UNKNOWN',
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

const DateSpec = z.object({
  /** Absolute local date, YYYY-MM-DD. */
  date: z.string().nullable(),
  /** Local time, HH:mm (24h). */
  time: z.string().nullable(),
  /** Verbatim Hebrew phrase, e.g. "מחר בבוקר" — resolved locally. */
  relative_expression: z.string().nullable(),
});

export const IntentSchema = z.object({
  intent: z.enum(INTENT_TYPES),
  confidence: z.number().min(0).max(1),
  /** One short Hebrew sentence explaining the reading, for the debug trail. */
  reasoning: z.string().nullable(),

  task: z
    .object({
      title: z.string().nullable(),
      description: z.string().nullable(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable(),
      status: z
        .enum(['inbox', 'open', 'in_progress', 'waiting', 'completed', 'cancelled'])
        .nullable(),
      project: z.string().nullable(),
      client: z.string().nullable(),
      tags: z.array(z.string()),
      /** When the work is actually due. */
      due: DateSpec.nullable(),
      /** When the user wants to be pinged — may differ from the due date. */
      reminder: DateSpec.nullable(),
      recurrence: z
        .object({
          freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
          interval: z.number().int().min(1).max(52),
          byweekday: z.array(z.number().int().min(0).max(6)),
          bymonthday: z.number().int().min(1).max(31).nullable(),
        })
        .nullable(),
    })
    .nullable(),

  /** Free-text reference to an existing task ("המשימה של דני"). */
  task_reference: z.string().nullable(),

  event: z
    .object({
      title: z.string().nullable(),
      start: DateSpec.nullable(),
      duration_minutes: z.number().int().min(5).max(1440).nullable(),
      location: z.string().nullable(),
      attendees: z.array(z.string()),
    })
    .nullable(),

  query: z
    .object({
      /** Local date range for calendar/task questions. */
      range: z
        .enum([
          'today',
          'tomorrow',
          'this_week',
          'next_week',
          'overdue',
          'all',
          'specific_date',
          'date_range',
        ])
        .nullable(),
      date: DateSpec.nullable(),
      end_date: DateSpec.nullable(),
      status: z
        .enum(['inbox', 'open', 'in_progress', 'waiting', 'completed', 'cancelled'])
        .nullable(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable(),
      search_text: z.string().nullable(),
      project: z.string().nullable(),
      client: z.string().nullable(),
      contact: z.string().nullable(),
      /** For FREE_TIME_QUERY: how long a slot the user needs. */
      slot_minutes: z.number().int().min(15).max(600).nullable(),
    })
    .nullable(),

  snooze: z
    .object({
      until: DateSpec.nullable(),
      /** "דחה בשעה" → 60. */
      minutes: z.number().int().min(5).max(20160).nullable(),
    })
    .nullable(),

  /** True when the user is asking to change or delete many items at once. */
  is_bulk: z.boolean(),
});

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Hand-written JSON Schema mirroring `IntentSchema`.
 *
 * It is written out rather than generated so that every provider receives the
 * identical contract, and so `additionalProperties: false` + full `required`
 * lists (which strict structured-output modes demand) are guaranteed.
 */
function dateSpec(): Record<string, unknown> {
  return {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: {
      date: { type: ['string', 'null'], description: 'Absolute local date YYYY-MM-DD' },
      time: { type: ['string', 'null'], description: 'Local time HH:mm, 24-hour' },
      relative_expression: {
        type: ['string', 'null'],
        description: 'Verbatim Hebrew relative phrase such as "מחר בבוקר" or "עוד שעתיים"',
      },
    },
    required: ['date', 'time', 'relative_expression'],
  };
}

export const INTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...INTENT_TYPES] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: ['string', 'null'] },
    task: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        title: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        priority: { type: ['string', 'null'], enum: ['low', 'normal', 'high', 'urgent', null] },
        status: {
          type: ['string', 'null'],
          enum: ['inbox', 'open', 'in_progress', 'waiting', 'completed', 'cancelled', null],
        },
        project: { type: ['string', 'null'] },
        client: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        due: dateSpec(),
        reminder: dateSpec(),
        recurrence: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
            interval: { type: 'integer', minimum: 1, maximum: 52 },
            byweekday: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
            bymonthday: { type: ['integer', 'null'], minimum: 1, maximum: 31 },
          },
          required: ['freq', 'interval', 'byweekday', 'bymonthday'],
        },
      },
      required: [
        'title',
        'description',
        'priority',
        'status',
        'project',
        'client',
        'tags',
        'due',
        'reminder',
        'recurrence',
      ],
    },
    task_reference: { type: ['string', 'null'] },
    event: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        title: { type: ['string', 'null'] },
        start: dateSpec(),
        duration_minutes: { type: ['integer', 'null'], minimum: 5, maximum: 1440 },
        location: { type: ['string', 'null'] },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'start', 'duration_minutes', 'location', 'attendees'],
    },
    query: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        range: {
          type: ['string', 'null'],
          enum: [
            'today',
            'tomorrow',
            'this_week',
            'next_week',
            'overdue',
            'all',
            'specific_date',
            'date_range',
            null,
          ],
        },
        date: dateSpec(),
        end_date: dateSpec(),
        status: {
          type: ['string', 'null'],
          enum: ['inbox', 'open', 'in_progress', 'waiting', 'completed', 'cancelled', null],
        },
        priority: { type: ['string', 'null'], enum: ['low', 'normal', 'high', 'urgent', null] },
        search_text: { type: ['string', 'null'] },
        project: { type: ['string', 'null'] },
        client: { type: ['string', 'null'] },
        contact: { type: ['string', 'null'] },
        slot_minutes: { type: ['integer', 'null'], minimum: 15, maximum: 600 },
      },
      required: [
        'range',
        'date',
        'end_date',
        'status',
        'priority',
        'search_text',
        'project',
        'client',
        'contact',
        'slot_minutes',
      ],
    },
    snooze: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        until: dateSpec(),
        minutes: { type: ['integer', 'null'], minimum: 5, maximum: 20160 },
      },
      required: ['until', 'minutes'],
    },
    is_bulk: { type: 'boolean' },
  },
  required: [
    'intent',
    'confidence',
    'reasoning',
    'task',
    'task_reference',
    'event',
    'query',
    'snooze',
    'is_bulk',
  ],
};

/** A safe, fully-populated intent used as a fallback and as a test fixture. */
export function emptyIntent(intent: IntentType = 'UNKNOWN', confidence = 0): Intent {
  return {
    intent,
    confidence,
    reasoning: null,
    task: null,
    task_reference: null,
    event: null,
    query: null,
    snooze: null,
    is_bulk: false,
  };
}
