import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider, StructuredRequest, StructuredResponse } from './provider.js';
import { AiUnavailableError } from './provider.js';
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from './sanitize.js';

/**
 * Anthropic implementation.
 *
 * Uses the Messages API with `output_config.format` (structured outputs) so the
 * response is guaranteed to match the JSON Schema — no regex-scraping of prose.
 * Effort is configurable and defaults to `low` for intent parsing: this is a
 * short classification on a latency-sensitive chat path, not a reasoning task.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly defaults: { maxTokens: number; effort: StructuredRequest['effort']; timeoutMs: number },
  ) {
    if (!apiKey) throw new AiUnavailableError('AI_API_KEY is not configured');
    this.client = new Anthropic({ apiKey, timeout: defaults.timeoutMs, maxRetries: 2 });
  }

  async generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const untrusted = (req.untrusted ?? []).map((u) => wrapUntrusted(u.label, u.content)).join('\n\n');
    const system = untrusted ? `${req.system}\n\n${UNTRUSTED_PREAMBLE}` : req.system;
    const user = untrusted ? `${req.user}\n\n${untrusted}` : req.user;

    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? this.defaults.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: {
          effort: req.effort ?? this.defaults.effort,
          format: { type: 'json_schema', schema: req.schema },
        },
      });
    } catch (err) {
      throw new AiUnavailableError(
        err instanceof Anthropic.APIError ? `Anthropic API error ${err.status}: ${err.message}` : String(err),
      );
    }

    const latencyMs = Date.now() - started;

    // A refusal is an HTTP 200 with no usable content — never read `content` first.
    if (response.stop_reason === 'refusal') {
      return {
        data: {} as T,
        raw: '',
        model: response.model,
        provider: this.name,
        latencyMs,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        refused: true,
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) throw new AiUnavailableError('Anthropic returned an empty response');

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new AiUnavailableError(`Anthropic response was not valid JSON (${text.slice(0, 200)})`);
    }

    return {
      data,
      raw: text,
      model: response.model,
      provider: this.name,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  async generateText(input: { system: string; user: string; maxTokens?: number }): Promise<{ text: string; latencyMs: number }> {
    const started = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: input.maxTokens ?? 1024,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
      output_config: { effort: 'low' },
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, latencyMs: Date.now() - started };
  }
}
