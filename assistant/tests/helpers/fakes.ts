import type { AiProvider, StructuredRequest, StructuredResponse } from '../../src/ai/provider.js';
import type { ReplyButton, SendResult, WhatsAppSender } from '../../src/whatsapp/client.js';
import type { Env } from '../../src/config/env.js';
import { loadEnv } from '../../src/config/env.js';

/** Records everything that would have been sent to WhatsApp. */
export class FakeSender implements WhatsAppSender {
  readonly sent: { to: string; body: string; kind: string; buttons?: ReplyButton[] }[] = [];
  shouldFail = false;

  async sendText(to: string, body: string): Promise<SendResult> {
    if (this.shouldFail) throw new Error('simulated WhatsApp failure');
    this.sent.push({ to, body, kind: 'text' });
    return { messageId: `wamid.test.${this.sent.length}`, usedTemplate: false };
  }

  async sendButtons(to: string, body: string, buttons: ReplyButton[]): Promise<SendResult> {
    if (this.shouldFail) throw new Error('simulated WhatsApp failure');
    this.sent.push({ to, body, kind: 'interactive', buttons });
    return { messageId: `wamid.test.${this.sent.length}`, usedTemplate: false };
  }

  async sendTemplate(to: string, name: string): Promise<SendResult> {
    this.sent.push({ to, body: name, kind: 'template' });
    return { messageId: `wamid.tpl.${this.sent.length}`, usedTemplate: true };
  }

  async downloadMedia(): Promise<{ data: Buffer; mimeType: string }> {
    return { data: Buffer.from('fake-audio'), mimeType: 'audio/ogg' };
  }

  last(): string {
    return this.sent[this.sent.length - 1]?.body ?? '';
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * A scripted AI provider: each entry is matched against the prompt's user text
 * and the first match wins. Keeps integration tests deterministic and offline
 * while still exercising the full validate → safety-gate → dispatch path.
 */
export class ScriptedAiProvider implements AiProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-test';
  readonly calls: StructuredRequest[] = [];

  constructor(private readonly script: { match: RegExp; data: unknown }[]) {}

  async generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    this.calls.push(req);
    const entry = this.script.find((s) => s.match.test(req.user));
    if (!entry)
      throw new Error(`ScriptedAiProvider has no entry matching: ${req.user.slice(0, 120)}`);
    return {
      data: entry.data as T,
      raw: JSON.stringify(entry.data),
      model: this.model,
      provider: this.name,
      latencyMs: 1,
      inputTokens: 10,
      outputTokens: 20,
    };
  }
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    TIMEZONE: 'Asia/Jerusalem',
    LOG_LEVEL: 'fatal',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    META_APP_SECRET: 'test-app-secret',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_VERIFY_TOKEN: 'test-verify',
    SCHEDULER_ENABLED: 'false',
    ADMIN_TOKEN: 'test-admin-token',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
