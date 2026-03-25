import { startOAuthServer } from './src/web/oauth-callback';
import { startBot } from './src/bot';
import { database } from './src/database';
import { updateExchangeRates } from './src/services/currency/converter';
import { startTempImageCleanup } from './src/services/receipt/ocr-extractor';
import { scheduleNewsBroadcast } from './src/services/broadcast';
import { createLogger } from './src/utils/logger';

const logger = createLogger('main');

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

    scheduleNewsBroadcast(bot);

    logger.info('ExpenseSyncBot is running');
  } catch (error) {
    logger.fatal({ err: error }, 'Fatal startup error');
    process.exit(1);
  }
}

// Catch unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[PROCESS] Unhandled rejection');
});
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, '[PROCESS] Uncaught exception');
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  database.close();
  logger.info('Database closed. Goodbye.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down (SIGTERM)...');
  database.close();
  logger.info('Database closed. Goodbye.');
  process.exit(0);
});

// Start the application
main();
