import type { Env } from '../config/env.js';
import type { AiProvider } from './provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAiProvider } from './openai-provider.js';

export function createAiProvider(env: Env): AiProvider | null {
  if (!env.AI_API_KEY) return null;
  if (env.AI_PROVIDER === 'openai') {
    return new OpenAiProvider(env.AI_API_KEY, env.AI_MODEL, {
      maxTokens: env.AI_MAX_TOKENS,
      timeoutMs: env.AI_TIMEOUT_MS,
    });
  }
  return new AnthropicProvider(env.AI_API_KEY, env.AI_MODEL, {
    maxTokens: env.AI_MAX_TOKENS,
    effort: env.AI_EFFORT,
    timeoutMs: env.AI_TIMEOUT_MS,
  });
}
