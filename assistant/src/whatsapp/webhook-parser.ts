import { z } from 'zod';

/**
 * Meta webhook payload → a normalised inbound message.
 *
 * The payload is deeply nested and carries status callbacks (delivered/read)
 * mixed in with real messages. We validate loosely: unknown fields are ignored
 * so a Meta schema addition never breaks ingestion, but everything we act on is
 * typed.
 */

const TextMessage = z.object({ body: z.string() });
const InteractiveReply = z.object({ id: z.string(), title: z.string().optional() });

const Message = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: TextMessage.optional(),
  button: z.object({ text: z.string().optional(), payload: z.string().optional() }).optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: InteractiveReply.optional(),
      list_reply: InteractiveReply.optional(),
    })
    .optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional(), voice: z.boolean().optional() }).optional(),
  voice: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
  image: z.object({ id: z.string(), caption: z.string().optional() }).optional(),
  document: z.object({ id: z.string(), filename: z.string().optional(), caption: z.string().optional() }).optional(),
  context: z.object({ id: z.string().optional(), forwarded: z.boolean().optional() }).optional(),
  errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional() })).optional(),
});

const Status = z.object({
  id: z.string(),
  status: z.string(),
  recipient_id: z.string().optional(),
  errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional() })).optional(),
});

const Change = z.object({
  field: z.string(),
  value: z.object({
    messaging_product: z.string().optional(),
    metadata: z.object({ display_phone_number: z.string().optional(), phone_number_id: z.string().optional() }).optional(),
    contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
    messages: z.array(Message).optional(),
    statuses: z.array(Status).optional(),
  }),
});

export const WebhookPayload = z.object({
  object: z.string(),
  entry: z.array(z.object({ id: z.string().optional(), changes: z.array(Change) })),
});

export type InboundKind = 'text' | 'button' | 'voice' | 'unsupported';

export interface InboundMessage {
  waMessageId: string;
  from: string;
  profileName: string | null;
  phoneNumberId: string | null;
  kind: InboundKind;
  /** Plain text, or the button title for an interactive reply. */
  text: string | null;
  /** Structured payload of an interactive reply button. */
  buttonId: string | null;
  /** Media id of a voice note, to be downloaded and transcribed. */
  audioMediaId: string | null;
  audioMimeType: string | null;
  isForwarded: boolean;
  timestamp: Date;
  rawType: string;
}

export interface StatusUpdate {
  waMessageId: string;
  status: string;
  error: string | null;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export function parseWebhook(body: unknown): ParsedWebhook {
  const parsed = WebhookPayload.safeParse(body);
  if (!parsed.success) return { messages: [], statuses: [] };

  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      const nameByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

      for (const m of value.messages ?? []) {
        const audio = m.audio ?? m.voice;
        const buttonReply = m.interactive?.button_reply ?? m.interactive?.list_reply;
        let kind: InboundKind = 'unsupported';
        let text: string | null = null;

        if (m.type === 'text' && m.text) {
          kind = 'text';
          text = m.text.body;
        } else if (buttonReply) {
          kind = 'button';
          text = buttonReply.title ?? buttonReply.id;
        } else if (m.button?.text) {
          // Quick-reply button on a template message.
          kind = 'button';
          text = m.button.text;
        } else if (audio) {
          kind = 'voice';
        } else if (m.image?.caption) {
          kind = 'text';
          text = m.image.caption;
        } else if (m.document?.caption) {
          kind = 'text';
          text = m.document.caption;
        }

        messages.push({
          waMessageId: m.id,
          from: m.from,
          profileName: nameByWaId.get(m.from) ?? null,
          phoneNumberId,
          kind,
          text,
          buttonId: buttonReply?.id ?? m.button?.payload ?? null,
          audioMediaId: audio?.id ?? null,
          audioMimeType: audio?.mime_type ?? null,
          isForwarded: Boolean(m.context?.forwarded),
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          rawType: m.type,
        });
      }

      for (const s of value.statuses ?? []) {
        statuses.push({
          waMessageId: s.id,
          status: s.status,
          error: s.errors?.[0]?.title ?? null,
        });
      }
    }
  }

  return { messages, statuses };
}
