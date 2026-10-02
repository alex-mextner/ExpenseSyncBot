import { database } from '../../database';
import { sendMessage } from '../../services/bank/telegram-sender';
import type { TranscriptionService } from '../../services/voice/transcription-service';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { handleAskQuestion } from '../commands/ask';
import type { BotInstance, Ctx } from '../types';
import { sendPrivateChatRedirect } from './message.handler';

const logger = createLogger('voice.handler');

type Transcriber = Pick<TranscriptionService, 'transcribe'>;

export interface VoiceHandlerDeps {
  botToken: string;
  transcriptionService: Transcriber | null;
  downloadVoiceBuffer?: (bot: BotInstance, botToken: string, fileId: string) => Promise<Buffer>;
}

export async function downloadTelegramVoice(
  bot: BotInstance,
  botToken: string,
  fileId: string,
): Promise<Buffer> {
  const file = await bot.api.getFile({ file_id: fileId });
  if (!file.file_path) throw new Error('Telegram voice file path not found');

  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram voice: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function transcribeAndShow(
  ctx: Ctx['Message'],
  bot: BotInstance,
  deps: VoiceHandlerDeps,
): Promise<string | null> {
  if (!deps.transcriptionService) {
    await sendMessage('🎤 Голосовые сейчас недоступны: сервис распознавания не настроен.');
    return null;
  }

  try {
    const voice = ctx.voice;
    if (!voice) return null;
    const download = deps.downloadVoiceBuffer ?? downloadTelegramVoice;
    const audio = await download(bot, deps.botToken, voice.fileId);
    const transcript = await deps.transcriptionService.transcribe(audio);

    if (!transcript) {
      await sendMessage('🎤 Речь не удалось распознать. Попробуй ещё раз или напиши текстом.');
      return null;
    }

    await sendMessage(`<blockquote expandable>🎤 <i>${escapeHtml(transcript)}</i></blockquote>`);
    return transcript;
  } catch (error) {
    logger.warn({ err: error, userId: ctx.from.id }, 'Voice message processing failed');
    await sendMessage(
      '🎤 Не получилось расшифровать голосовое. Попробуй ещё раз или напиши текстом.',
    );
    return null;
  }
}

export async function handleVoiceMessage(
  ctx: Ctx['Message'],
  bot: BotInstance,
  deps: VoiceHandlerDeps,
): Promise<boolean> {
  if (!ctx.voice) return false;

  if (ctx.chat?.type === 'private') {
    await transcribeAndShow(ctx, bot, deps);
    await sendPrivateChatRedirect(ctx.from.id);
    return true;
  }

  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (!isGroup) return true;

  const group = database.groups.findByTelegramGroupId(ctx.chat.id);
  if (!group) {
    await sendMessage('Группа не настроена. Для настройки используй команду /connect');
    return true;
  }

  const messageThreadId = ctx.update?.message?.message_thread_id;
  if (group.active_topic_id && messageThreadId !== group.active_topic_id) {
    logger.info(
      {
        groupId: group.id,
        messageThreadId: messageThreadId ?? null,
        activeTopicId: group.active_topic_id,
      },
      'Ignoring voice message outside configured topic',
    );
    return true;
  }

  if (!database.groups.hasCompletedSetup(ctx.chat.id)) {
    await sendMessage('Заверши настройку группы: /connect');
    return true;
  }

  const transcript = await transcribeAndShow(ctx, bot, deps);
  if (!transcript) return true;

  await handleAskQuestion(ctx, transcript, bot, false, 'voice_message');
  return true;
}
