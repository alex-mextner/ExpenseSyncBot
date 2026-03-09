/**
 * /dev command handler — self-modifying bot interface.
 *
 * Usage:
 *   /dev <description>     — start a new dev task
 *   /dev status             — show active dev tasks
 *   /dev approve <id>       — approve a task's design
 *   /dev reject <id>        — reject a task
 *   /dev cancel <id>        — cancel a task
 *   /dev history            — show recent completed tasks
 */

import type { Ctx } from '../types';
import { database } from '../../database';
import { DevPipeline, type NotifyCallback } from '../../services/dev-pipeline/pipeline';
import {
  DevTaskState,
  STATE_LABELS,
  STATE_EMOJI,
} from '../../services/dev-pipeline/types';

/** Singleton pipeline instance — initialized lazily */
let pipeline: DevPipeline | null = null;

/**
 * Initialize the pipeline with a notification callback.
 *
 * Must be called once with a bot instance to enable notifications.
 */
export function initDevPipeline(bot: any): DevPipeline {
  const notify: NotifyCallback = async (groupId: number, message: string) => {
    const group = database.groups.findById(groupId);
    if (!group) return;

    try {
      await bot.api.sendMessage({
        chat_id: group.telegram_group_id,
        text: message,
        parse_mode: 'HTML',
      });
    } catch (error) {
      console.error('[DEV-CMD] Failed to send notification:', error);
    }
  };

  pipeline = new DevPipeline(notify);
  return pipeline;
}

/**
 * Get or create the pipeline instance.
 * Returns null if not initialized yet.
 */
function getPipeline(): DevPipeline | null {
  return pipeline;
}

/**
 * /dev command handler
 */
export async function handleDevCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const telegramId = ctx.from?.id;

  if (!chatId || !telegramId) {
    await ctx.send('Error: Unable to identify chat or user');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.send('This command only works in groups.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('Group not configured. Use /connect first.');
    return;
  }

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
    await showUsage(ctx);
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

    case 'reject':
      await handleReject(ctx, args, group.id);
      break;

    case 'cancel':
      await handleCancel(ctx, args, group.id);
      break;

    case 'answer':
      await handleAnswer(ctx, args, group.id);
      break;

    case 'history':
      await showHistory(ctx, group.id);
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
async function showUsage(ctx: Ctx['Command']): Promise<void> {
  await ctx.send(
    '<b>Dev Pipeline</b>\n\n' +
      'Usage:\n' +
      '/dev &lt;description&gt; — start a new task\n' +
      '/dev status — show active tasks\n' +
      '/dev approve &lt;id&gt; — approve a design\n' +
      '/dev reject &lt;id&gt; — reject a task\n' +
      '/dev cancel &lt;id&gt; — cancel a task\n' +
      '/dev answer &lt;id&gt; &lt;text&gt; — answer clarifying questions\n' +
      '/dev history — recent completed tasks',
    { parse_mode: 'HTML' }
  );
}

/**
 * Create a new dev task
 */
async function handleNewTask(
  ctx: Ctx['Command'],
  description: string,
  groupId: number,
  userId: number
): Promise<void> {
  const pl = getPipeline();

  if (!pl) {
    await ctx.send('Dev pipeline not initialized. Bot needs restart.');
    return;
  }

  if (!description.trim()) {
    await ctx.send('Provide a task description: /dev <description>');
    return;
  }

  // Limit concurrent tasks
  const activeCount = database.devTasks.countActive(groupId);
  if (activeCount >= 3) {
    await ctx.send(
      `Too many active tasks (${activeCount}). Wait for some to finish or cancel them.`
    );
    return;
  }

  try {
    const task = await pl.startTask(groupId, userId, description);
    // The pipeline sends its own notifications, so no need to reply here
  } catch (error) {
    console.error('[DEV-CMD] Failed to start task:', error);
    await ctx.send(
      `Failed to start task: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Show active dev tasks
 */
async function showStatus(
  ctx: Ctx['Command'],
  groupId: number
): Promise<void> {
  const tasks = database.devTasks.findActiveByGroupId(groupId);

  if (tasks.length === 0) {
    await ctx.send('No active dev tasks.');
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

  await ctx.send(message, { parse_mode: 'HTML' });
}

/**
 * Approve a task's design
 */
async function handleApprove(
  ctx: Ctx['Command'],
  args: string[],
  groupId: number
): Promise<void> {
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await ctx.send('Usage: /dev approve <task_id>');
    return;
  }

  const pl = getPipeline();

  if (!pl) {
    await ctx.send('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);

    if (!task) {
      await ctx.send(`Task #${taskId} not found.`);
      return;
    }

    if (task.group_id !== groupId) {
      await ctx.send(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.approveTask(taskId);
    // Pipeline sends its own notification
  } catch (error) {
    await ctx.send(
      `Failed to approve: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Reject a task
 */
async function handleReject(
  ctx: Ctx['Command'],
  args: string[],
  groupId: number
): Promise<void> {
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await ctx.send('Usage: /dev reject <task_id>');
    return;
  }

  const pl = getPipeline();

  if (!pl) {
    await ctx.send('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);

    if (!task) {
      await ctx.send(`Task #${taskId} not found.`);
      return;
    }

    if (task.group_id !== groupId) {
      await ctx.send(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.rejectTask(taskId);
  } catch (error) {
    await ctx.send(
      `Failed to reject: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Cancel a task
 */
async function handleCancel(
  ctx: Ctx['Command'],
  args: string[],
  groupId: number
): Promise<void> {
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await ctx.send('Usage: /dev cancel <task_id>');
    return;
  }

  const pl = getPipeline();

  if (!pl) {
    await ctx.send('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);

    if (!task) {
      await ctx.send(`Task #${taskId} not found.`);
      return;
    }

    if (task.group_id !== groupId) {
      await ctx.send(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.cancelTask(taskId);
  } catch (error) {
    await ctx.send(
      `Failed to cancel: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Answer clarifying questions for a task
 */
async function handleAnswer(
  ctx: Ctx['Command'],
  args: string[],
  groupId: number
): Promise<void> {
  const taskId = parseInt(args[1] || '', 10);

  if (Number.isNaN(taskId)) {
    await ctx.send('Usage: /dev answer <task_id> <your answers>');
    return;
  }

  const answer = args.slice(2).join(' ');
  if (!answer.trim()) {
    await ctx.send('Provide your answers: /dev answer <task_id> <text>');
    return;
  }

  const pl = getPipeline();
  if (!pl) {
    await ctx.send('Dev pipeline not initialized.');
    return;
  }

  try {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      await ctx.send(`Task #${taskId} not found.`);
      return;
    }
    if (task.group_id !== groupId) {
      await ctx.send(`Task #${taskId} does not belong to this group.`);
      return;
    }

    await pl.answerTask(taskId, answer);
  } catch (error) {
    await ctx.send(
      `Failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Show recently completed tasks
 */
async function showHistory(
  ctx: Ctx['Command'],
  groupId: number
): Promise<void> {
  const tasks = database.devTasks.findByGroupId(groupId, 10);

  if (tasks.length === 0) {
    await ctx.send('No dev tasks found.');
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

  await ctx.send(message, { parse_mode: 'HTML' });
}

/**
 * Handle dev task callback queries (approval buttons etc.)
 */
export async function handleDevCallback(
  ctx: any,
  params: string[],
  telegramId: number,
  bot: any
): Promise<void> {
  const [subAction, taskIdStr] = params;
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

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

  try {
    switch (subAction) {
      case 'approve':
        await pl.approveTask(taskId);
        await ctx.answerCallbackQuery({ text: 'Approved!' });
        break;

      case 'reject':
        await pl.rejectTask(taskId);
        await ctx.answerCallbackQuery({ text: 'Rejected' });
        break;

      case 'cancel':
        await pl.cancelTask(taskId);
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        break;

      default:
        await ctx.answerCallbackQuery({ text: 'Unknown action' });
    }
  } catch (error) {
    await ctx.answerCallbackQuery({
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Delete the button message
  if (messageId && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {}
  }
}
