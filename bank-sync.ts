// Entry point for the bank-sync PM2 process.
// Shares the SQLite database with the main bot but runs independently.
import { processMerchantRequests } from './src/services/bank/merchant-agent';
import { startSyncService } from './src/services/bank/sync-service';
import { createLogger } from './src/utils/logger.ts';

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
