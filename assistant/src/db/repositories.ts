import { randomUUID } from 'node:crypto';
import type { Db } from './types.js';
import type {
  CalendarAccount,
  EmailAccount,
  EmailTaskCandidate,
  OAuthConnection,
  Provider,
  Recurrence,
  Settings,
  Task,
  TaskPriority,
  TaskReminder,
  TaskSource,
  TaskStatus,
  User,
} from '../domain/types.js';
import { OPEN_STATUSES } from '../domain/types.js';

const TASK_COLUMNS = `id, user_id, title, description, status, priority, due_date, due_time, due_at, timezone,
  reminder_at, source, source_id, source_url, source_metadata, project, client, tags, completed_at,
  snoozed_until, parent_task_id, recurrence, confidence_score, ai_generated, created_at, updated_at`;

export function newId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ users */

export class UserRepo {
  constructor(private readonly db: Db) {}

  async findByPhone(phone: string): Promise<User | null> {
    const { rows } = await this.db.query<User>('SELECT * FROM users WHERE whatsapp_phone = $1', [
      phone,
    ]);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.db.query<User>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async listActive(): Promise<User[]> {
    const { rows } = await this.db.query<User>(
      'SELECT * FROM users WHERE is_active = TRUE ORDER BY created_at',
    );
    return rows;
  }

  async create(input: {
    display_name: string;
    whatsapp_phone: string;
    email?: string | null;
    timezone: string;
  }): Promise<User> {
    const id = newId();
    const { rows } = await this.db.query<User>(
      `INSERT INTO users (id, display_name, whatsapp_phone, email, timezone)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, input.display_name, input.whatsapp_phone, input.email ?? null, input.timezone],
    );
    await this.db.query('INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    return rows[0]!;
  }
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<Settings> {
    const { rows } = await this.db.query<Settings>('SELECT * FROM settings WHERE user_id = $1', [
      userId,
    ]);
    if (rows[0]) return rows[0];
    const created = await this.db.query<Settings>(
      'INSERT INTO settings (user_id) VALUES ($1) RETURNING *',
      [userId],
    );
    return created.rows[0]!;
  }

  async update(userId: string, patch: Partial<Settings>): Promise<Settings> {
    const entries = Object.entries(patch).filter(([k]) => k !== 'user_id');
    if (!entries.length) return this.get(userId);
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await this.db.query<Settings>(
      `UPDATE settings SET ${sets}, updated_at = now() WHERE user_id = $1 RETURNING *`,
      [userId, ...entries.map(([, v]) => v)],
    );
    return rows[0]!;
  }
}

/* ------------------------------------------------------------------ tasks */

export interface CreateTaskInput {
  user_id: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string | null;
  due_time?: string | null;
  due_at?: Date | null;
  timezone: string;
  reminder_at?: Date | null;
  source: TaskSource;
  source_id?: string | null;
  source_url?: string | null;
  source_metadata?: Record<string, unknown>;
  project?: string | null;
  client?: string | null;
  tags?: string[];
  parent_task_id?: string | null;
  recurrence?: Recurrence | null;
  confidence_score?: number | null;
  ai_generated?: boolean;
}

export interface TaskQuery {
  statuses?: TaskStatus[];
  dueBefore?: Date;
  dueAfter?: Date;
  dueOnLocalDate?: string;
  overdueAsOf?: Date;
  search?: string;
  project?: string;
  client?: string;
  tag?: string;
  priority?: TaskPriority;
  limit?: number;
  includeSnoozed?: boolean;
  orderBy?: 'due' | 'created' | 'priority';
}

export class TaskRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const id = newId();
    const { rows } = await this.db.query<Task>(
      `INSERT INTO tasks (id, user_id, title, description, status, priority, due_date, due_time, due_at,
         timezone, reminder_at, source, source_id, source_url, source_metadata, project, client, tags,
         parent_task_id, recurrence, confidence_score, ai_generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING ${TASK_COLUMNS}`,
      [
        id,
        input.user_id,
        input.title,
        input.description ?? null,
        input.status ?? 'open',
        input.priority ?? 'normal',
        input.due_date ?? null,
        input.due_time ?? null,
        input.due_at ?? null,
        input.timezone,
        input.reminder_at ?? null,
        input.source,
        input.source_id ?? null,
        input.source_url ?? null,
        JSON.stringify(input.source_metadata ?? {}),
        input.project ?? null,
        input.client ?? null,
        input.tags ?? [],
        input.parent_task_id ?? null,
        input.recurrence ? JSON.stringify(input.recurrence) : null,
        input.confidence_score ?? null,
        input.ai_generated ?? false,
      ],
    );
    return rows[0]!;
  }

  async findById(userId: string, id: string): Promise<Task | null> {
    const { rows } = await this.db.query<Task>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE user_id = $1 AND id = $2`,
      [userId, id],
    );
    return rows[0] ?? null;
  }

  async findBySource(userId: string, source: TaskSource, sourceId: string): Promise<Task | null> {
    const { rows } = await this.db.query<Task>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE user_id = $1 AND source = $2 AND source_id = $3 LIMIT 1`,
      [userId, source, sourceId],
    );
    return rows[0] ?? null;
  }

  async update(userId: string, id: string, patch: Partial<Task>): Promise<Task | null> {
    const allowed: (keyof Task)[] = [
      'title',
      'description',
      'status',
      'priority',
      'due_date',
      'due_time',
      'due_at',
      'timezone',
      'reminder_at',
      'project',
      'client',
      'tags',
      'completed_at',
      'snoozed_until',
      'recurrence',
      'source_metadata',
      'confidence_score',
      'parent_task_id',
    ];
    const entries = Object.entries(patch).filter(([k]) => allowed.includes(k as keyof Task));
    if (!entries.length) return this.findById(userId, id);
    const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const values = entries.map(([k, v]) =>
      k === 'recurrence' || k === 'source_metadata' ? (v == null ? null : JSON.stringify(v)) : v,
    );
    const { rows } = await this.db.query<Task>(
      `UPDATE tasks SET ${sets}, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING ${TASK_COLUMNS}`,
      [userId, id, ...values],
    );
    return rows[0] ?? null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM tasks WHERE user_id = $1 AND id = $2', [
      userId,
      id,
    ]);
    return res.rowCount > 0;
  }

  async list(userId: string, q: TaskQuery = {}): Promise<Task[]> {
    const where: string[] = ['user_id = $1'];
    const params: unknown[] = [userId];
    const push = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    push('status = ANY(?)', q.statuses ?? OPEN_STATUSES);
    if (q.dueBefore) push('due_at < ?', q.dueBefore);
    if (q.dueAfter) push('due_at >= ?', q.dueAfter);
    if (q.dueOnLocalDate) push('due_date = ?', q.dueOnLocalDate);
    if (q.overdueAsOf) push('(due_at IS NOT NULL AND due_at < ?)', q.overdueAsOf);
    if (q.project) push('lower(project) = lower(?)', q.project);
    if (q.client) push('lower(client) = lower(?)', q.client);
    if (q.tag) push('? = ANY(tags)', q.tag);
    if (q.priority) push('priority = ?', q.priority);
    if (q.search) {
      params.push(`%${q.search}%`);
      const p = `$${params.length}`;
      where.push(
        `(title ILIKE ${p} OR coalesce(description,'') ILIKE ${p} OR coalesce(project,'') ILIKE ${p} OR coalesce(client,'') ILIKE ${p})`,
      );
    }
    if (!q.includeSnoozed) where.push('(snoozed_until IS NULL OR snoozed_until <= now())');

    const order =
      q.orderBy === 'created'
        ? 'created_at DESC'
        : q.orderBy === 'priority'
          ? `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, due_at NULLS LAST`
          : 'due_at ASC NULLS LAST, created_at ASC';

    params.push(q.limit ?? 50);
    const { rows } = await this.db.query<Task>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async countByStatus(userId: string): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM tasks WHERE user_id = $1 GROUP BY status',
      [userId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }

  async completedBetween(userId: string, from: Date, to: Date): Promise<Task[]> {
    const { rows } = await this.db.query<Task>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE user_id = $1 AND status = 'completed' AND completed_at >= $2 AND completed_at < $3
       ORDER BY completed_at`,
      [userId, from, to],
    );
    return rows;
  }

  async addEvent(
    userId: string,
    taskId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.query(
      'INSERT INTO task_events (id, task_id, user_id, event_type, payload) VALUES ($1,$2,$3,$4,$5)',
      [newId(), taskId, userId, eventType, JSON.stringify(payload)],
    );
  }
}

/* -------------------------------------------------------------- reminders */

export class ReminderRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    task_id: string;
    user_id: string;
    remind_at: Date;
    kind?: 'primary' | 'followup';
    followup_index?: number;
  }): Promise<TaskReminder> {
    const { rows } = await this.db.query<TaskReminder>(
      `INSERT INTO task_reminders (id, task_id, user_id, remind_at, kind, followup_index)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        newId(),
        input.task_id,
        input.user_id,
        input.remind_at,
        input.kind ?? 'primary',
        input.followup_index ?? 0,
      ],
    );
    return rows[0]!;
  }

  async cancelPendingForTask(taskId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE task_reminders SET status = 'cancelled', updated_at = now()
       WHERE task_id = $1 AND status = 'pending'`,
      [taskId],
    );
    return res.rowCount;
  }

  /**
   * Claims a batch of due reminders. `FOR UPDATE SKIP LOCKED` inside a
   * transaction makes this safe to run from several app instances at once —
   * no reminder is ever delivered twice.
   */
  async claimDue(now: Date, limit: number): Promise<TaskReminder[]> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<TaskReminder>(
        `SELECT * FROM task_reminders
         WHERE status = 'pending' AND remind_at <= $1
         ORDER BY remind_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (!rows.length) return [];
      await tx.query(
        `UPDATE task_reminders SET locked_at = now(), attempt_count = attempt_count + 1, updated_at = now()
         WHERE id = ANY($1)`,
        [rows.map((r) => r.id)],
      );
      return rows;
    });
  }

  async markSent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE task_reminders SET status = 'sent', sent_at = now(), locked_at = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE task_reminders SET status = 'failed', last_error = $2, locked_at = NULL, updated_at = now() WHERE id = $1`,
      [id, error.slice(0, 500)],
    );
  }

  async defer(id: string, until: Date, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE task_reminders SET remind_at = $2, status = 'pending', locked_at = NULL,
         last_error = $3, updated_at = now() WHERE id = $1`,
      [id, until, reason.slice(0, 500)],
    );
  }

  async listForTask(taskId: string): Promise<TaskReminder[]> {
    const { rows } = await this.db.query<TaskReminder>(
      'SELECT * FROM task_reminders WHERE task_id = $1 ORDER BY remind_at',
      [taskId],
    );
    return rows;
  }

  async lastSentAt(): Promise<Date | null> {
    const { rows } = await this.db.query<{ sent_at: Date }>(
      `SELECT sent_at FROM task_reminders WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1`,
    );
    return rows[0]?.sent_at ?? null;
  }
}

/* --------------------------------------------------------------- oauth/io */

export class OAuthRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    user_id: string;
    provider: Provider;
    account_email: string;
    scopes: string[];
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    expires_at: Date | null;
  }): Promise<OAuthConnection> {
    const { rows } = await this.db.query<OAuthConnection>(
      `INSERT INTO oauth_connections (id, user_id, provider, account_email, scopes, access_token_enc,
         refresh_token_enc, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'connected')
       ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
         scopes = EXCLUDED.scopes,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, oauth_connections.refresh_token_enc),
         expires_at = EXCLUDED.expires_at,
         status = 'connected', last_error = NULL, updated_at = now()
       RETURNING *`,
      [
        newId(),
        input.user_id,
        input.provider,
        input.account_email,
        input.scopes,
        input.access_token_enc,
        input.refresh_token_enc,
        input.expires_at,
      ],
    );
    return rows[0]!;
  }

  async listForUser(userId: string, provider?: Provider): Promise<OAuthConnection[]> {
    const { rows } = await this.db.query<OAuthConnection>(
      provider
        ? 'SELECT * FROM oauth_connections WHERE user_id = $1 AND provider = $2 ORDER BY created_at'
        : 'SELECT * FROM oauth_connections WHERE user_id = $1 ORDER BY created_at',
      provider ? [userId, provider] : [userId],
    );
    return rows;
  }

  async findById(id: string): Promise<OAuthConnection | null> {
    const { rows } = await this.db.query<OAuthConnection>(
      'SELECT * FROM oauth_connections WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async updateTokens(
    id: string,
    accessEnc: string,
    expiresAt: Date | null,
    refreshEnc?: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE oauth_connections SET access_token_enc = $2, expires_at = $3,
         refresh_token_enc = COALESCE($4, refresh_token_enc),
         status = 'connected', last_error = NULL, last_refreshed_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, accessEnc, expiresAt, refreshEnc ?? null],
    );
  }

  async markStatus(id: string, status: OAuthConnection['status'], error?: string): Promise<void> {
    await this.db.query(
      `UPDATE oauth_connections SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
      [id, status, error?.slice(0, 500) ?? null],
    );
  }
}

export class CalendarAccountRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: Omit<CalendarAccount, 'id'>): Promise<CalendarAccount> {
    const { rows } = await this.db.query<CalendarAccount>(
      `INSERT INTO calendar_accounts (id, user_id, oauth_connection_id, provider, calendar_id, display_name, is_primary, is_writable, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (oauth_connection_id, calendar_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, is_primary = EXCLUDED.is_primary,
         is_writable = EXCLUDED.is_writable, updated_at = now()
       RETURNING *`,
      [
        newId(),
        input.user_id,
        input.oauth_connection_id,
        input.provider,
        input.calendar_id,
        input.display_name,
        input.is_primary,
        input.is_writable,
        input.enabled,
      ],
    );
    return rows[0]!;
  }

  async listEnabled(userId: string): Promise<CalendarAccount[]> {
    const { rows } = await this.db.query<CalendarAccount>(
      'SELECT * FROM calendar_accounts WHERE user_id = $1 AND enabled = TRUE ORDER BY provider, is_primary DESC',
      [userId],
    );
    return rows;
  }

  async markSync(id: string, status: string, error?: string): Promise<void> {
    await this.db.query(
      `UPDATE calendar_accounts SET last_sync_at = now(), last_sync_status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
      [id, status, error?.slice(0, 500) ?? null],
    );
  }
}

export class EmailAccountRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    user_id: string;
    oauth_connection_id: string;
    provider: Provider;
    address: string;
  }): Promise<EmailAccount> {
    const { rows } = await this.db.query<EmailAccount>(
      `INSERT INTO email_accounts (id, user_id, oauth_connection_id, provider, address)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, provider, address) DO UPDATE SET
         oauth_connection_id = EXCLUDED.oauth_connection_id, enabled = TRUE, updated_at = now()
       RETURNING *`,
      [newId(), input.user_id, input.oauth_connection_id, input.provider, input.address],
    );
    return rows[0]!;
  }

  async listEnabled(userId: string): Promise<EmailAccount[]> {
    const { rows } = await this.db.query<EmailAccount>(
      'SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = TRUE ORDER BY provider',
      [userId],
    );
    return rows;
  }

  async setCursor(
    id: string,
    cursor: string | null,
    status: string,
    error?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE email_accounts SET sync_cursor = $2, last_scanned_at = now(), last_sync_status = $3,
         last_error = $4, updated_at = now() WHERE id = $1`,
      [id, cursor, status, error?.slice(0, 500) ?? null],
    );
  }
}

/* ------------------------------------------------------- email candidates */

export class EmailRepo {
  constructor(private readonly db: Db) {}

  /** Returns null when the message was already recorded (idempotent ingest). */
  async recordMessage(input: {
    user_id: string;
    email_account_id: string;
    provider: Provider;
    provider_message_id: string;
    thread_id: string;
    from_address: string | null;
    from_name: string | null;
    subject: string | null;
    received_at: Date | null;
    web_url: string | null;
  }): Promise<{ id: string; isNew: boolean }> {
    const { rows } = await this.db.query<{ id: string; is_new: boolean }>(
      `INSERT INTO email_messages (id, user_id, email_account_id, provider, provider_message_id, thread_id,
         from_address, from_name, subject, received_at, web_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (email_account_id, provider_message_id) DO UPDATE SET thread_id = EXCLUDED.thread_id
       RETURNING id, (xmax = 0) AS is_new`,
      [
        newId(),
        input.user_id,
        input.email_account_id,
        input.provider,
        input.provider_message_id,
        input.thread_id,
        input.from_address,
        input.from_name,
        input.subject,
        input.received_at,
        input.web_url,
      ],
    );
    return { id: rows[0]!.id, isNew: Boolean(rows[0]!.is_new) };
  }

  async markProcessed(id: string): Promise<void> {
    await this.db.query('UPDATE email_messages SET processed_at = now() WHERE id = $1', [id]);
  }

  /** Dedupe is by (user, dedupe_key); a reply on the same thread never re-proposes. */
  async insertCandidate(input: {
    user_id: string;
    email_message_id: string;
    thread_id: string;
    title: string;
    description: string | null;
    due_date: string | null;
    due_time: string | null;
    contact_name: string | null;
    contact_email: string | null;
    confidence: number;
    status: EmailTaskCandidate['status'];
    dedupe_key: string;
  }): Promise<EmailTaskCandidate | null> {
    const { rows } = await this.db.query<EmailTaskCandidate>(
      `INSERT INTO email_task_candidates (id, user_id, email_message_id, thread_id, title, description,
         due_date, due_time, contact_name, contact_email, confidence, status, dedupe_key, proposed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING *`,
      [
        newId(),
        input.user_id,
        input.email_message_id,
        input.thread_id,
        input.title,
        input.description,
        input.due_date,
        input.due_time,
        input.contact_name,
        input.contact_email,
        input.confidence,
        input.status,
        input.dedupe_key,
      ],
    );
    return rows[0] ?? null;
  }

  async findCandidate(userId: string, id: string): Promise<EmailTaskCandidate | null> {
    const { rows } = await this.db.query<EmailTaskCandidate>(
      'SELECT * FROM email_task_candidates WHERE user_id = $1 AND id = $2',
      [userId, id],
    );
    return rows[0] ?? null;
  }

  async latestPendingCandidate(userId: string): Promise<EmailTaskCandidate | null> {
    const { rows } = await this.db.query<EmailTaskCandidate>(
      `SELECT * FROM email_task_candidates
       WHERE user_id = $1 AND status IN ('pending','snoozed') ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async setCandidateStatus(
    id: string,
    status: EmailTaskCandidate['status'],
    taskId?: string | null,
    snoozedUntil?: Date | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE email_task_candidates SET status = $2, task_id = COALESCE($3, task_id),
         snoozed_until = $4, responded_at = now(), updated_at = now() WHERE id = $1`,
      [id, status, taskId ?? null, snoozedUntil ?? null],
    );
  }

  async threadHasCandidate(userId: string, threadId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM email_task_candidates WHERE user_id = $1 AND thread_id = $2',
      [userId, threadId],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async listCandidates(
    userId: string,
    status?: EmailTaskCandidate['status'],
    limit = 50,
  ): Promise<EmailTaskCandidate[]> {
    const { rows } = await this.db.query<EmailTaskCandidate>(
      status
        ? 'SELECT * FROM email_task_candidates WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3'
        : 'SELECT * FROM email_task_candidates WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      status ? [userId, status, limit] : [userId, limit],
    );
    return rows;
  }
}

/* -------------------------------------------------- observability & state */

export class AuditRepo {
  constructor(private readonly db: Db) {}

  async log(input: {
    user_id?: string | null;
    action: string;
    entity_type?: string | null;
    entity_id?: string | null;
    source?: string;
    input?: unknown;
    result?: unknown;
    status?: 'success' | 'failure' | 'skipped';
    error?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, source, input, result, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newId(),
        input.user_id ?? null,
        input.action,
        input.entity_type ?? null,
        input.entity_id ?? null,
        input.source ?? 'system',
        input.input === undefined ? null : JSON.stringify(input.input),
        input.result === undefined ? null : JSON.stringify(input.result),
        input.status ?? 'success',
        input.error?.slice(0, 1000) ?? null,
      ],
    );
  }

  async recent(limit = 50, userId?: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      userId
        ? 'SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2'
        : 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1',
      userId ? [userId, limit] : [limit],
    );
    return rows;
  }
}

export class IntegrationLogRepo {
  constructor(private readonly db: Db) {}

  async log(input: {
    user_id?: string | null;
    integration: string;
    operation: string;
    status: 'success' | 'failure';
    latency_ms?: number;
    error?: string | null;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO integration_logs (id, user_id, integration, operation, status, latency_ms, error, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId(),
        input.user_id ?? null,
        input.integration,
        input.operation,
        input.status,
        input.latency_ms ?? null,
        input.error?.slice(0, 1000) ?? null,
        JSON.stringify(input.meta ?? {}),
      ],
    );
    if (input.user_id) {
      await this.db.query(
        `INSERT INTO integration_status (user_id, integration, status, last_success_at, last_failure_at, last_error)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, integration) DO UPDATE SET
           status = EXCLUDED.status,
           last_success_at = COALESCE(EXCLUDED.last_success_at, integration_status.last_success_at),
           last_failure_at = COALESCE(EXCLUDED.last_failure_at, integration_status.last_failure_at),
           last_error = EXCLUDED.last_error, updated_at = now()`,
        [
          input.user_id,
          input.integration,
          input.status === 'success' ? 'ok' : 'degraded',
          input.status === 'success' ? new Date() : null,
          input.status === 'failure' ? new Date() : null,
          input.error?.slice(0, 500) ?? null,
        ],
      );
    }
  }

  async status(userId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM integration_status WHERE user_id = $1 ORDER BY integration',
      [userId],
    );
    return rows;
  }

  async recentFailures(limit = 25): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM integration_logs WHERE status = 'failure' ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
}

export class AiInteractionRepo {
  constructor(private readonly db: Db) {}

  async log(input: {
    user_id?: string | null;
    kind: string;
    provider: string;
    model: string;
    intent?: string | null;
    structured_output?: unknown;
    tool_requested?: string | null;
    tool_result?: unknown;
    latency_ms?: number;
    input_tokens?: number | null;
    output_tokens?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_interactions (id, user_id, kind, provider, model, intent, structured_output,
         tool_requested, tool_result, latency_ms, input_tokens, output_tokens, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        newId(),
        input.user_id ?? null,
        input.kind,
        input.provider,
        input.model,
        input.intent ?? null,
        input.structured_output === undefined ? null : JSON.stringify(input.structured_output),
        input.tool_requested ?? null,
        input.tool_result === undefined ? null : JSON.stringify(input.tool_result),
        input.latency_ms ?? null,
        input.input_tokens ?? null,
        input.output_tokens ?? null,
        input.error?.slice(0, 1000) ?? null,
      ],
    );
  }
}

export class WhatsAppMessageRepo {
  constructor(private readonly db: Db) {}

  /** Returns false when this wa_message_id was already stored — webhook replay. */
  async recordInbound(input: {
    user_id: string | null;
    wa_message_id: string;
    wa_from: string;
    message_type: string;
    body: string | null;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO whatsapp_messages (id, user_id, direction, wa_message_id, wa_from, message_type, body, payload)
       VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [
        newId(),
        input.user_id,
        input.wa_message_id,
        input.wa_from,
        input.message_type,
        input.body,
        JSON.stringify(input.payload),
      ],
    );
    return res.rowCount > 0;
  }

  async recordOutbound(input: {
    user_id: string | null;
    wa_message_id: string | null;
    wa_to: string;
    message_type: string;
    body: string | null;
    status: string;
    error?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO whatsapp_messages (id, user_id, direction, wa_message_id, wa_to, message_type, body, status, error)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [
        newId(),
        input.user_id,
        input.wa_message_id,
        input.wa_to,
        input.message_type,
        input.body,
        input.status,
        input.error?.slice(0, 500) ?? null,
      ],
    );
  }

  async lastInboundAt(userId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ created_at: Date }>(
      `SELECT created_at FROM whatsapp_messages WHERE user_id = $1 AND direction = 'inbound'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0]?.created_at ?? null;
  }

  async lastWebhookAt(): Promise<Date | null> {
    const { rows } = await this.db.query<{ created_at: Date }>(
      `SELECT created_at FROM whatsapp_messages WHERE direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0]?.created_at ?? null;
  }
}

export class IdempotencyRepo {
  constructor(private readonly db: Db) {}

  /** True when the key was claimed by *this* call; false when already seen. */
  async claim(scope: string, key: string): Promise<boolean> {
    const res = await this.db.query(
      'INSERT INTO idempotency_keys (scope, key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [scope, key],
    );
    return res.rowCount > 0;
  }

  async recordResult(scope: string, key: string, result: unknown): Promise<void> {
    await this.db.query('UPDATE idempotency_keys SET result = $3 WHERE scope = $1 AND key = $2', [
      scope,
      key,
      JSON.stringify(result),
    ]);
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const res = await this.db.query('DELETE FROM idempotency_keys WHERE created_at < $1', [cutoff]);
    return res.rowCount;
  }
}

export interface PendingConfirmation {
  id: string;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  prompt: string;
  status: string;
  expires_at: Date;
}

export class ConfirmationRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    user_id: string;
    kind: string;
    payload: Record<string, unknown>;
    prompt: string;
    ttlMinutes?: number;
  }): Promise<PendingConfirmation> {
    // A new question supersedes any older unanswered one, so a stale "which
    // task did you mean?" can never be answered by accident.
    await this.db.query(
      `UPDATE pending_confirmations SET status = 'superseded', updated_at = now()
       WHERE user_id = $1 AND status = 'pending'`,
      [input.user_id],
    );
    const expires = new Date(Date.now() + (input.ttlMinutes ?? 30) * 60_000);
    const { rows } = await this.db.query<PendingConfirmation>(
      `INSERT INTO pending_confirmations (id, user_id, kind, payload, prompt, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId(), input.user_id, input.kind, JSON.stringify(input.payload), input.prompt, expires],
    );
    return rows[0]!;
  }

  async findPending(userId: string): Promise<PendingConfirmation | null> {
    const { rows } = await this.db.query<PendingConfirmation>(
      `SELECT * FROM pending_confirmations WHERE user_id = $1 AND status = 'pending' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async resolve(id: string, status: 'confirmed' | 'rejected' | 'expired'): Promise<void> {
    await this.db.query(
      'UPDATE pending_confirmations SET status = $2, updated_at = now() WHERE id = $1',
      [id, status],
    );
  }
}

export class ConversationRepo {
  constructor(private readonly db: Db) {}

  async touchInbound(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO conversation_state (user_id, last_inbound_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_inbound_at = now(), updated_at = now()`,
      [userId],
    );
  }

  async touchOutbound(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO conversation_state (user_id, last_outbound_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_outbound_at = now(), updated_at = now()`,
      [userId],
    );
  }

  async setLastTask(userId: string, taskId: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO conversation_state (user_id, last_task_id) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET last_task_id = $2, updated_at = now()`,
      [userId, taskId],
    );
  }

  async get(
    userId: string,
  ): Promise<{
    last_inbound_at: Date | null;
    last_outbound_at: Date | null;
    last_task_id: string | null;
  } | null> {
    const { rows } = await this.db.query<{
      last_inbound_at: Date | null;
      last_outbound_at: Date | null;
      last_task_id: string | null;
    }>(
      'SELECT last_inbound_at, last_outbound_at, last_task_id FROM conversation_state WHERE user_id = $1',
      [userId],
    );
    return rows[0] ?? null;
  }
}

export interface SchedulerJob {
  id: string;
  user_id: string | null;
  job_type: string;
  run_at: Date;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
}

export class SchedulerJobRepo {
  constructor(private readonly db: Db) {}

  async schedule(input: {
    user_id: string | null;
    job_type: string;
    run_at: Date;
    payload?: Record<string, unknown>;
    dedupe_key?: string | null;
  }): Promise<SchedulerJob | null> {
    const { rows } = await this.db.query<SchedulerJob>(
      `INSERT INTO scheduler_jobs (id, user_id, job_type, run_at, payload, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [
        newId(),
        input.user_id,
        input.job_type,
        input.run_at,
        JSON.stringify(input.payload ?? {}),
        input.dedupe_key ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  async claimDue(now: Date, limit: number): Promise<SchedulerJob[]> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<SchedulerJob>(
        `SELECT * FROM scheduler_jobs WHERE status = 'pending' AND run_at <= $1
         ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (!rows.length) return [];
      await tx.query(
        `UPDATE scheduler_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
         WHERE id = ANY($1)`,
        [rows.map((r) => r.id)],
      );
      return rows;
    });
  }

  async finish(id: string, status: 'done' | 'failed', error?: string): Promise<void> {
    await this.db.query(
      `UPDATE scheduler_jobs SET status = $2, last_error = $3, locked_at = NULL, updated_at = now() WHERE id = $1`,
      [id, status, error?.slice(0, 500) ?? null],
    );
  }
}

export interface Repositories {
  users: UserRepo;
  settings: SettingsRepo;
  tasks: TaskRepo;
  reminders: ReminderRepo;
  oauth: OAuthRepo;
  calendarAccounts: CalendarAccountRepo;
  emailAccounts: EmailAccountRepo;
  email: EmailRepo;
  audit: AuditRepo;
  integrationLogs: IntegrationLogRepo;
  ai: AiInteractionRepo;
  whatsapp: WhatsAppMessageRepo;
  idempotency: IdempotencyRepo;
  confirmations: ConfirmationRepo;
  conversation: ConversationRepo;
  jobs: SchedulerJobRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    users: new UserRepo(db),
    settings: new SettingsRepo(db),
    tasks: new TaskRepo(db),
    reminders: new ReminderRepo(db),
    oauth: new OAuthRepo(db),
    calendarAccounts: new CalendarAccountRepo(db),
    emailAccounts: new EmailAccountRepo(db),
    email: new EmailRepo(db),
    audit: new AuditRepo(db),
    integrationLogs: new IntegrationLogRepo(db),
    ai: new AiInteractionRepo(db),
    whatsapp: new WhatsAppMessageRepo(db),
    idempotency: new IdempotencyRepo(db),
    confirmations: new ConfirmationRepo(db),
    conversation: new ConversationRepo(db),
    jobs: new SchedulerJobRepo(db),
  };
}
