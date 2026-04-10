// Application entry point — initializes database, OAuth server, exchange rates, and starts the Telegram bot
import { createStartupMigration, startBot } from './src/bot';
import { database } from './src/database';
import { startSyncService } from './src/services/bank/sync-service';
import { scheduleNewsBroadcast } from './src/services/broadcast';
import { updateExchangeRates } from './src/services/currency/converter';
import { startTempImageCleanup } from './src/services/receipt/ocr-extractor';
import { createLogger } from './src/utils/logger';
import { startOAuthServer } from './src/web/oauth-callback';

const logger = createLogger('main');

// Module-level ref so shutdown handler can stop the bot.
let stopBotFn: (() => Promise<void>) | null = null;

/**
 * Main application entry point
 */
async function main() {
  logger.info('Starting ExpenseSyncBot...');

  try {
    logger.info('Initializing database...');
    // Database is initialized on import
    logger.info('Database ready');

    logger.info('Updating exchange rates...');
    await updateExchangeRates();
    logger.info('Exchange rates updated');

    logger.info('Starting OAuth server...');
    startOAuthServer();

    logger.info('Starting temp image cleanup...');
    startTempImageCleanup();

    logger.info('Starting Telegram bot...');
    const bot = await startBot();
    stopBotFn = () => bot.stop(3_000).catch(() => {});

    // Run one-time year-split migration (idempotent)
    await createStartupMigration(bot)();

    scheduleNewsBroadcast();

    startSyncService();

    logger.info('ExpenseSyncBot is running');
  } catch (error) {
    logger.fatal({ err: error }, 'Fatal startup error');
    process.exit(1);
  }
}

function gracefulShutdown(signal: string): void {
  logger.info(`Shutting down (${signal})...`);
  (async () => {
    if (stopBotFn) await stopBotFn();
    database.close();
    logger.info('Goodbye.');
    process.exit(0);
  })().catch((err) => {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  });
}

// Catch unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)) },
    '[PROCESS] Unhandled rejection',
  );
});
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, '[PROCESS] Uncaught exception');
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the application
main();
