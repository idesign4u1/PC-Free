import type { Repositories } from '../db/repositories.js';
import type { Settings, User } from '../domain/types.js';
import type { EmailClient } from './types.js';
import { EmailActionExtractor, candidateDedupeKey } from './extractor.js';
import { logger } from '../utils/logger.js';
import { emailLogSummary } from '../utils/redact.js';
import { errorText, ReauthRequiredError } from '../utils/errors.js';

export interface ScanOutcome {
  scanned: number;
  newMessages: number;
  candidatesCreated: number;
  skippedDuplicate: number;
  skippedLowConfidence: number;
  degraded: string[];
}

/**
 * Polls the connected mailboxes and turns action items into pending candidates.
 * Nothing is added to the task list here — approval happens over WhatsApp.
 */
export class EmailScanner {
  constructor(
    private readonly repos: Repositories,
    private readonly clients: { google: EmailClient | null; microsoft: EmailClient | null },
    private readonly extractor: EmailActionExtractor,
  ) {}

  async scan(
    user: User,
    settings: Settings,
    opts: { now: Date; lookbackMinutes?: number; limit?: number },
  ): Promise<ScanOutcome> {
    const outcome: ScanOutcome = {
      scanned: 0,
      newMessages: 0,
      candidatesCreated: 0,
      skippedDuplicate: 0,
      skippedLowConfidence: 0,
      degraded: [],
    };
    if (!settings.email_scan_enabled) return outcome;

    const accounts = await this.repos.emailAccounts.listEnabled(user.id);
    const lookback = opts.lookbackMinutes ?? settings.email_scan_interval_minutes * 4;

    for (const account of accounts) {
      const client = account.provider === 'google' ? this.clients.google : this.clients.microsoft;
      if (!client) continue;

      const since = account.last_scanned_at
        ? new Date(
            Math.max(
              account.last_scanned_at.getTime() - 60_000,
              opts.now.getTime() - 7 * 86_400_000,
            ),
          )
        : new Date(opts.now.getTime() - lookback * 60_000);
      const started = Date.now();

      try {
        const { messages, cursor } = await client.fetchRecent(account.oauth_connection_id, {
          since,
          cursor: account.sync_cursor,
          limit: opts.limit ?? 25,
          selfAddress: account.address,
        });
        outcome.scanned += messages.length;

        for (const email of messages) {
          if (email.isFromSelf) continue;

          const { id: messageRowId, isNew } = await this.repos.email.recordMessage({
            user_id: user.id,
            email_account_id: account.id,
            provider: account.provider,
            provider_message_id: email.providerMessageId,
            thread_id: email.threadId,
            from_address: email.fromAddress,
            from_name: email.fromName,
            subject: email.subject,
            received_at: email.receivedAt,
            web_url: email.webUrl,
          });
          if (!isNew) continue; // already processed on an earlier pass
          outcome.newMessages += 1;

          const result = await this.extractor.extract(email, {
            userName: user.display_name,
            userEmail: account.address,
            timezone: user.timezone,
            now: opts.now,
          });

          await this.repos.ai.log({
            user_id: user.id,
            kind: 'email_extraction',
            provider: result.provider ?? 'none',
            model: result.model ?? 'none',
            structured_output: result.extraction ?? undefined,
            latency_ms: result.latencyMs,
            error: result.error ?? null,
          });
          await this.repos.email.markProcessed(messageRowId);

          if (result.error || !result.extraction) continue;
          const ex = result.extraction;
          if (!ex.has_action_item || ex.is_automated || !ex.title) continue;

          if (ex.confidence < Number(settings.email_min_confidence)) {
            outcome.skippedLowConfidence += 1;
            logger().debug(
              { ...emailLogSummary(email), confidence: ex.confidence },
              'action item below confidence floor',
            );
            continue;
          }

          const dedupeKey = candidateDedupeKey(email.threadId, ex.title);
          const candidate = await this.repos.email.insertCandidate({
            user_id: user.id,
            email_message_id: messageRowId,
            thread_id: email.threadId,
            title: ex.title.slice(0, 200),
            description: ex.description,
            due_date: result.dueDate,
            due_time: result.dueTime,
            contact_name: ex.contact_name ?? email.fromName,
            contact_email: email.fromAddress,
            confidence: ex.confidence,
            status: 'pending',
            dedupe_key: dedupeKey,
          });

          if (!candidate) {
            outcome.skippedDuplicate += 1;
            continue;
          }
          outcome.candidatesCreated += 1;

          await this.repos.audit.log({
            user_id: user.id,
            action: 'EMAIL_TASK_DETECTED',
            entity_type: 'email_task_candidate',
            entity_id: candidate.id,
            source: account.provider === 'google' ? 'gmail' : 'outlook',
            result: {
              title: candidate.title,
              confidence: ex.confidence,
              injection_flags: result.injectionFlags,
            },
          });
        }

        await this.repos.emailAccounts.setCursor(account.id, cursor, 'ok');
        await this.repos.integrationLogs.log({
          user_id: user.id,
          integration: account.provider === 'google' ? 'gmail' : 'outlook_mail',
          operation: 'scan',
          status: 'success',
          latency_ms: Date.now() - started,
          meta: { scanned: outcome.scanned, candidates: outcome.candidatesCreated },
        });
      } catch (err) {
        const message = errorText(err);
        await this.repos.emailAccounts.setCursor(account.id, account.sync_cursor, 'error', message);
        await this.repos.integrationLogs.log({
          user_id: user.id,
          integration: account.provider === 'google' ? 'gmail' : 'outlook_mail',
          operation: 'scan',
          status: 'failure',
          latency_ms: Date.now() - started,
          error: message,
        });
        outcome.degraded.push(
          err instanceof ReauthRequiredError
            ? `${account.provider === 'google' ? 'Gmail' : 'Outlook'} מנותק — צריך לחבר מחדש.`
            : `${account.provider === 'google' ? 'Gmail' : 'Outlook'} לא זמין כרגע.`,
        );
        logger().warn({ provider: account.provider, err: message }, 'email scan failed');
      }
    }

    return outcome;
  }
}
