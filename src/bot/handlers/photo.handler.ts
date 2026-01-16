import type { Ctx } from '../types';
import { database } from '../../database';

/**
 * Handle photo messages (add to processing queue)
 */
export async function handlePhotoMessage(ctx: Ctx['Message']): Promise<void> {
  const telegramId = ctx.from.id;
  const messageId = ctx.id;
  const photos = ctx.photo;

  // Get thread ID from payload (for forum topics)
  const threadId = (ctx as any).payload?.message_thread_id;

  console.log('[PHOTO] Received photo:', {
    messageId,
    threadId,
    chatType: ctx.chat?.type,
  });

  if (!telegramId || !messageId || !photos || photos.length === 0) {
    console.log('[PHOTO] Ignoring: missing telegramId, messageId or photos');
    return;
  }

  // Check if message is from group/supergroup
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  if (!isGroup) {
    console.log('[PHOTO] Ignoring photo from private chat');
    await ctx.send('❌ Отправка чеков работает только в группах.');
    return;
  }

  const chatId = ctx.chat.id;

  // Get group from database
  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    console.log(`[PHOTO] Group not found: ${chatId}`);
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  // Check topic restriction
  if (group.active_topic_id && threadId !== group.active_topic_id) {
    console.log(`[PHOTO] Ignoring: photo from topic ${threadId || 'general'}, bot listens to topic ${group.active_topic_id}`);
    return;
  }

  // Get or create user
  let user = database.users.findByTelegramId(telegramId);
  if (!user) {
    user = database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  }

  // Get the largest photo (last element in array)
  // ctx.photo is an array of different sizes of the same image
  const largestPhoto = photos[photos.length - 1];

  if (!largestPhoto) {
    console.log('[PHOTO] No photos found in array');
    return;
  }

  // Add only the largest photo to processing queue
  const queueItem = database.photoQueue.create({
    group_id: group.id,
    user_id: user.id,
    message_id: messageId,
    message_thread_id: threadId,
    file_id: largestPhoto.fileId,
    status: 'pending',
  });

  console.log(`[PHOTO] Added photo to queue #${queueItem.id}: ${largestPhoto.width}x${largestPhoto.height} (${largestPhoto.fileSize} bytes) from user ${telegramId} in group ${chatId}, thread_id=${threadId || 'none'}`);

  // Send confirmation
  await ctx.send(`📸 Фото добавлено в очередь обработки`);

  // Start background processing
  // This will be triggered by the background processor
}
