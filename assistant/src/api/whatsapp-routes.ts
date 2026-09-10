import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { verifyMetaSignature } from '../utils/crypto.js';
import { parseWebhook, type InboundMessage } from '../whatsapp/webhook-parser.js';
import { logger } from '../utils/logger.js';
import { hashPhone, truncateForStorage } from '../utils/redact.js';
import { errorText } from '../utils/errors.js';
import type { HandlerContext } from '../orchestrator/context.js';

/**
 * Meta webhook endpoints.
 *
 * GET  /webhooks/whatsapp — the one-time subscription handshake.
 * POST /webhooks/whatsapp — inbound messages and delivery statuses.
 *
 * The POST handler answers 200 immediately and processes asynchronously: Meta
 * retries anything slower than a few seconds, which would duplicate work.
 * Duplicate delivery is still handled — `wa_message_id` is unique, and the
 * insert is the idempotency claim.
 */
export function registerWhatsAppRoutes(server: FastifyInstance, app: App): void {
  server.get('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token && token === app.env.WHATSAPP_VERIFY_TOKEN) {
      logger().info('whatsapp webhook verified');
      return reply.code(200).type('text/plain').send(challenge ?? '');
    }
    logger().warn({ mode }, 'whatsapp webhook verification rejected');
    return reply.code(403).send('Forbidden');
  });

  server.post('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    const verified = raw ? verifyMetaSignature(raw, signature, app.env.META_APP_SECRET) : false;
    if (!verified && !app.env.WHATSAPP_ALLOW_UNVERIFIED_WEBHOOK) {
      logger().warn('rejected webhook with an invalid X-Hub-Signature-256');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // Acknowledge first; Meta retries slow responses and that means duplicates.
    void reply.code(200).send({ received: true });

    try {
      const parsed = parseWebhook(req.body);
      for (const status of parsed.statuses) {
        if (status.error) {
          await app.repos.integrationLogs.log({
            integration: 'whatsapp',
            operation: 'delivery_status',
            status: 'failure',
            error: status.error,
            meta: { wa_message_id: status.waMessageId, status: status.status },
          });
        }
      }
      for (const message of parsed.messages) {
        await handleInbound(app, message);
      }
    } catch (err) {
      logger().error({ err: errorText(err) }, 'webhook processing failed');
    }
    return reply;
  });
}

export async function handleInbound(app: App, message: InboundMessage): Promise<void> {
  const now = new Date();
  const user = await app.repos.users.findByPhone(message.from);

  // Unknown sender: record and ignore. This is a personal assistant, not a bot
  // anyone can talk to.
  if (!user) {
    logger().warn({ from: hashPhone(message.from) }, 'inbound from an unregistered number — ignored');
    await app.repos.audit.log({
      action: 'INBOUND_UNKNOWN_SENDER',
      source: 'whatsapp',
      status: 'skipped',
      result: { from: hashPhone(message.from) },
    });
    return;
  }

  // Idempotency: the unique wa_message_id makes a replayed webhook a no-op.
  const isNew = await app.repos.whatsapp.recordInbound({
    user_id: user.id,
    wa_message_id: message.waMessageId,
    wa_from: message.from,
    message_type: message.kind,
    body: truncateForStorage(message.text),
    payload: { rawType: message.rawType, forwarded: message.isForwarded, buttonId: message.buttonId },
  });
  if (!isNew) {
    logger().debug({ waMessageId: message.waMessageId }, 'duplicate webhook delivery ignored');
    return;
  }

  await app.repos.conversation.touchInbound(user.id);
  const settings = await app.repos.settings.get(user.id);

  let text = message.text ?? '';
  let source = 'whatsapp';

  // Voice note → transcript → the same pipeline as a typed message.
  if (message.kind === 'voice' && message.audioMediaId) {
    source = 'whatsapp_voice';
    if (!app.stt) {
      await app.messenger.send(user, 'קיבלתי הודעה קולית, אבל תמלול לא מוגדר אצלי עדיין.');
      return;
    }
    try {
      const media = await app.sender.downloadMedia(message.audioMediaId);
      const transcript = await app.stt.transcribe(media.data, message.audioMimeType ?? media.mimeType, {
        language: user.locale === 'he' ? 'he' : undefined,
      });
      text = transcript.text;
      await app.repos.ai.log({
        user_id: user.id,
        kind: 'transcription',
        provider: transcript.provider,
        model: transcript.model,
        latency_ms: transcript.latencyMs,
        structured_output: { chars: transcript.text.length, language: transcript.language },
      });
      await app.repos.integrationLogs.log({
        user_id: user.id, integration: 'stt', operation: 'transcribe', status: 'success',
        latency_ms: transcript.latencyMs,
      });
    } catch (err) {
      await app.repos.integrationLogs.log({
        user_id: user.id, integration: 'stt', operation: 'transcribe', status: 'failure', error: errorText(err),
      });
      logger().error({ err: errorText(err) }, 'voice transcription failed');
      await app.messenger.send(user, 'לא הצלחתי להבין את ההקלטה. אפשר לשלוח שוב או לכתוב?');
      return;
    }
  }

  if (message.kind === 'unsupported' && !text) {
    await app.messenger.send(user, 'אני יודע לקרוא טקסט והודעות קוליות. מה תרצה שאעשה?');
    return;
  }

  const ctx: HandlerContext = {
    repos: app.repos,
    tasks: app.tasks,
    calendar: app.calendar,
    messenger: app.messenger,
    ai: app.ai,
    user,
    settings,
    now,
    timezone: user.timezone,
    source,
  };

  const result = await app.router.route(ctx, {
    text,
    buttonId: message.buttonId ?? null,
    untrusted: message.isForwarded,
  });

  if (result.focusTaskId !== undefined) {
    await app.repos.conversation.setLastTask(user.id, result.focusTaskId);
  }
  if (result.pendingConfirmation) {
    await app.repos.confirmations.create({
      user_id: user.id,
      kind: result.pendingConfirmation.kind,
      payload: result.pendingConfirmation.payload,
      prompt: result.pendingConfirmation.prompt,
      ...(result.pendingConfirmation.ttlMinutes ? { ttlMinutes: result.pendingConfirmation.ttlMinutes } : {}),
    });
  }
  if (result.reply) {
    await app.messenger.send(user, result.reply, {
      ...(result.buttons ? { buttons: result.buttons } : {}),
      requiresOpenWindow: false, // a reply to an inbound message is always in-window
    });
  }
}
