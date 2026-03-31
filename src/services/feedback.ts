// Send user feedback to the bot admin via Telegram
import { env } from '../config/env';
import { database } from '../database';
import { escapeHtml } from '../utils/html';
import { createLogger } from '../utils/logger.ts';
import { sendDirect } from './bank/telegram-sender';

const logger = createLogger('feedback');

interface FeedbackParams {
  message: string;
  groupId: number;
  chatId: number;
  userName?: string | undefined;
}

interface FeedbackResult {
  success: boolean;
  error?: string;
}

/**
 * Send feedback/bug report to the bot admin.
 * Shared by /feedback command and send_feedback AI tool.
 */
export async function sendFeedback(params: FeedbackParams): Promise<FeedbackResult> {
  const { message, groupId, chatId, userName } = params;

  if (!message.trim()) {
    return { success: false, error: 'Сообщение не может быть пустым.' };
  }

  const adminChatId = env.BOT_ADMIN_CHAT_ID;
  if (!adminChatId) {
    logger.warn('BOT_ADMIN_CHAT_ID not configured, feedback not sent');
    return { success: false, error: 'Фидбек не настроен.' };
  }

  const group = database.groups.findById(groupId);
  const groupLabel = group ? `<b>${group.telegram_group_id}</b>` : String(chatId);
  const safeUserName = userName ? escapeHtml(userName) : undefined;
  const userLabel = safeUserName ? ` от <b>${safeUserName}</b>` : '';
  const safeMessage = escapeHtml(message);
  const text = `💬 Фидбек из группы ${groupLabel}${userLabel}:\n\n${safeMessage}`;

  await sendDirect(adminChatId, text);
  logger.info({ groupId, chatId }, 'Feedback sent to admin');
  return { success: true };
}
