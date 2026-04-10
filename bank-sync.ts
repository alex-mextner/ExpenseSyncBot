// Entry point for the bank-sync PM2 process.
// Shares the SQLite database with the main bot but runs independently.
import { Bot } from 'gramio';
import { rateLimitOnResponseError, rateLimitPreRequest } from './src/bot/rate-limit.hook';
import { sanitizeOutgoingMessages } from './src/bot/sanitize-outgoing.hook';
import { registerTopicMiddleware } from './src/bot/topic-middleware';
import { env } from './src/config/env';
import { processMerchantRequests } from './src/services/bank/merchant-agent';
import { installPluginConsoleFilter } from './src/services/bank/plugin-console-filter';
import { startSyncService } from './src/services/bank/sync-service';
import { initSender } from './src/services/bank/telegram-sender';
import { createLogger } from './src/utils/logger.ts';

// Must run before any plugin code executes. Routes console.* through pino
// (silent at debug level in prod) and scrubs PAN/IBAN/phone/token patterns.
installPluginConsoleFilter();

// Create a Bot instance for outbound API calls (transaction cards, panel
// updates) — this process never calls bot.start() because only the main
// expensesyncbot process owns long-polling. Replicates the outbound-facing
// subset of the main bot wiring so 429 backoff, HTML sanitization, topic
// thread_id injection, and the telegram-sender helper all behave identically
// across the two processes.
const bot = new Bot(env.BOT_TOKEN);
bot.preRequest(rateLimitPreRequest);
bot.onResponseError(rateLimitOnResponseError);
bot.preRequest(sanitizeOutgoingMessages);
registerTopicMiddleware(bot);
initSender(bot);

const logger = createLogger('bank-sync-main');

logger.info('Bank-sync service starting…');

// Run merchant request processing every 5 minutes
setInterval(
  () => {
    processMerchantRequests().catch((err) =>
      logger.error({ err }, 'Merchant processing cycle error'),
    );
  },
  5 * 60 * 1000,
);

// Start bank sync scheduler (per-connection polling)
startSyncService();

logger.info('Bank-sync service started');
