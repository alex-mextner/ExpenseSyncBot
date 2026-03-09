import { startOAuthServer } from './src/web/oauth-callback';
import { startBot } from './src/bot';
import { database } from './src/database';
import { updateExchangeRates } from './src/services/currency/converter';
import { startTempImageCleanup } from './src/services/receipt/ocr-extractor';
import { scheduleNewsBroadcast } from './src/services/broadcast';

/**
 * Main application entry point
 */
async function main() {
  console.log('🚀 Starting ExpenseSyncBot...\n');

  try {
    // Initialize database
    console.log('📦 Initializing database...');
    // Database is initialized on import
    console.log('✓ Database ready\n');

    // Update exchange rates
    console.log('💱 Updating exchange rates...');
    await updateExchangeRates();
    console.log('✓ Exchange rates updated\n');

    // Start OAuth callback server
    console.log('🌐 Starting OAuth server...');
    startOAuthServer();
    console.log('');

    // Start temp image cleanup
    console.log('🧹 Starting temp image cleanup...');
    startTempImageCleanup();
    console.log('');

    // Start Telegram bot
    console.log('🤖 Starting Telegram bot...');
    const bot = await startBot();
    console.log('');

    // Schedule news broadcast
    scheduleNewsBroadcast(bot);
    console.log('');

    console.log('✅ ExpenseSyncBot is running!\n');
    console.log('Press Ctrl+C to stop\n');
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...');
  database.close();
  console.log('✓ Database closed');
  console.log('Goodbye! 👋');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Shutting down...');
  database.close();
  console.log('✓ Database closed');
  console.log('Goodbye! 👋');
  process.exit(0);
});

// Start the application
main();
