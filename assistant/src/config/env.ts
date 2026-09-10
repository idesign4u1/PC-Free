import { z } from 'zod';

/**
 * Every runtime knob lives here. Nothing else in the codebase reads process.env,
 * so a missing credential fails fast at boot with a readable message instead of
 * surfacing as a 401 somewhere deep in an integration.
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TIMEZONE: z.string().default('Asia/Jerusalem'),

  DATABASE_URL: z.string().default(''),
  DATABASE_SSL: bool.default(false),

  // AES-256-GCM key for OAuth token encryption at rest: 32 bytes, base64 or hex.
  ENCRYPTION_KEY: z.string().default(''),

  // --- Meta WhatsApp Cloud API ---
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_GRAPH_VERSION: z.string().default('v25.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_TEMPLATE_REMINDER_NAME: z.string().default(''),
  WHATSAPP_TEMPLATE_LOCALE: z.string().default('he'),
  WHATSAPP_ALLOW_UNVERIFIED_WEBHOOK: bool.default(false),

  // --- AI ---
  AI_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  // --- Speech to text (voice notes) ---
  STT_PROVIDER: z.enum(['openai', 'none']).default('none'),
  STT_API_KEY: z.string().default(''),
  STT_MODEL: z.string().default('whisper-1'),
  STT_LANGUAGE: z.string().default('he'),

  // --- Google (Calendar + Gmail) ---
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_PATH: z.string().default('/oauth/google/callback'),

  // --- Microsoft (Outlook Calendar + Mail) ---
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_TENANT: z.string().default('common'),
  MICROSOFT_REDIRECT_PATH: z.string().default('/oauth/microsoft/callback'),

  // --- Runtime behaviour ---
  SCHEDULER_ENABLED: bool.default(true),
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30_000),
  REMINDER_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  ADMIN_TOKEN: z.string().default(''),
  BOOTSTRAP_USER_NAME: z.string().default('Shay'),
  BOOTSTRAP_USER_PHONE: z.string().default(''),
  BOOTSTRAP_USER_EMAIL: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema> & {
  googleRedirectUri: string;
  microsoftRedirectUri: string;
};

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const base = parsed.data;
  return {
    ...base,
    googleRedirectUri: new URL(base.GOOGLE_REDIRECT_PATH, base.APP_URL).toString(),
    microsoftRedirectUri: new URL(base.MICROSOFT_REDIRECT_PATH, base.APP_URL).toString(),
  };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function setEnvForTests(e: Env): void {
  cached = e;
}

/** Credentials a given capability needs, so the app can degrade instead of crashing. */
export interface CapabilityReport {
  whatsapp: boolean;
  ai: boolean;
  stt: boolean;
  google: boolean;
  microsoft: boolean;
  database: boolean;
  encryption: boolean;
}

export function capabilities(e: Env = env()): CapabilityReport {
  return {
    whatsapp: Boolean(e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_ACCESS_TOKEN && e.META_APP_SECRET),
    ai: Boolean(e.AI_API_KEY),
    stt: e.STT_PROVIDER !== 'none' && Boolean(e.STT_API_KEY),
    google: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
    microsoft: Boolean(e.MICROSOFT_CLIENT_ID && e.MICROSOFT_CLIENT_SECRET),
    database: Boolean(e.DATABASE_URL),
    encryption: Boolean(e.ENCRYPTION_KEY),
  };
}

/** Human-readable list of what is missing, used by /health and by boot logs. */
export function missingCredentials(e: Env = env()): string[] {
  const caps = capabilities(e);
  const out: string[] = [];
  if (!caps.database) out.push('DATABASE_URL');
  if (!caps.encryption) out.push('ENCRYPTION_KEY');
  if (!caps.whatsapp) out.push('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / META_APP_SECRET');
  if (!caps.ai) out.push('AI_API_KEY');
  if (!caps.google) out.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  if (!caps.microsoft) out.push('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET');
  if (!caps.stt) out.push('STT_PROVIDER / STT_API_KEY (voice notes)');
  return out;
}
