import type { Env } from './config/env.js';
import { capabilities } from './config/env.js';
import type { Db } from './db/types.js';
import { createRepositories, type Repositories } from './db/repositories.js';
import { parseKey } from './utils/crypto.js';
import { createAiProvider } from './ai/factory.js';
import { IntentEngine } from './ai/intent-engine.js';
import { TaskService } from './tasks/service.js';
import { CalendarService } from './calendar/service.js';
import { GoogleCalendarClient } from './calendar/google.js';
import { MicrosoftCalendarClient } from './calendar/microsoft.js';
import { GmailClient } from './email/gmail.js';
import { OutlookMailClient } from './email/outlook.js';
import { EmailActionExtractor } from './email/extractor.js';
import { EmailScanner } from './email/scanner.js';
import { CloudApiSender, NullSender, type WhatsAppSender } from './whatsapp/client.js';
import { Messenger } from './whatsapp/messenger.js';
import { Router } from './orchestrator/router.js';
import { ReminderEngine } from './reminders/engine.js';
import { BriefingService } from './briefing/service.js';
import { Scheduler } from './reminders/scheduler.js';
import { OpenAiSttProvider, type SttProvider } from './stt/provider.js';
import { TokenStore, googleConfig, microsoftConfig } from './oauth/token-store.js';
import type { AiProvider } from './ai/provider.js';
import { logger } from './utils/logger.js';

/**
 * Composition root.
 *
 * Every optional integration degrades to `null` when its credentials are
 * missing, so the app boots and serves whatever it can. `capabilities()` and
 * /health report exactly what is and is not wired.
 */
export interface App {
  env: Env;
  db: Db;
  repos: Repositories;
  ai: AiProvider | null;
  stt: SttProvider | null;
  tokens: TokenStore | null;
  sender: WhatsAppSender;
  messenger: Messenger;
  tasks: TaskService;
  calendar: CalendarService;
  emailScanner: EmailScanner | null;
  router: Router;
  reminders: ReminderEngine;
  briefing: BriefingService;
  scheduler: Scheduler;
}

export function buildApp(
  env: Env,
  db: Db,
  overrides: { sender?: WhatsAppSender; ai?: AiProvider | null } = {},
): App {
  const caps = capabilities(env);
  const repos = createRepositories(db);

  const ai = overrides.ai !== undefined ? overrides.ai : createAiProvider(env);
  const stt =
    env.sttProvider === 'openai' && env.sttApiKey
      ? new OpenAiSttProvider(env.sttApiKey, env.STT_MODEL, env.STT_LANGUAGE)
      : null;

  const tokens = caps.encryption
    ? new TokenStore(repos, parseKey(env.ENCRYPTION_KEY), {
        google: caps.google
          ? googleConfig(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.googleRedirectUri)
          : null,
        microsoft: caps.microsoft
          ? microsoftConfig(
              env.MICROSOFT_CLIENT_ID,
              env.MICROSOFT_CLIENT_SECRET,
              env.microsoftRedirectUri,
              env.MICROSOFT_TENANT,
            )
          : null,
      })
    : null;

  const googleCal = tokens && caps.google ? new GoogleCalendarClient(tokens) : null;
  const msCal = tokens && caps.microsoft ? new MicrosoftCalendarClient(tokens) : null;
  const calendar = new CalendarService(repos, googleCal, msCal);

  const sender =
    overrides.sender ??
    (caps.whatsapp
      ? new CloudApiSender(
          env.WHATSAPP_PHONE_NUMBER_ID,
          env.WHATSAPP_ACCESS_TOKEN,
          env.META_GRAPH_VERSION,
        )
      : new NullSender());
  const messenger = new Messenger(sender, repos);

  const tasks = new TaskService(repos);
  const router = new Router(new IntentEngine(ai));

  const emailScanner = tokens
    ? new EmailScanner(
        repos,
        {
          google: caps.google ? new GmailClient(tokens) : null,
          microsoft: caps.microsoft ? new OutlookMailClient(tokens) : null,
        },
        new EmailActionExtractor(ai),
      )
    : null;

  const briefing = new BriefingService(repos, tasks, calendar);
  router.dailyBriefing = async (ctx) => ({
    reply: await briefing.buildDailyBriefing(ctx.user, ctx.settings, ctx.now),
  });

  const reminders = new ReminderEngine(
    repos,
    messenger,
    env.WHATSAPP_TEMPLATE_REMINDER_NAME
      ? { name: env.WHATSAPP_TEMPLATE_REMINDER_NAME, locale: env.WHATSAPP_TEMPLATE_LOCALE }
      : null,
  );

  const scheduler = new Scheduler(repos, reminders, briefing, messenger, emailScanner, {
    tickMs: env.SCHEDULER_TICK_MS,
    batchSize: env.REMINDER_BATCH_SIZE,
  });

  logger().info(
    {
      whatsapp: caps.whatsapp,
      ai: caps.ai ? `${env.AI_PROVIDER}:${env.aiModel}` : false,
      stt: Boolean(stt),
      google: caps.google,
      microsoft: caps.microsoft,
    },
    'application wired',
  );

  return {
    env,
    db,
    repos,
    ai,
    stt,
    tokens,
    sender,
    messenger,
    tasks,
    calendar,
    emailScanner,
    router,
    reminders,
    briefing,
    scheduler,
  };
}
