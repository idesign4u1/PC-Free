import type { AiProvider, StructuredRequest, StructuredResponse } from './provider.js';
import { AiUnavailableError } from './provider.js';
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from './sanitize.js';

interface ChatCompletion {
  model: string;
  choices: { message: { content: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * OpenAI implementation, present so the provider abstraction is real rather
 * than aspirational. Uses Chat Completions with a `json_schema` response format,
 * which gives the same guarantee as the Anthropic path.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly defaults: { maxTokens: number; timeoutMs: number },
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    if (!apiKey) throw new AiUnavailableError('AI_API_KEY is not configured');
  }

  async generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const untrusted = (req.untrusted ?? [])
      .map((u) => wrapUntrusted(u.label, u.content))
      .join('\n\n');
    const system = untrusted ? `${req.system}\n\n${UNTRUSTED_PREAMBLE}` : req.system;
    const user = untrusted ? `${req.user}\n\n${untrusted}` : req.user;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: req.maxTokens ?? this.defaults.maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: req.name, strict: true, schema: req.schema },
        },
      }),
      signal: AbortSignal.timeout(this.defaults.timeoutMs),
    });

    if (!res.ok) {
      throw new AiUnavailableError(
        `OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as ChatCompletion;
    const text = body.choices[0]?.message.content ?? '';
    if (!text.trim()) throw new AiUnavailableError('OpenAI returned an empty response');

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new AiUnavailableError('OpenAI response was not valid JSON');
    }

    return {
      data,
      raw: text,
      model: body.model,
      provider: this.name,
      latencyMs: Date.now() - started,
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    };
  }
}
