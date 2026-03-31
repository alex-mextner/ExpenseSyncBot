/**
 * /dev command handler — self-modifying bot interface.
 *
 * Usage:
 *   /dev <description>     — start a new dev task
 *   /dev status             — show active dev tasks
 *   /dev plan <id>          — show task design plan
 *   /dev approve <id>       — approve a task's design
 *   /dev cancel <id>        — cancel a task
 *   /dev continue <id> [msg] — resume a failed/stuck task
 *   /dev history            — show recent completed tasks
 *   /dev logs prod|stage    — download PM2 logs
 */

import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { sendMessage, withChatContext } from '../../services/bank/telegram-sender';
import { DevPipeline, type NotifyCallback } from '../../services/dev-pipeline/pipeline';
import { DevTaskState, STATE_EMOJI, STATE_LABELS } from '../../services/dev-pipeline/types';
import { getErrorMessage } from '../../utils/error';
import { createLogger } from '../../utils/logger.ts';
import type { BotInstance, Ctx } from '../types';

const logger = createLogger('dev');

/** Singleton pipeline instance — initialized lazily */
let pipeline: DevPipeline | null = null;

/** Tracks chats waiting for design edit input: chatId → taskId */
const pendingDesignEdits = new Map<number, number>();

/**
 * Check if a chat has a pending design edit, consume it if so.
 * Called from message handler.
 */
export function consumePendingDesignEdit(chatId: number): number | null {
  const taskId = pendingDesignEdits.get(chatId);
  if (taskId !== undefined) {
    pendingDesignEdits.delete(chatId);
    return taskId;
  }
  return null;
}

/**
 * Initialize the pipeline with a notification callback.
 *
 * Must be called once with a bot instance to enable notifications.
 */
export function initDevPipeline(): DevPipeline {
  const notify: NotifyCallback = async (
    groupId: number,
    message: string,
    options?: { reply_markup?: InlineKeyboard },
  ) => {
    const group = database.groups.findById(groupId);
    if (!group) return;

    try {
      await withChatContext(group.telegram_group_id, group.active_topic_id ?? null, () =>
        sendMessage(message, options),
      );
    } catch (error) {
      logger.error({ err: error }, '[DEV-CMD] Failed to send notification');
    }
  };

  pipeline = new DevPipeline(notify);
  return pipeline;
}

/**
 * Get the pipeline instance.
 * Returns null if not initialized yet.
 */
function getPipeline(): DevPipeline | null {
  return pipeline;
}

/** Exposed for message handler to call editDesign */
export function getPipelineInstance(): DevPipeline | null {
  return pipeline;
}

/**
 * /dev command handler
 */
export async function handleDevCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  const telegramId = ctx.from?.id;

  // Ensure user exists
  let user = database.users.findByTelegramId(telegramId);
  if (!user) {
    user = database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  }

  // Parse command arguments
  const fullText = ctx.text || '';
  const parts = fullText
    .trim()
    .split(/\s+/)
    .filter((arg: string) => arg.length > 0);

  // Remove the command itself
  const args = parts[0]?.startsWith('/') ? parts.slice(1) : parts;

  if (args.length === 0) {
    await showUsage();
    return;
  }

  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case 'status':
      await showStatus(ctx, group.id);
      break;

    case 'approve':
      await handleApprove(ctx, args, group.id);
      break;

    case 'cancel':
      await handleCancel(ctx, args, group.id);
      break;

    case 'plan':
      await handlePlan(ctx, args, group.id);
      break;

    case 'answer':
      await handleAnswer(ctx, args, group.id);
      break;

    case 'continue':
      await handleContinue(ctx, args, group.id);
      break;

    case 'history':
      await showHistory(ctx, group.id);
      break;

    case 'logs':
      await handleLogs(ctx, args, group.id);
      break;

    default:
      // Everything after /dev is the task description
      await handleNewTask(ctx, args.join(' '), group.id, user.id);
      break;
  }
}

/**
 * Show usage help
 */
async function showUsage(): Promise<void> {
  await sendMessage(
    '<b>Dev Pipeline</b>\n\n' +
      'Usage:\n' +
      '/dev &lt;description&gt; — start a new task\n' +
      '/dev status — show active tasks\n' +
      '/dev plan &lt;id&gt; — show task design plan\n' +
      '/dev approve &lt;id&gt; — approve a design\n' +
      '/dev cancel &lt;id&gt; — cancel a task\n' +
      '/dev answer &lt;id&gt; &lt;text&gt; — answer clarifying questions\n' +
      '/dev continue &lt;id&gt; [msg] — resume a failed/stuck task\n' +
      '/dev history — recent completed tasks\n' +
      '/dev logs prod|stage — download PM2 logs',
  );
}

/**
 * Create a new dev task
 */
async function handleNewTask(
  ctx: Ctx['Command'],
  description: string,
  groupId: number,
  userId: number,
): Promise<void> {
  void ctx;
  const pl = getPipeline();

  if (!pl) {
    await sendMessage('Dev pipeline not initialized. Bot needs restart.');
    return;
  }

  if (!description.trim()) {
    await sendMessage('Provide a task description: /dev <description>');
    return;
  }

  // Limit concurrent tasks
  const activeCount = database.devTasks.countActive(groupId);
  if (activeCount >= 3) {
    await sendMessage(
      `Too many active tasks (${activeCount}). Wait for some to finish or cancel them.`,
    );
    return;
  }

  try {
    await pl.startTask(groupId, userId, description);
    // The pipeline sends its own notifications, so no need to reply here
  } catch (error) {
    logger.error({ err: error }, '[DEV-CMD] Failed to start task');
    await sendMessage(`Failed to start task: ${getErrorMessage(error)}`);
  }
}

/**
 * Show active dev tasks
 */
async function showStatus(ctx: Ctx['Command'], groupId: number): Promise<void> {
  void ctx;
  const tasks = database.devTasks.findActiveByGroupId(groupId);

  if (tasks.length === 0) {
    await sendMessage('No active dev tasks.');
    return;
  }

  let message = '<b>Active Dev Tasks</b>\n\n';

  for (const task of tasks) {
    const emoji = STATE_EMOJI[task.state as DevTaskState] || '?';
    const label = STATE_LABELS[task.state as DevTaskState] || task.state;

    message += `${emoji} <b>#${task.id}</b> ${label}\n`;
    message += `${task.description.slice(0, 100)}\n`;

    if (task.pr_url) {
      message += `PR: ${task.pr_url}\n`;
    }

    if (task.retry_count > 0) {
      message += `Retries: ${task.retry_count}\n`;
    }

    message += '\n';
  }

  await sendMessage(message);
}

/**
 * Approve a task's design
 */
async function handleApprove(ctx: Ctx['Command'], args: string[], groupId: number): Promise<void> {
  void ctx;
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await sendMessage('Usage: /dev approve <task_id>');
    return;
  }

  const pl = getPipeline();

  if (!pl) {
    await sendMessage('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);

    if (!task) {
      await sendMessage(`Task #${taskId} not found.`);
      return;
    }

    if (task.group_id !== groupId) {
      await sendMessage(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.approveTask(taskId);
    // Pipeline sends its own notification
  } catch (error) {
    await sendMessage(`Failed to approve: ${getErrorMessage(error)}`);
  }
}

/**
 * Cancel (or reject) a task
 */
async function handleCancel(ctx: Ctx['Command'], args: string[], groupId: number): Promise<void> {
  void ctx;
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await sendMessage('Usage: /dev cancel <task_id>');
    return;
  }

  const pl = getPipeline();

  if (!pl) {
    await sendMessage('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);

    if (!task) {
      await sendMessage(`Task #${taskId} not found.`);
      return;
    }

    if (task.group_id !== groupId) {
      await sendMessage(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.cancelTask(taskId);
  } catch (error) {
    await sendMessage(`Failed to cancel: ${getErrorMessage(error)}`);
  }
}

/**
 * Show the design plan for a task
 */
async function handlePlan(ctx: Ctx['Command'], args: string[], groupId: number): Promise<void> {
  void ctx;
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await sendMessage('Usage: /dev plan <task_id>');
    return;
  }

  const task = database.devTasks.findById(taskId);

  if (!task) {
    await sendMessage(`Task #${taskId} not found.`);
    return;
  }

  if (task.group_id !== groupId) {
    await sendMessage(`Task #${taskId} does not belong to this group.`);
    return;
  }

  if (!task.design) {
    await sendMessage(`Task #${taskId} has no design plan yet.`);
    return;
  }

  const { escapeHtml } = await import('../../utils/html');
  const keyboard = new InlineKeyboard().text('✕ Скрыть', `dev:hide_plan:${taskId}`);

  await sendMessage(
    `📐 <b>Dev task #${taskId}:</b> ${escapeHtml(task.title || 'plan')}\n\n` +
      `<pre>${escapeHtml(task.design.slice(0, 3500))}</pre>`,
    { reply_markup: keyboard },
  );
}

/**
 * Answer clarifying questions for a task
 */
async function handleAnswer(ctx: Ctx['Command'], args: string[], groupId: number): Promise<void> {
  void ctx;
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await sendMessage('Usage: /dev answer <task_id> <your answers>');
    return;
  }

  const answer = args.slice(2).join(' ');
  if (!answer.trim()) {
    await sendMessage('Provide your answers: /dev answer <task_id> <text>');
    return;
  }

  const pl = getPipeline();
  if (!pl) {
    await sendMessage('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      await sendMessage(`Task #${taskId} not found.`);
      return;
    }
    if (task.group_id !== groupId) {
      await sendMessage(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.answerTask(taskId, answer);
  } catch (error) {
    await sendMessage(`Failed: ${getErrorMessage(error)}`);
  }
}

/**
 * Continue/resume a failed or stuck task
 */
async function handleContinue(ctx: Ctx['Command'], args: string[], groupId: number): Promise<void> {
  void ctx;
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await sendMessage('Usage: /dev continue <task_id> [message]');
    return;
  }

  const message = args.slice(2).join(' ') || 'Продолжай';

  const pl = getPipeline();
  if (!pl) {
    await sendMessage('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      await sendMessage(`Task #${taskId} not found.`);
      return;
    }
    if (task.group_id !== groupId) {
      await sendMessage(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.continueTask(taskId, message);
  } catch (error) {
    await sendMessage(`Failed: ${getErrorMessage(error)}`);
  }
}

/**
 * Show recently completed tasks
 */
async function showHistory(ctx: Ctx['Command'], groupId: number): Promise<void> {
  void ctx;
  const tasks = database.devTasks.findByGroupId(groupId, 10);

  if (tasks.length === 0) {
    await sendMessage('No dev tasks found.');
    return;
  }

  let message = '<b>Recent Dev Tasks</b>\n\n';

  for (const task of tasks) {
    const emoji = STATE_EMOJI[task.state as DevTaskState] || '?';
    const label = STATE_LABELS[task.state as DevTaskState] || task.state;

    message += `${emoji} <b>#${task.id}</b> ${label}\n`;
    message += `${task.description.slice(0, 80)}\n`;

    if (task.pr_url) {
      message += `PR: ${task.pr_url}\n`;
    }

    message += '\n';
  }

  await sendMessage(message);
}

/** PM2 log file paths on the server */
const LOG_PATHS: Record<string, { out: string; error: string }> = {
  prod: {
    out: '/var/www/ExpenseSyncBot/logs/out.log',
    error: '/var/www/ExpenseSyncBot/logs/error.log',
  },
  stage: {
    out: '/var/www/ExpenseSyncBot-stage/logs/out.log',
    error: '/var/www/ExpenseSyncBot-stage/logs/error.log',
  },
};

/** Max bytes to read from each log file */
const MAX_LOG_BYTES = 100 * 1024; // 100KB

/**
 * Send PM2 log files as Telegram documents
 */
async function handleLogs(ctx: Ctx['Command'], args: string[], _groupId: number): Promise<void> {
  const target = args[1]?.toLowerCase();

  if (!target || !LOG_PATHS[target]) {
    await sendMessage('Usage: /dev logs prod|stage');
    return;
  }

  const logs = LOG_PATHS[target];
  const outPath = logs.out;
  const errorPath = logs.error;

  const outFile = Bun.file(outPath);
  const errorFile = Bun.file(errorPath);

  const outExists = await outFile.exists();
  const errorExists = await errorFile.exists();

  if (!outExists && !errorExists) {
    await sendMessage(`No log files found for ${target}. Is the bot running?`);
    return;
  }

  // Read and send stdout log
  if (outExists) {
    const outSize = outFile.size;
    const outStart = Math.max(0, outSize - MAX_LOG_BYTES);
    const outContent = await outFile.slice(outStart, outSize).text();

    await ctx.sendDocument(new File([outContent], `${target}-out.log`, { type: 'text/plain' }), {
      caption: `📋 ${target} stdout (last ${Math.round(outContent.length / 1024)}KB)`,
    });
  }

  // Read and send stderr log
  if (errorExists) {
    const errorSize = errorFile.size;
    if (errorSize === 0) {
      await sendMessage(`✅ ${target} error log is empty — no errors.`);
    } else {
      const errorStart = Math.max(0, errorSize - MAX_LOG_BYTES);
      const errorContent = await errorFile.slice(errorStart, errorSize).text();

      await ctx.sendDocument(
        new File([errorContent], `${target}-error.log`, { type: 'text/plain' }),
        { caption: `⚠️ ${target} stderr (last ${Math.round(errorContent.length / 1024)}KB)` },
      );
    }
  }
}

/**
 * Handle dev task callback queries (approval buttons etc.)
 */
export async function handleDevCallback(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, taskIdStr] = params;
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  logger.info(
    `[DEV-CB] Callback: dev:${subAction}:${taskIdStr} from user ${telegramId}, chat ${chatId}`,
  );

  if (!subAction || !taskIdStr) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const taskId = parseInt(taskIdStr, 10);

  if (Number.isNaN(taskId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid task ID' });
    return;
  }

  const pl = getPipeline();

  if (!pl) {
    await ctx.answerCallbackQuery({ text: 'Pipeline not initialized' });
    return;
  }

  let answered = false;
  try {
    switch (subAction) {
      case 'approve':
        await pl.approveTask(taskId);
        await ctx.answerCallbackQuery({ text: 'Approved!' });
        answered = true;
        break;

      case 'reject':
      case 'cancel':
        await pl.cancelTask(taskId);
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        answered = true;
        break;

      case 'hide_plan':
        await ctx.answerCallbackQuery({ text: 'OK' });
        answered = true;
        if (messageId && chatId) {
          try {
            await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
          } catch {
            // Expected: message may already be deleted
          }
        }
        return;

      case 'accept_review':
        await pl.acceptReview(taskId);
        await ctx.answerCallbackQuery({ text: 'Fixing review issues...' });
        answered = true;
        break;

      case 'merge':
        await pl.mergeTask(taskId);
        await ctx.answerCallbackQuery({ text: 'Merging...' });
        answered = true;
        break;

      case 'edit': {
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: 'No chat context' });
          return;
        }
        const editTask = database.devTasks.findById(taskId);
        logger.info(`[DEV-CB] Edit task #${taskId}, state: ${editTask?.state}, chatId: ${chatId}`);
        pendingDesignEdits.set(chatId, taskId);
        await ctx.answerCallbackQuery({ text: 'Опишите правки' });
        answered = true;

        const isDesignEdit = editTask?.state === DevTaskState.APPROVAL;
        const promptText = isDesignEdit
          ? `✏️ Опишите, что изменить в дизайне задачи #${taskId}:`
          : `✏️ Опишите, что изменить в коде задачи #${taskId}:`;

        await sendMessage(promptText, {
          reply_markup: { force_reply: true, selective: true },
        });
        logger.info(`[DEV-CB] Edit force_reply sent for task #${taskId}`);
        return; // Don't delete the button message
      }

      default:
        await ctx.answerCallbackQuery({ text: 'Unknown action' });
        answered = true;
    }
  } catch (error) {
    logger.error({ err: error }, `[DEV-CB] Error handling dev:${subAction}:${taskIdStr}`);
    if (!answered) {
      try {
        await ctx.answerCallbackQuery({
          text: `Error: ${getErrorMessage(error)}`,
        });
      } catch {
        // Best-effort error notification — original error already logged above
      }
    }
  }

  // Delete the button message
  if (messageId && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {
      // Expected: message may already be deleted
    }
  }
}
