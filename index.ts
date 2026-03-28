import { createStartupMigration, startBot } from './src/bot';
import { database } from './src/database';
import { scheduleNewsBroadcast } from './src/services/broadcast';
import { updateExchangeRates } from './src/services/currency/converter';
import { startTempImageCleanup } from './src/services/receipt/ocr-extractor';
import { createLogger } from './src/utils/logger.ts';
import { startOAuthServer } from './src/web/oauth-callback';

const logger = createLogger('main');

/**
 * Main application entry point
 */
async function main() {
  logger.info('Starting ExpenseSyncBot...');

  try {
    // Initialize database
    logger.info('Initializing database...');
    // Database is initialized on import
    logger.info('Database ready');

    // Update exchange rates
    logger.info('Updating exchange rates...');
    await updateExchangeRates();
    logger.info('Exchange rates updated');

    // Start OAuth callback server
    logger.info('Starting OAuth server...');
    startOAuthServer();

    // Start temp image cleanup
    logger.info('Starting temp image cleanup...');
    startTempImageCleanup();

    // Start Telegram bot
    logger.info('Starting Telegram bot...');
    const bot = await startBot();

    // Run one-time year-split migration (idempotent)
    await createStartupMigration(bot)();

    // Schedule news broadcast
    scheduleNewsBroadcast(bot);

    logger.info('ExpenseSyncBot is running!');
  } catch (error) {
    logger.error({ err: error }, 'Fatal error');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  database.close();
  logger.info('Database closed. Goodbye!');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  database.close();
  logger.info('Database closed. Goodbye!');
  process.exit(0);
});

// Start the application
main();
