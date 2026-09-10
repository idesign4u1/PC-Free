import type { Repositories } from '../db/repositories.js';
import type { User } from '../domain/types.js';
import { CUSTOMER_SERVICE_WINDOW_MS, type ReplyButton, type WhatsAppSender } from './client.js';
import { logger } from '../utils/logger.js';
import { truncateForStorage, hashPhone } from '../utils/redact.js';
import { errorText } from '../utils/errors.js';

export interface OutboundOptions {
  buttons?: ReplyButton[];
  /**
   * Template to fall back to when the 24-hour customer service window is
   * closed. Without one, an out-of-window send is skipped rather than failing
   * against Meta's API.
   */
  template?: { name: string; locale: string; bodyParams: string[] } | null;
  /** Proactive messages (reminders, briefings) respect the window; replies don't need to. */
  requiresOpenWindow?: boolean;
}

export interface OutboundResult {
  sent: boolean;
  messageId: string | null;
  usedTemplate: boolean;
  skippedReason?: 'window_closed_no_template' | 'send_failed';
  error?: string;
}

/**
 * Everything outbound goes through here so that:
 *  - the customer service window is checked once, in one place;
 *  - every send is recorded in whatsapp_messages and integration_logs;
 *  - a failure degrades (logged, reported) instead of throwing into a scheduler.
 */
export class Messenger {
  constructor(
    private readonly sender: WhatsAppSender,
    private readonly repos: Repositories,
  ) {}

  /** True while the user has messaged us within the last 24 hours. */
  async isWindowOpen(user: User, now: Date = new Date()): Promise<boolean> {
    const last = await this.repos.whatsapp.lastInboundAt(user.id);
    return Boolean(last && now.getTime() - last.getTime() < CUSTOMER_SERVICE_WINDOW_MS);
  }

  async send(user: User, body: string, opts: OutboundOptions = {}): Promise<OutboundResult> {
    const started = Date.now();
    const windowOpen = opts.requiresOpenWindow === false ? true : await this.isWindowOpen(user);

    try {
      let result;
      let kind: string;

      if (!windowOpen) {
        if (!opts.template) {
          logger().warn({ user: hashPhone(user.whatsapp_phone) }, 'outside 24h window and no template configured');
          await this.repos.integrationLogs.log({
            user_id: user.id,
            integration: 'whatsapp',
            operation: 'send',
            status: 'failure',
            error: 'customer service window closed and no template configured',
          });
          return { sent: false, messageId: null, usedTemplate: false, skippedReason: 'window_closed_no_template' };
        }
        result = await this.sender.sendTemplate(
          user.whatsapp_phone,
          opts.template.name,
          opts.template.locale,
          opts.template.bodyParams,
        );
        kind = 'template';
      } else if (opts.buttons?.length) {
        result = await this.sender.sendButtons(user.whatsapp_phone, body, opts.buttons);
        kind = 'interactive';
      } else {
        result = await this.sender.sendText(user.whatsapp_phone, body);
        kind = 'text';
      }

      await this.repos.whatsapp.recordOutbound({
        user_id: user.id,
        wa_message_id: result.messageId,
        wa_to: user.whatsapp_phone,
        message_type: kind,
        body: truncateForStorage(body),
        status: 'sent',
      });
      await this.repos.conversation.touchOutbound(user.id);
      await this.repos.integrationLogs.log({
        user_id: user.id,
        integration: 'whatsapp',
        operation: 'send',
        status: 'success',
        latency_ms: Date.now() - started,
        meta: { kind },
      });
      return { sent: true, messageId: result.messageId, usedTemplate: result.usedTemplate };
    } catch (err) {
      const message = errorText(err);
      logger().error({ err: message }, 'whatsapp send failed');
      await this.repos.whatsapp.recordOutbound({
        user_id: user.id,
        wa_message_id: null,
        wa_to: user.whatsapp_phone,
        message_type: 'text',
        body: truncateForStorage(body),
        status: 'failed',
        error: message,
      });
      await this.repos.integrationLogs.log({
        user_id: user.id,
        integration: 'whatsapp',
        operation: 'send',
        status: 'failure',
        latency_ms: Date.now() - started,
        error: message,
      });
      return { sent: false, messageId: null, usedTemplate: false, skippedReason: 'send_failed', error: message };
    }
  }
}
