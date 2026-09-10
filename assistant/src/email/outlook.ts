import type { EmailClient, FetchedEmail } from './types.js';
import type { TokenStore } from '../oauth/token-store.js';
import { IntegrationError } from '../utils/errors.js';

/**
 * Outlook Mail via Microsoft Graph, Mail.Read only.
 *
 * Graph can return the body as plain text if we ask for it with the
 * `outlook.body-content-type="text"` Prefer header, which avoids shipping HTML
 * into the extraction prompt.
 */

const BASE = 'https://graph.microsoft.com/v1.0';

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  webLink?: string;
  isDraft?: boolean;
}

export class OutlookMailClient implements EmailClient {
  readonly provider = 'microsoft' as const;

  constructor(
    private readonly tokens: TokenStore,
    private readonly timeoutMs = 25_000,
  ) {}

  async fetchRecent(
    connectionId: string,
    opts: { since: Date; cursor: string | null; limit: number; selfAddress: string },
  ): Promise<{ messages: FetchedEmail[]; cursor: string | null }> {
    const token = await this.tokens.accessTokenFor(connectionId);
    const url = new URL(`${BASE}/me/mailFolders/inbox/messages`);
    url.searchParams.set('$filter', `receivedDateTime ge ${opts.since.toISOString()}`);
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$top', String(Math.min(opts.limit, 50)));
    url.searchParams.set(
      '$select',
      'id,conversationId,subject,bodyPreview,body,from,sender,toRecipients,receivedDateTime,webLink,isDraft',
    );

    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        Prefer: 'outlook.body-content-type="text"',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'outlook_mail',
        `Outlook mail fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    const data = (await res.json()) as { value?: GraphMessage[] };

    const messages = (data.value ?? [])
      .filter((m) => !m.isDraft)
      .map((m): FetchedEmail => {
        const from = m.from?.emailAddress ?? m.sender?.emailAddress;
        const address = from?.address?.toLowerCase() ?? null;
        return {
          providerMessageId: m.id,
          threadId: m.conversationId ?? m.id,
          fromAddress: address,
          fromName: from?.name ?? null,
          toAddresses: (m.toRecipients ?? [])
            .map((r) => r.emailAddress?.address?.toLowerCase())
            .filter((a): a is string => Boolean(a)),
          subject: m.subject ?? null,
          body: m.body?.content ?? m.bodyPreview ?? '',
          receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
          webUrl: m.webLink ?? null,
          isFromSelf: address === opts.selfAddress.toLowerCase(),
        };
      });

    return { messages, cursor: messages[0]?.providerMessageId ?? opts.cursor };
  }
}
