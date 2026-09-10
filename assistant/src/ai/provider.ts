/**
 * Provider-agnostic AI surface.
 *
 * The rest of the system never imports an SDK directly — it asks for a
 * *structured* result validated against a JSON Schema. Swapping Anthropic for
 * OpenAI (or adding a third provider) means implementing this interface and
 * nothing else.
 */
export interface StructuredRequest {
  /** Schema name; some providers surface it to the model. */
  name: string;
  /** JSON Schema (draft 2020-12 subset) describing the required output. */
  schema: Record<string, unknown>;
  system: string;
  /** Trusted instruction content authored by us. */
  user: string;
  /** Untrusted third-party content (email body, forwarded message). */
  untrusted?: { label: string; content: string }[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface StructuredResponse<T> {
  data: T;
  raw: string;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Set when the model declined to answer rather than producing output. */
  refused?: boolean;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>>;
  /** Short free-text generation, used for briefing prose. Optional. */
  generateText?(input: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ text: string; latencyMs: number }>;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}
