import type { EmailClient, FetchedEmail } from './types.js';
import type { TokenStore } from '../oauth/token-store.js';
import { IntegrationError } from '../utils/errors.js';

/**
 * Gmail via the REST API, read-only scope.
 *
 * We use a time-bounded `q` search rather than the History API: history ids
 * expire after about a week, and a missed window would silently drop action
 * items. A bounded search is idempotent and self-healing, and the
 * (account, message id) unique constraint absorbs the overlap.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1';

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: GmailHeader[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
  labelIds?: string[];
}

function header(headers: GmailHeader[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Depth-first search for the best text representation of the message. */
function extractBody(part: GmailPart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const child of part.parts) {
      const found = extractBody(child);
      if (found) return found;
    }
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }
  return '';
}

function parseAddress(raw: string | null): { address: string | null; name: string | null } {
  if (!raw) return { address: null, name: null };
  const angled = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) return { name: angled[1]!.trim() || null, address: angled[2]!.trim().toLowerCase() };
  return { name: null, address: raw.trim().toLowerCase() };
}

export class GmailClient implements EmailClient {
  readonly provider = 'google' as const;

  constructor(
    private readonly tokens: TokenStore,
    private readonly timeoutMs = 25_000,
  ) {}

  private async get<T>(connectionId: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await this.tokens.accessTokenFor(connectionId);
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'gmail',
        `Gmail ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    return (await res.json()) as T;
  }

  async fetchRecent(
    connectionId: string,
    opts: { since: Date; cursor: string | null; limit: number; selfAddress: string },
  ): Promise<{ messages: FetchedEmail[]; cursor: string | null }> {
    const afterSeconds = Math.floor(opts.since.getTime() / 1000);
    const list = await this.get<{ messages?: { id: string }[] }>(connectionId, '/users/me/messages', {
      q: `in:inbox -in:chats after:${afterSeconds}`,
      maxResults: String(Math.min(opts.limit, 50)),
    });

    const messages: FetchedEmail[] = [];
    for (const ref of list.messages ?? []) {
      const full = await this.get<GmailMessage>(connectionId, `/users/me/messages/${ref.id}`, { format: 'full' });
      const headers = full.payload?.headers;
      const from = parseAddress(header(headers, 'From'));
      const to = (header(headers, 'To') ?? '')
        .split(',')
        .map((t) => parseAddress(t).address)
        .filter((a): a is string => Boolean(a));
      messages.push({
        providerMessageId: full.id,
        threadId: full.threadId,
        fromAddress: from.address,
        fromName: from.name,
        toAddresses: to,
        subject: header(headers, 'Subject'),
        body: extractBody(full.payload) || full.snippet || '',
        receivedAt: full.internalDate ? new Date(Number(full.internalDate)) : null,
        webUrl: `https://mail.google.com/mail/u/0/#inbox/${full.threadId}`,
        isFromSelf: from.address === opts.selfAddress.toLowerCase() || Boolean(full.labelIds?.includes('SENT')),
      });
    }
    // The cursor records the newest message we saw, purely for observability.
    return { messages, cursor: messages[0]?.providerMessageId ?? opts.cursor };
  }
}
