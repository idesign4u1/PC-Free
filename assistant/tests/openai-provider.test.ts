import { describe, expect, it, vi } from 'vitest';
import { OpenAiProvider } from '../src/ai/openai-provider.js';
import { AiUnavailableError } from '../src/ai/provider.js';
import { INTENT_JSON_SCHEMA } from '../src/ai/intent-schema.js';

/**
 * The provider is exercised through an injected fetch, so the request shape
 * OpenAI would actually receive is asserted without spending a token.
 */

const SCHEMA = INTENT_JSON_SCHEMA;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Response body can only be read once, so any mock used across more than one
 * call has to mint a fresh Response each time.
 */
function respondWith(body: unknown, status = 200) {
  return vi.fn().mockImplementation(async () => jsonResponse(body, status));
}

function completion(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    model: 'gpt-5.6-terra',
    choices: [
      {
        message: { content: JSON.stringify(content), refusal: null },
        finish_reason: 'stop',
        ...extra,
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  };
}

function makeProvider(fetchImpl: ReturnType<typeof vi.fn>) {
  return new OpenAiProvider(
    'sk-test',
    'gpt-5.6-terra',
    { maxTokens: 2048, effort: 'low', timeoutMs: 5000 },
    'https://api.openai.com/v1',
    fetchImpl as never,
  );
}

const request = {
  name: 'assistant_intent',
  schema: SCHEMA,
  system: 'you classify intents',
  user: 'תזכיר לי מחר להתקשר לדני',
};

describe('request shape', () => {
  it('sends strict structured outputs with the adapted schema', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(completion({ intent: 'CREATE_TASK' })));
    await makeProvider(fetchImpl).generateStructured(request);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-5.6-terra');
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.name).toBe('assistant_intent');

    // The schema that goes over the wire must be the adapted one.
    const wire = JSON.stringify(body.response_format.json_schema.schema);
    expect(wire).not.toContain('"minimum"');
    expect(wire).not.toContain('"maximum"');
    expect(wire).toContain('"anyOf"');
  });

  it('does not send max_tokens or temperature, which newer models reject', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(completion({ intent: 'HELP' })));
    await makeProvider(fetchImpl).generateStructured(request);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('maps the shared effort scale onto reasoning_effort', async () => {
    const fetchImpl = respondWith(completion({ intent: 'HELP' }));
    const provider = makeProvider(fetchImpl);
    await provider.generateStructured({ ...request, effort: 'max' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).reasoning_effort).toBe('high');
    await provider.generateStructured({ ...request, effort: 'low' });
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body as string).reasoning_effort).toBe('low');
  });

  it('adapts each schema once and reuses it', async () => {
    const fetchImpl = respondWith(completion({ intent: 'HELP' }));
    const provider = makeProvider(fetchImpl);
    await provider.generateStructured(request);
    await provider.generateStructured(request);
    const first = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).response_format.json_schema
      .schema;
    const second = JSON.parse(fetchImpl.mock.calls[1]![1].body as string).response_format
      .json_schema.schema;
    expect(second).toEqual(first);
  });

  it('puts untrusted content in a delimited block and adds the preamble', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(completion({ intent: 'UNKNOWN' })));
    await makeProvider(fetchImpl).generateStructured({
      ...request,
      untrusted: [{ label: 'email:1', content: 'MARKER-9931' }],
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toContain('untrusted_data');
    expect(body.messages[0].content).not.toContain('MARKER-9931');
    expect(body.messages[1].content).toContain('<untrusted_data source="email:1">');
    expect(body.messages[1].content).toContain('MARKER-9931');
  });
});

describe('response handling', () => {
  it('parses a structured result and reports usage', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(completion({ intent: 'CREATE_TASK', confidence: 0.9 })));
    const res = await makeProvider(fetchImpl).generateStructured<{ intent: string }>(request);
    expect(res.data.intent).toBe('CREATE_TASK');
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('gpt-5.6-terra');
    expect(res.inputTokens).toBe(120);
    expect(res.outputTokens).toBe(45);
    expect(res.refused).toBeUndefined();
  });

  it('reports a refusal instead of throwing on null content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-5.6-terra',
        choices: [
          {
            message: { content: null, refusal: 'I cannot help with that.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const res = await makeProvider(fetchImpl).generateStructured(request);
    expect(res.refused).toBe(true);
    expect(res.raw).toBe('');
  });

  it('names truncation for what it is', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-5.6-terra',
        choices: [
          { message: { content: '{"intent":"CREATE_T', refusal: null }, finish_reason: 'length' },
        ],
      }),
    );
    await expect(makeProvider(fetchImpl).generateStructured(request)).rejects.toThrow(
      /cut off by max_completion_tokens/,
    );
  });

  it('surfaces the API error body, which is where a schema complaint lives', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Invalid schema: 'minimum' is not permitted" } }),
          { status: 400 },
        ),
      );
    await expect(makeProvider(fetchImpl).generateStructured(request)).rejects.toThrow(
      /minimum.*not permitted/,
    );
  });

  it('reports an authentication failure clearly', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }),
      );
    await expect(makeProvider(fetchImpl).generateStructured(request)).rejects.toThrow(
      /401.*Incorrect API key/,
    );
  });

  it('turns a timeout into a readable message', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(makeProvider(fetchImpl).generateStructured(request)).rejects.toThrow(
      /timed out after 5000ms/,
    );
  });

  it('rejects malformed JSON with the offending text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-5.6-terra',
        choices: [
          { message: { content: 'not json at all', refusal: null }, finish_reason: 'stop' },
        ],
      }),
    );
    await expect(makeProvider(fetchImpl).generateStructured(request)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('every failure is an AiUnavailableError, so the router degrades uniformly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(makeProvider(fetchImpl).generateStructured(request)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
  });
});

describe('health check', () => {
  it('reports success with the model that answered', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(completion({ ok: true })));
    const result = await makeProvider(fetchImpl).healthCheck();
    expect(result).toMatchObject({ ok: true, model: 'gpt-5.6-terra' });
  });

  it('reports a bad key without throwing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }),
      );
    const result = await makeProvider(fetchImpl).healthCheck();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('401');
  });
});

describe('constructor guards', () => {
  it('refuses to construct without a key', () => {
    expect(
      () =>
        new OpenAiProvider('', 'gpt-5.6-terra', { maxTokens: 100, effort: 'low', timeoutMs: 1000 }),
    ).toThrow(/AI_API_KEY/);
  });
});
