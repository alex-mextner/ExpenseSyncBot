import { Bot } from 'gramio';
import { env } from '../config/env';
import { database } from '../database';
import { startPhotoProcessor } from '../services/receipt/photo-processor';
import { createLogger } from '../utils/logger.ts';
import { handleAdviceCommand, handleAskQuestion } from './commands/ask';
import { handleBudgetCommand } from './commands/budget';
import { handleCategoriesCommand } from './commands/categories';
import { handleConnectCommand } from './commands/connect';
import { handleDevCommand, initDevPipeline } from './commands/dev';
import { handleHelpCommand } from './commands/help';
import { handlePingCommand } from './commands/ping';
import { handlePromptCommand } from './commands/prompt';
import { handlePushCommand } from './commands/push';
import { handleReconnectCommand, handleSettingsCommand } from './commands/settings';
import { handleSpreadsheetCommand } from './commands/spreadsheet';
import { handleStartCommand } from './commands/start';
import { handleStatsCommand } from './commands/stats';
import { handleSumCommand } from './commands/sum';
import { handleSyncCommand } from './commands/sync';
import { handleTopicCommand } from './commands/topic';
import { handleCallbackQuery } from './handlers/callback.handler';
import { handleExpenseMessage } from './handlers/message.handler';
import { handlePhotoMessage } from './handlers/photo.handler';
import { rateLimitOnResponseError, rateLimitPreRequest } from './rate-limit.hook';
import { sanitizeOutgoingMessages } from './sanitize-outgoing.hook';
import { registerTopicMiddleware } from './topic-middleware';
import type { Ctx } from './types';

const logger = createLogger('index');

/**
 * Initialize and configure bot
 */
export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Rate limiter — must be first: respects 429 backoff before any API call
  bot.preRequest(rateLimitPreRequest);
  bot.onResponseError(rateLimitOnResponseError);

  // Sanitize all outgoing HTML messages before they reach Telegram
  bot.preRequest(sanitizeOutgoingMessages);

  // Global topic-aware middleware — must be registered before handlers
  registerTopicMiddleware(bot);

  // Cache bot username
  let botUsername: string | undefined;

  /**
   * Pre-sync wrapper for commands that need fresh data from Google Sheets.
   * Syncs expenses and/or budgets before the handler runs (blocking, with cooldown).
   */
  function withSync(
    handler: (ctx: Ctx['Command']) => Promise<void>,
    opts: { expenses?: boolean; budgets?: boolean } = {},
  ) {
    return async (ctx: Ctx['Command']) => {
      const chatId = ctx.chat?.id;
      const isGrp = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
      if (isGrp && chatId) {
        const grp = database.groups.findByTelegramGroupId(chatId);
        if (grp?.spreadsheet_id && grp?.google_refresh_token) {
          if (opts.expenses) {
            const { ensureFreshExpenses } = await import('./commands/sync');
            await ensureFreshExpenses(grp.id, chatId, bot);
          }
          if (opts.budgets) {
            const { ensureFreshBudgets } = await import('./commands/budget');
            await ensureFreshBudgets(grp.id, chatId, bot);
          }
        }
      }
      return handler(ctx);
    };
  }

  // Commands — no sync needed
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.command('connect', handleConnectCommand);
  bot.command('spreadsheet', handleSpreadsheetCommand);
  bot.command('settings', handleSettingsCommand);
  bot.command('reconnect', handleReconnectCommand);
  bot.command('prompt', handlePromptCommand);
  bot.command('topic', handleTopicCommand);
  bot.command('dev', handleDevCommand);
  bot.command('ping', handlePingCommand);
  bot.command('sync', handleSyncCommand);

  // Commands — need fresh expenses
  bot.command('stats', withSync(handleStatsCommand, { expenses: true }));
  bot.command('sum', withSync(handleSumCommand, { expenses: true }));
  bot.command('total', withSync(handleSumCommand, { expenses: true }));
  bot.command('push', withSync(handlePushCommand, { expenses: true }));
  bot.command('categories', withSync(handleCategoriesCommand, { expenses: true }));

  // Commands — need fresh expenses + budgets
  bot.command('advice', withSync(handleAdviceCommand, { expenses: true, budgets: true }));
  bot.command('budget', withSync(handleBudgetCommand, { budgets: true }));

  // Callback queries (inline keyboard buttons)
  bot.on('callback_query', (ctx) => handleCallbackQuery(ctx, bot));

  // Text messages (expense entries or questions)
  bot.on('message', async (ctx) => {
    // Handle photo messages (receipts with QR codes)
    if (ctx.photo && ctx.photo.length > 0) {
      await handlePhotoMessage(ctx);
      return;
    }

    // Skip if it's a command
    if (ctx.text?.startsWith('/')) {
      return;
    }

    // Skip if no text
    if (!ctx.text) {
      return;
    }

    // Get bot username once
    if (!botUsername) {
      const botInfo = await bot.api.getMe();
      botUsername = botInfo.username;
    }

    const text = ctx.text;

    // Check for @botname mention
    if (botUsername) {
      const mentionPattern = new RegExp(`@${botUsername}\\s+(.+)`, 'i');
      const match = text.match(mentionPattern);

      if (match?.[1]) {
        // Handle as question
        await handleAskQuestion(ctx, match[1].trim(), bot);
        return;
      }
    }

    // Handle as expense message
    await handleExpenseMessage(ctx, bot);
  });

  return bot;
}

/**
 * Start bot
 */
export async function startBot(): Promise<Bot> {
  const bot = createBot();

  logger.info('🤖 Starting bot...');
  await bot.start();
  logger.info('✓ Bot started successfully');

  // Register commands in Telegram menu (from single source of truth)
  const { BOT_COMMANDS } = await import('./command-descriptions');
  await bot.api.setMyCommands({
    commands: BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })),
  });
  logger.info('✓ Bot commands registered');

  // Ensure spreadsheet columns are up to date for all configured groups
  try {
    const { ensureSheetColumns } = await import('../services/google/sheets');
    const allGroups = database.groups.findAll();
    for (const group of allGroups) {
      if (group.spreadsheet_id && group.google_refresh_token) {
        await ensureSheetColumns(
          group.google_refresh_token,
          group.spreadsheet_id,
          group.enabled_currencies,
        );
      }
    }
    logger.info('✓ Spreadsheet columns verified');
  } catch (err) {
    logger.error({ err }, 'Failed to verify spreadsheet columns (non-fatal)');
  }

  // Start background photo processor
  logger.info('📸 Starting photo processor...');
  await startPhotoProcessor(bot);
  logger.info('✓ Photo processor started');

  // Initialize dev pipeline and resume incomplete tasks
  logger.info('🔧 Starting dev pipeline...');
  const devPipeline = initDevPipeline(bot);
  await devPipeline.resumeIncompleteTasksOnStartup();
  logger.info('✓ Dev pipeline started');

  return bot;
}
