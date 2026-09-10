import pino from 'pino';

/**
 * Keys whose values never reach the logs. Email bodies, message text, OAuth
 * tokens and phone numbers are all either redacted or hashed at the call site;
 * this is the belt-and-braces layer for anything that slips through.
 */
const REDACT_PATHS = [
  'access_token',
  'refresh_token',
  'authorization',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.password',
  'body',
  '*.body',
  'text',
  '*.text',
  'snippet',
  '*.snippet',
];

let root: pino.Logger | null = null;

export function initLogger(level: string, pretty: boolean): pino.Logger {
  root = pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'shay-ai-assistant' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
  return root;
}

export function logger(): pino.Logger {
  root ??= pino({ level: process.env.LOG_LEVEL ?? 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
  return root;
}

export type Logger = pino.Logger;
