import type { AiProvider, StructuredRequest, StructuredResponse } from './provider.js';
import { AiUnavailableError } from './provider.js';
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from './sanitize.js';
import { schemaDepth, toOpenAiStrictSchema } from './openai-schema.js';

/**
 * OpenAI implementation, via Chat Completions with strict Structured Outputs.
 *
 * Three things differ from the Anthropic path and are handled here:
 *
 *  1. **Schema dialect.** Strict mode accepts a small subset of JSON Schema and
 *     rejects the whole request on an unsupported keyword, so the canonical
 *     schema is rewritten by `toOpenAiStrictSchema` on the way out. Ranges it
 *     drops are still enforced afterwards by Zod.
 *  2. **Refusals are a field, not a status.** A refused request returns HTTP
 *     200 with `message.refusal` set and `content` null. Parsing `content`
 *     without checking would throw on a perfectly normal outcome.
 *  3. **Reasoning effort** is `reasoning_effort` with its own scale, so the
 *     shared setting is mapped rather than passed through.
 */

interface ChatCompletion {
  model: string;
  choices: {
    message: { content: string | null; refusal?: string | null };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Our shared scale is Anthropic's; OpenAI's stops at `high`. */
function toReasoningEffort(
  effort: StructuredRequest['effort'],
): 'minimal' | 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return 'low';
  }
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private readonly adaptedSchemas = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly defaults: {
      maxTokens: number;
      effort: StructuredRequest['effort'];
      timeoutMs: number;
    },
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!apiKey) throw new AiUnavailableError('AI_API_KEY is not configured');
  }

  /** Adapting is pure and the schemas are fixed, so do it once per schema. */
  private schemaFor(req: StructuredRequest): Record<string, unknown> {
    const cached = this.adaptedSchemas.get(req.name);
    if (cached) return cached;
    const adapted = toOpenAiStrictSchema(req.schema);
    const depth = schemaDepth(adapted);
    if (depth > 5) {
      throw new AiUnavailableError(
        `Schema "${req.name}" nests ${depth} levels; OpenAI strict Structured Outputs allows at most 5`,
      );
    }
    this.adaptedSchemas.set(req.name, adapted);
    return adapted;
  }

  async generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const untrusted = (req.untrusted ?? [])
      .map((u) => wrapUntrusted(u.label, u.content))
      .join('\n\n');
    const system = untrusted ? `${req.system}\n\n${UNTRUSTED_PREAMBLE}` : req.system;
    const user = untrusted ? `${req.user}\n\n${untrusted}` : req.user;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: req.maxTokens ?? this.defaults.maxTokens,
          reasoning_effort: toReasoningEffort(req.effort ?? this.defaults.effort),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: req.name,
              strict: true,
              schema: this.schemaFor(req),
            },
          },
        }),
        signal: AbortSignal.timeout(this.defaults.timeoutMs),
      });
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      throw new AiUnavailableError(
        err instanceof Error && err.name === 'TimeoutError'
          ? `OpenAI request timed out after ${this.defaults.timeoutMs}ms`
          : `OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      // A 400 on a structured request is almost always the schema, and the
      // message is the only way to find out which keyword upset it.
      throw new AiUnavailableError(`OpenAI API error ${res.status}: ${detail}`);
    }

    const body = (await res.json()) as ChatCompletion;
    const latencyMs = Date.now() - started;
    const choice = body.choices[0];
    const usage = {
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    };

    // A refusal is a normal 200 response with content null — check it first.
    if (choice?.message.refusal) {
      return {
        data: {} as T,
        raw: '',
        model: body.model,
        provider: this.name,
        latencyMs,
        ...usage,
        refused: true,
      };
    }

    // Hitting the output cap truncates the JSON; say so rather than reporting
    // "invalid JSON", which sends you looking in the wrong place.
    if (choice?.finish_reason === 'length') {
      throw new AiUnavailableError(
        'OpenAI response was cut off by max_completion_tokens — raise AI_MAX_TOKENS',
      );
    }

    const text = choice?.message.content ?? '';
    if (!text.trim()) throw new AiUnavailableError('OpenAI returned an empty response');

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new AiUnavailableError(`OpenAI response was not valid JSON (${text.slice(0, 200)})`);
    }

    return { data, raw: text, model: body.model, provider: this.name, latencyMs, ...usage };
  }

  async generateText(input: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ text: string; latencyMs: number }> {
    const started = Date.now();
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: input.maxTokens ?? 1024,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
      signal: AbortSignal.timeout(this.defaults.timeoutMs),
    });
    if (!res.ok)
      throw new AiUnavailableError(
        `OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    const body = (await res.json()) as ChatCompletion;
    return { text: body.choices[0]?.message.content ?? '', latencyMs: Date.now() - started };
  }

  /**
   * A tiny live round-trip used by /api/ai-check, so a wrong key or a model id
   * that has been retired surfaces as a clear message instead of every message
   * silently falling back to the rules path.
   */
  async healthCheck(): Promise<
    { ok: true; model: string; latencyMs: number } | { ok: false; error: string }
  > {
    try {
      const res = await this.generateStructured<{ ok: boolean }>({
        name: 'health_check',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        system: 'Reply with {"ok": true}.',
        user: 'ping',
        maxTokens: 300,
      });
      return { ok: true, model: res.model, latencyMs: res.latencyMs };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
