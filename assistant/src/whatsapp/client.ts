import { IntegrationError, ReauthRequiredError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { hashPhone } from '../utils/redact.js';

/**
 * Meta WhatsApp Business Platform (Cloud API) client.
 *
 * Messaging-window rules, verified against Meta's Cloud API documentation:
 *  - A user message opens a 24-hour *customer service window*; each new inbound
 *    message resets it.
 *  - Inside the window you may send free-form ("service") messages of any type,
 *    including interactive reply buttons.
 *  - Outside the window only a pre-approved *template* may be sent. A reminder
 *    that fires more than 24h after the user last wrote therefore needs a
 *    Utility template — configure WHATSAPP_TEMPLATE_REMINDER_NAME and the client
 *    switches automatically.
 *
 * Note on cost: Meta announced that from 1 Oct 2026 utility templates and
 * service messages sent inside the window are billed. This client does not
 * change behaviour for that, but docs/META_SETUP.md flags it.
 */

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SendResult {
  messageId: string | null;
  usedTemplate: boolean;
}

export interface ReplyButton {
  /** Max 256 chars per the API; we keep ids short and structured. */
  id: string;
  /** Max 20 characters — longer titles are rejected by the API. */
  title: string;
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<SendResult>;
  sendButtons(to: string, body: string, buttons: ReplyButton[]): Promise<SendResult>;
  sendTemplate(to: string, name: string, locale: string, bodyParams: string[]): Promise<SendResult>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Interactive reply buttons: max 3, titles max 20 chars, body max 1024. */
export const MAX_BUTTONS = 3;
export const MAX_BUTTON_TITLE = 20;
export const MAX_BODY_CHARS = 4096;
export const MAX_INTERACTIVE_BODY_CHARS = 1024;

export function truncateButtonTitle(title: string): string {
  return title.length <= MAX_BUTTON_TITLE ? title : `${title.slice(0, MAX_BUTTON_TITLE - 1)}…`;
}

export class CloudApiSender implements WhatsAppSender {
  private readonly base: string;

  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    graphVersion: string,
    private readonly timeoutMs = 20_000,
  ) {
    this.base = `https://graph.facebook.com/${graphVersion}`;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: GraphError = {};
      try {
        parsed = JSON.parse(text) as GraphError;
      } catch {
        /* non-JSON error body */
      }
      const message = parsed.error?.message ?? text.slice(0, 300);
      if (res.status === 401 || parsed.error?.code === 190) {
        throw new ReauthRequiredError('whatsapp', `WhatsApp access token rejected: ${message}`);
      }
      throw new IntegrationError(
        'whatsapp',
        `WhatsApp send failed (${res.status}): ${message}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  private static messageId(response: Record<string, unknown>): string | null {
    const messages = response.messages as { id?: string }[] | undefined;
    return messages?.[0]?.id ?? null;
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    const response = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: body.slice(0, MAX_BODY_CHARS) },
    });
    logger().debug({ to: hashPhone(to) }, 'whatsapp text sent');
    return { messageId: CloudApiSender.messageId(response), usedTemplate: false };
  }

  async sendButtons(to: string, body: string, buttons: ReplyButton[]): Promise<SendResult> {
    const trimmed = buttons.slice(0, MAX_BUTTONS).map((b) => ({
      type: 'reply' as const,
      reply: { id: b.id.slice(0, 256), title: truncateButtonTitle(b.title) },
    }));
    const response = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, MAX_INTERACTIVE_BODY_CHARS) },
        action: { buttons: trimmed },
      },
    });
    logger().debug({ to: hashPhone(to), buttons: trimmed.length }, 'whatsapp buttons sent');
    return { messageId: CloudApiSender.messageId(response), usedTemplate: false };
  }

  async sendTemplate(
    to: string,
    name: string,
    locale: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    const response = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: locale },
        ...(bodyParams.length
          ? {
              components: [
                { type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) },
              ],
            }
          : {}),
      },
    });
    logger().debug({ to: hashPhone(to), template: name }, 'whatsapp template sent');
    return { messageId: CloudApiSender.messageId(response), usedTemplate: true };
  }

  /** Two-step: resolve the media id to a short-lived URL, then fetch the bytes. */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    const metaRes = await fetch(`${this.base}/${mediaId}`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!metaRes.ok) {
      throw new IntegrationError(
        'whatsapp',
        `Media lookup failed (${metaRes.status})`,
        metaRes.status,
      );
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) throw new IntegrationError('whatsapp', 'Media response had no URL');

    const binRes = await fetch(meta.url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs * 2),
    });
    if (!binRes.ok) {
      throw new IntegrationError(
        'whatsapp',
        `Media download failed (${binRes.status})`,
        binRes.status,
      );
    }
    return {
      data: Buffer.from(await binRes.arrayBuffer()),
      mimeType: meta.mime_type ?? binRes.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

/** Used when WhatsApp credentials are absent: logs instead of sending. */
export class NullSender implements WhatsAppSender {
  readonly sent: { to: string; body: string; kind: string }[] = [];

  async sendText(to: string, body: string): Promise<SendResult> {
    this.sent.push({ to, body, kind: 'text' });
    logger().warn({ to: hashPhone(to) }, 'WhatsApp not configured — message not sent');
    return { messageId: null, usedTemplate: false };
  }

  async sendButtons(to: string, body: string): Promise<SendResult> {
    this.sent.push({ to, body, kind: 'buttons' });
    return { messageId: null, usedTemplate: false };
  }

  async sendTemplate(to: string, name: string): Promise<SendResult> {
    this.sent.push({ to, body: name, kind: 'template' });
    return { messageId: null, usedTemplate: true };
  }

  async downloadMedia(): Promise<{ data: Buffer; mimeType: string }> {
    throw new IntegrationError(
      'whatsapp',
      'WhatsApp media download requires credentials',
      501,
      false,
    );
  }
}
