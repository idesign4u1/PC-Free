export interface FetchedEmail {
  providerMessageId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  subject: string | null;
  /** Plain-text body. Never logged, never stored — only passed to extraction. */
  body: string;
  receivedAt: Date | null;
  webUrl: string | null;
  /** True when the user themselves sent it; those are skipped. */
  isFromSelf: boolean;
}

export interface EmailClient {
  readonly provider: 'google' | 'microsoft';
  /**
   * Fetches messages received since the cursor. Returns a new cursor to store.
   * Implementations must be safe to call repeatedly — duplicates are filtered
   * downstream by (account, provider_message_id).
   */
  fetchRecent(
    connectionId: string,
    opts: { since: Date; cursor: string | null; limit: number; selfAddress: string },
  ): Promise<{ messages: FetchedEmail[]; cursor: string | null }>;
}
