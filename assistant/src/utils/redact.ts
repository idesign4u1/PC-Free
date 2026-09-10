import { createHash } from 'node:crypto';

/** Stable, non-reversible identifier for a phone number, safe for logs. */
export function hashPhone(phone: string): string {
  return `wa_${createHash('sha256').update(phone).digest('hex').slice(0, 12)}`;
}

/** Keeps enough of a message to debug intent routing without storing the content. */
export function truncateForStorage(text: string | null | undefined, max = 500): string | null {
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Email content is never logged verbatim. This keeps the subject line (business
 * context) and drops the body entirely.
 */
export function emailLogSummary(input: {
  from?: string | null;
  subject?: string | null;
}): Record<string, string> {
  return {
    from: input.from ? maskEmail(input.from) : 'unknown',
    subject: truncateForStorage(input.subject, 120) ?? '(no subject)',
  };
}

export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`;
}
