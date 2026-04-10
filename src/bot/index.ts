/** Bot entry point — creates the GramIO Bot instance, registers all commands and middleware */
import { Bot } from 'gramio';
import { env } from '../config/env';
import { database } from '../database';
import { initSender } from '../services/bank/telegram-sender';
import { runYearSplitMigration } from '../services/google/budget-migration';
import { createExpenseSpreadsheet, googleConn } from '../services/google/sheets';
import { startPhotoProcessor } from '../services/receipt/photo-processor';
import { loadDigitEmojis, loadReactionEmojis } from '../utils/digit-emoji';
import { createLogger } from '../utils/logger.ts';
import { handleAdviceCommand, handleAskQuestion } from './commands/ask';
import { handleBankCommand } from './commands/bank';
import { handleBudgetCommand } from './commands/budget';
import { handleCategoriesCommand } from './commands/categories';
import { handleConnectCommand } from './commands/connect';
import { handleDevCommand, initDevPipeline } from './commands/dev';
import { handleDisconnectCommand } from './commands/disconnect';
import { handleFeedbackCommand } from './commands/feedback';
import { handleHelpCommand } from './commands/help';
import { handlePingCommand } from './commands/ping';
import { handlePromptCommand } from './commands/prompt';
import { handlePushCommand } from './commands/push';
import { handleReconnectCommand } from './commands/reconnect';
import { handleScanCommand } from './commands/scan';
import { handleSettingsCommand } from './commands/settings';
import { handleSpreadsheetCommand } from './commands/spreadsheet';
import { handleStartCommand } from './commands/start';
import { handleStatsCommand } from './commands/stats';
import { handleSumCommand } from './commands/sum';
import { handleSyncCommand } from './commands/sync';
import { handleTopicCommand } from './commands/topic';
import { registerExchangeRateCron, registerMonthlyCron } from './cron';
import { requireGoogle, requireGroup } from './guards';
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

  // Initialize telegram-sender with bot instance — must be after middleware registration
  initSender(bot);

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
            await ensureFreshExpenses(grp.id, chatId);
          }
          if (opts.budgets) {
            const { ensureFreshBudgets } = await import('./services/budget-sync');
            await ensureFreshBudgets(grp.id, chatId);
          }
        }
      }
      return handler(ctx);
    };
  }

  // Commands — no group required
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.command('connect', handleConnectCommand);
  bot.command('reconnect', handleReconnectCommand);
  bot.command('ping', handlePingCommand);

  // Commands — require configured group, no sync needed
  bot.command('spreadsheet', requireGroup(handleSpreadsheetCommand));
  bot.command('settings', requireGroup(handleSettingsCommand));
  bot.command('disconnect', requireGroup(handleDisconnectCommand));
  bot.command('feedback', requireGroup(handleFeedbackCommand));
  bot.command('prompt', requireGroup(handlePromptCommand));
  bot.command('topic', requireGroup(handleTopicCommand));
  bot.command('dev', requireGroup(handleDevCommand));
  bot.command('sync', requireGroup(requireGoogle(handleSyncCommand)));
  bot.command('scan', requireGroup(handleScanCommand));
  bot.command(
    'bank',
    requireGroup((ctx, group) => handleBankCommand(ctx, group, bot)),
  );

  // Commands — require configured group + fresh expenses
  bot.command('stats', withSync(requireGroup(handleStatsCommand), { expenses: true }));
  bot.command('sum', withSync(requireGroup(handleSumCommand), { expenses: true }));
  bot.command('total', withSync(requireGroup(handleSumCommand), { expenses: true }));
  bot.command('push', withSync(requireGroup(requireGoogle(handlePushCommand)), { expenses: true }));
  bot.command('categories', withSync(requireGroup(handleCategoriesCommand), { expenses: true }));

  // Commands — require configured group + fresh expenses + budgets
  bot.command(
    'advice',
    withSync(requireGroup(handleAdviceCommand), { expenses: true, budgets: true }),
  );
  bot.command(
    'budget',
    withSync(requireGroup(requireGoogle(handleBudgetCommand)), { budgets: true }),
  );

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

    // @mention is always the trigger for AI — works regardless of topics config
    if (botUsername) {
      const mentionPattern = new RegExp(`@${botUsername}\\s+(.+)`, 'i');
      const match = text.match(mentionPattern);

      if (match?.[1]) {
        await handleAskQuestion(ctx, match[1].trim(), bot, true);
        return;
      }
    }

    // Determine if AI can be triggered without @mention:
    //   - Regular group / non-forum supergroup: always allowed
    //   - Forum supergroup: allowed only when a topic is locked via /topic
    const isGroupChat = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    let allowDirectAI = false;
    if (isGroupChat) {
      const isForum = ctx.chat.isForum === true;
      if (!isForum) {
        allowDirectAI = true;
      } else {
        const grp = database.groups.findByTelegramGroupId(ctx.chat.id);
        allowDirectAI = grp?.active_topic_id != null;
      }
    }

    // Try to handle as expense; if nothing was parsed and direct AI is allowed, answer as question
    const expenseHandled = await handleExpenseMessage(ctx, bot);
    if (!expenseHandled && allowDirectAI) {
      await handleAskQuestion(ctx, text, bot);
    }
  });

  // Global error handler — catches unhandled errors in bot middleware/handlers
  bot.onError(({ kind, error }) => {
    logger.error({ err: error, kind }, '[BOT] Unhandled error');
  });

  // Fetch exchange rates on startup + every 6h
  registerExchangeRateCron();

  // Register monthly budget tab cron
  registerMonthlyCron();

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
    const { ensureSheetColumns, googleConn: makeConn } = await import('../services/google/sheets');
    const allGroups = database.groups.findAll();
    for (const group of allGroups) {
      if (group.spreadsheet_id && group.google_refresh_token) {
        await ensureSheetColumns(makeConn(group), group.spreadsheet_id, group.enabled_currencies);
      }
    }
    logger.info('✓ Spreadsheet columns verified');
  } catch (err) {
    logger.error({ err }, 'Failed to verify spreadsheet columns (non-fatal)');
  }

  // Load custom emojis for expense summaries and reactions
  await loadDigitEmojis(bot);
  await loadReactionEmojis(bot);

  // Start background photo processor
  logger.info('📸 Starting photo processor...');
  await startPhotoProcessor(bot);
  logger.info('✓ Photo processor started');

  // Initialize dev pipeline and resume incomplete tasks
  logger.info('🔧 Starting dev pipeline...');
  const devPipeline = initDevPipeline();
  await devPipeline.resumeIncompleteTasksOnStartup();
  logger.info('✓ Dev pipeline started');

  return bot;
}

/**
 * One-time year-split migration: for each group whose existing spreadsheet pre-dates the
 * current year, create a new current-year spreadsheet, copy current-year rows there,
 * and clean up the old spreadsheet.
 */
export function createStartupMigration(bot: Bot) {
  return async function runStartupYearSplitMigration(): Promise<void> {
    const currentYear = new Date().getFullYear();
    const groups = database.groups.findAll();

    for (const group of groups) {
      if (!group.google_refresh_token) continue;

      const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);
      if (allSpreadsheets.length === 0) continue;

      // Skip if current year already has a spreadsheet (migration already done or not needed)
      const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
      if (currentSpreadsheetId) continue;

      // Find the most recent prior-year spreadsheet to split from
      const priorSpreadsheet = allSpreadsheets.find((s) => s.year < currentYear);
      if (!priorSpreadsheet) continue;

      try {
        // 1. Create new current-year spreadsheet
        const conn = googleConn(group);
        const { spreadsheetId: newId, spreadsheetUrl: newUrl } = await createExpenseSpreadsheet(
          conn,
          group.default_currency,
          group.enabled_currencies,
        );
        database.groupSpreadsheets.setYear(group.id, currentYear, newId);
        logger.info(`[STARTUP] Created ${currentYear} spreadsheet for group ${group.id}: ${newId}`);

        // 2. Run year-split: move currentYear rows from old spreadsheet to new one
        const backupUrl = await runYearSplitMigration(
          conn,
          priorSpreadsheet.spreadsheetId,
          newId,
          currentYear,
        );
        if (backupUrl) {
          logger.info(`[STARTUP] Year-split done for group ${group.id}. Backup: ${backupUrl}`);
        }

        // 3. Notify the group
        await bot.api
          .sendMessage({
            chat_id: group.telegram_group_id,
            text:
              `Создана таблица ${currentYear}: ${newUrl}\n` +
              `Данные за ${currentYear} перенесены из таблицы ${priorSpreadsheet.year}.`,
            ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
          })
          .catch((err: unknown) =>
            logger.error({ err }, `[STARTUP] Failed to notify group ${group.id}`),
          );
      } catch (err) {
        logger.error(
          { err },
          `[STARTUP] Year-split migration FAILED for group ${group.id} — skipping`,
        );
      }
    }
  };
}
