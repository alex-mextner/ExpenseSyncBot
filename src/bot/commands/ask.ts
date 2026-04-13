/**
 * Handles @botname questions in groups (OpenAI SDK agent) and smart financial advice.
 */
import { format } from 'date-fns';
import type { Bot } from 'gramio';
import { BASE_CURRENCY } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import type { Group, User } from '../../database/types';
import { AgentError } from '../../errors';
import { ExpenseBotAgent } from '../../services/ai/agent';
import { aiStreamRound, stripThinkingTags } from '../../services/ai/streaming';
import type { AgentContext } from '../../services/ai/types';
import { checkSmartTriggers, recordAdviceSent } from '../../services/analytics/advice-triggers';
import {
  computeOverallSeverity,
  formatSnapshotForPrompt,
} from '../../services/analytics/formatters';
import { spendingAnalytics } from '../../services/analytics/spending-analytics';
import type { AdviceTier, FinancialSnapshot, TriggerResult } from '../../services/analytics/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { StatusWriter } from '../../services/receipt/status-writer';
import { sanitizeHtmlForTelegram, stripAllHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import type { Ctx } from '../types';

const logger = createLogger('ask');

/**
 * Hard cap on how long the advice stream may run before we abort it.
 * Without this, a provider stream that stalls mid-flight leaves the user
 * staring at a half-written status message forever (no client-side timeout
 * otherwise fires — the OpenAI SDK `timeout` only covers request setup).
 * 60s comfortably covers the deep tier's 3k token budget.
 */
const ADVICE_TIMEOUT_MS = 60_000;

/**
 * Handle questions to the bot via @botname question
 */
export async function handleAskQuestion(
  ctx: Ctx['Message'],
  question: string,
  bot: Bot,
  isMention = false,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await sendMessage('❌ Не удалось определить чат');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await sendMessage('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await sendMessage('❌ Группа не настроена. Используй /connect');
    return;
  }

  // Check topic restriction
  const messageThreadId = ctx.update?.message?.message_thread_id;
  if (group.active_topic_id && messageThreadId !== group.active_topic_id) {
    logger.info(
      `[ASK] Ignoring: question from topic ${messageThreadId || 'general'}, bot listens to topic ${group.active_topic_id}`,
    );
    return;
  }

  // Get user for storing chat history
  const userId = ctx.from.id;
  let user = database.users.findByTelegramId(userId);
  if (!user) {
    user = database.users.create({
      telegram_id: userId,
      group_id: group.id,
    });
  }

  // Get user info
  const userName = ctx.from.username || ctx.from.firstName || 'User';
  const userFirstName = ctx.from.firstName || '';
  const userLastName = ctx.from.lastName || '';
  const userFullName = [userFirstName, userLastName].filter(Boolean).join(' ');

  // Save user question to chat history
  database.chatMessages.create({
    group_id: group.id,
    user_id: user.id,
    role: 'user',
    content: `${userName}: ${question}`,
  });

  if (!env.ANTHROPIC_API_KEY) {
    await sendMessage('❌ AI не настроен. Нужен ANTHROPIC_API_KEY.');
    return;
  }

  await handleAskWithAnthropic(ctx, question, bot, group, user, userName, userFullName, isMention);
}

/**
 * Handle question using Anthropic Claude agent with tool calling
 */
async function handleAskWithAnthropic(
  ctx: Ctx['Message'],
  question: string,
  bot: Bot,
  group: Group,
  user: User,
  userName: string,
  userFullName: string,
  isMention = false,
): Promise<void> {
  const chatId = ctx.chat?.id;

  const agentCtx: AgentContext = {
    groupId: group.id,
    userId: user.id,
    chatId,
    userName,
    userFullName,
    customPrompt: group.custom_prompt,
    telegramGroupId: group.telegram_group_id,
    sendPhoto: async (imageBuffer) => {
      // Runs outside topic middleware's AsyncLocalStorage scope — must pass message_thread_id explicitly.
      const threadId = ctx.update?.message?.message_thread_id;
      const file = new File([imageBuffer], 'table.png', { type: 'image/png' });
      await bot.api.sendPhoto({
        chat_id: chatId,
        photo: file,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      });
    },
    isMention,
    isForumWithoutTopic: ctx.chat?.isForum === true && group.active_topic_id == null,
  };

  // Get recent chat history (last 10 messages / 5 pairs)
  const recentMessages = database.chatMessages.getRecentMessages(group.id, 10);
  // Exclude the current question (just saved above)
  const historyMessages = recentMessages.slice(0, -1);

  try {
    // Show "typing" status and placeholder message
    await bot.api.sendChatAction({
      chat_id: chatId,
      action: 'typing',
    });

    const agent = new ExpenseBotAgent(env.ANTHROPIC_API_KEY, agentCtx);

    const finalResponse = await agent.run(`${userName}: ${question}`, historyMessages, bot);

    // Empty response means the agent chose to stay silent ([SKIP] signal)
    if (!finalResponse) return;

    // Save only the final text response to chat history (not tool_use rounds)
    database.chatMessages.create({
      group_id: group.id,
      user_id: user.id,
      role: 'assistant',
      content: finalResponse,
    });

    // Prune old messages (keep last 50)
    database.chatMessages.pruneOldMessages(group.id, 50);

    // Maybe send smart advice after successful response
    await maybeSmartAdvice(group.id);
  } catch (error) {
    if (error instanceof AgentError) {
      // Agent already sent the error message to the user and cleaned up.
      // Don't save error to chat history, don't trigger advice.
      logger.info(`[ASK] Agent error (already reported to user): ${error.userMessage}`);
      return;
    }
    logger.error({ err: error }, '[ASK] Anthropic agent error');
    await sendMessage('❌ Ошибка при обработке вопроса. Попробуй еще раз.');
  }
}

/**
 * /advice command handler - request deep financial analysis (Tier 3)
 */
export async function handleAdviceCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  void ctx;
  // Deep analysis: Tier 3, manual trigger
  const snapshot = spendingAnalytics.getFinancialSnapshot(group.id);
  const trigger: TriggerResult = {
    type: 'manual',
    tier: 'deep',
    topic: `deep_analysis:${format(new Date(), 'yyyy-MM-dd')}`,
    data: {},
  };

  await sendSmartAdvice(group.id, trigger, snapshot);
}

/**
 * Check smart triggers and maybe send advice
 */
export async function maybeSmartAdvice(groupId: number): Promise<void> {
  try {
    const snapshot = spendingAnalytics.getFinancialSnapshot(groupId);
    const trigger = checkSmartTriggers(groupId, snapshot);

    if (!trigger) return;

    logger.info(
      `[ADVICE] Smart trigger fired: ${trigger.type} (tier: ${trigger.tier}) for group ${groupId}`,
    );
    await sendSmartAdvice(groupId, trigger, snapshot);
  } catch (error) {
    logger.error({ err: error }, '[ADVICE] Error in smart advice check');
  }
}

/**
 * Strip <think>...</think> blocks entirely from advice text.
 * Unlike processThinkTags (which converts to blockquote), this removes thinking completely.
 */
function processThinkTagsForAdvice(text: string): string {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '<i>Бот думает...</i>\n\n');
  text = text.replace(/<think>[\s\S]*$/, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Tiered advice system:
 *   Tier 1 (quick): 500 max_tokens, temp 0.5, brief insight
 *   Tier 2 (alert): 1000 max_tokens, temp 0.5, budget warning
 *   Tier 3 (deep):  3000 max_tokens, temp 0.6, comprehensive analysis
 */
async function sendSmartAdvice(
  groupId: number,
  trigger: TriggerResult,
  snapshot: FinancialSnapshot,
): Promise<void> {
  try {
    const tier = trigger.tier;
    const severity = computeOverallSeverity(snapshot);

    // Get group for custom prompt and display currency
    const group = database.groups.findById(groupId);
    const snapshotText = formatSnapshotForPrompt(
      snapshot,
      groupId,
      group?.default_currency ?? BASE_CURRENCY,
    );

    // Get recent advice topics for anti-repetition
    const recentTopics = database.adviceLogs.getRecentTopics(groupId, 5);

    // Build tier-specific prompt
    const advicePrompt = buildTieredPrompt(tier, severity, snapshotText, recentTopics, trigger);

    // Add custom prompt if set
    let fullPrompt = advicePrompt;
    if (group?.custom_prompt) {
      fullPrompt += `\n\n=== КАСТОМНЫЕ ИНСТРУКЦИИ ГРУППЫ ===\n${group.custom_prompt}`;
    }

    // Tier-specific parameters
    const tierConfig = TIER_CONFIGS[tier];

    logger.info(`[ADVICE] Generating ${tier} advice (severity: ${severity}) for group ${groupId}`);

    // Live-stream the advice into an editable status message so the user sees
    // the long-form output building up in real time (3k tokens = 15-30s wait).
    const header = `${tierConfig.emoji} ${tierConfig.title}`;
    const writer = new StatusWriter({ header, mode: 'plain' });

    let rawAdvice: string;
    try {
      const result = await aiStreamRound(
        {
          messages: [{ role: 'user', content: fullPrompt }],
          maxTokens: tierConfig.max_tokens,
          temperature: tierConfig.temperature,
          chain: 'smart',
          signal: AbortSignal.timeout(ADVICE_TIMEOUT_MS),
        },
        { onTextDelta: (delta) => writer.append(delta) },
      );
      rawAdvice = result.text;
    } catch (err) {
      // Preserve whatever was already streamed and pin an error indicator on
      // the end, so the user doesn't see the message silently vanish after the
      // stream aborts (timeout, provider error, mid-stream hang).
      await writer.finalizeError('<i>❌ Генерация прервана, попробуй ещё раз</i>');
      throw err;
    }

    if (!rawAdvice) {
      await writer.close();
      return;
    }

    // Clean up think tags
    const cleanAdvice = processThinkTagsForAdvice(stripThinkingTags(rawAdvice));
    const sanitizedAdvice = sanitizeHtmlForTelegram(cleanAdvice);
    if (!sanitizedAdvice || sanitizedAdvice.length < 10) {
      await writer.close();
      return;
    }

    // Replace the streamed live output with the final cleaned version
    // (strips <think> tags, finalizes HTML). Single edit, no duplicate message.
    const finalMessage = `${header}\n\n${sanitizedAdvice}`;
    try {
      await writer.finalize(finalMessage);
    } catch (finalErr: unknown) {
      // Edit can fail if the sanitized output differs structurally from what
      // was streamed — fall back to a fresh plain-text message.
      logger.error({ err: finalErr }, '[ADVICE] Finalize edit failed, sending plain fallback');
      await writer.close();
      await sendMessage(
        `${tierConfig.emoji} ${tierConfig.title.replace(/<[^>]+>/g, '')}\n\n${stripAllHtml(cleanAdvice)}`,
      );
    }

    // Record advice in log and update cooldown
    recordAdviceSent(groupId, tier);
    database.adviceLogs.create({
      group_id: groupId,
      tier,
      trigger_type: trigger.type,
      trigger_data: JSON.stringify(trigger.data),
      topic: trigger.topic,
      advice_text: cleanAdvice,
    });

    logger.info(`[ADVICE] Sent ${tier} advice for group ${groupId}, topic: ${trigger.topic}`);
  } catch (error) {
    logger.error({ err: error }, '[ADVICE] Failed to generate smart advice');
    // Silently fail - advice is not critical
  }
}

const TIER_CONFIGS: Record<
  AdviceTier,
  { max_tokens: number; temperature: number; emoji: string; title: string }
> = {
  quick: { max_tokens: 500, temperature: 0.5, emoji: '💡', title: '<b>Инсайт</b>' },
  alert: { max_tokens: 1000, temperature: 0.5, emoji: '⚠️', title: '<b>Финансовый алерт</b>' },
  deep: { max_tokens: 3000, temperature: 0.6, emoji: '📊', title: '<b>Финансовый обзор</b>' },
};

/**
 * Build tier-specific prompt with financial data and anti-repetition
 */
function buildTieredPrompt(
  tier: AdviceTier,
  severity: string,
  snapshotText: string,
  recentTopics: string[],
  trigger: TriggerResult,
): string {
  const antiRepetition =
    recentTopics.length > 0
      ? `\nПоследние ${recentTopics.length} советов были на темы: ${JSON.stringify(recentTopics)}\nНЕ повторяй эти темы. Найди новый ракурс.\n`
      : '';

  const outputRules = `
ПРАВИЛА ВЫВОДА:
- Используй ТОЛЬКО HTML теги: <b>, <i>, <code>, <blockquote>. НЕ Markdown (**, *, \`, ##).
- НЕ выдумывай ссылки! Не используй <a> без реальных URL.
- Когда упоминаешь аномалию (Nx), ВСЕГДА объясняй простым языком, например: "4.5x — траты в 4.5 раза выше среднего за предыдущие 3 месяца".`;

  if (tier === 'quick') {
    return `Ты — финансовый аналитик. Не философ. Не мотиватор. Аналитик.
Каждое утверждение ДОЛЖНО содержать конкретную цифру из данных.

УРОВЕНЬ СИТУАЦИИ: ${severity}
${severity === 'good' ? 'Похвали и дай совет по оптимизации.' : 'Начни с самого важного наблюдения.'}

ДАННЫЕ:
${snapshotText}
${antiRepetition}
${outputRules}

Дай ОДИН конкретный финансовый инсайт на основе данных выше.
Не философствуй. Назови конкретную цифру и конкретное действие.
Максимум 1-2 предложения.`;
  }

  if (tier === 'alert') {
    return `Ты — финансовый аналитик. Не философ. Не мотиватор. Аналитик.
Каждое утверждение ДОЛЖНО содержать конкретную цифру из данных.

УРОВЕНЬ СИТУАЦИИ: ${severity}
ТРИГГЕР: ${trigger.type} — ${JSON.stringify(trigger.data)}

ДАННЫЕ:
${snapshotText}
${antiRepetition}
${outputRules}

Обнаружена финансовая ситуация, требующая внимания.
Опиши проблему с конкретными числами. Предложи 1-2 действия.
3-5 предложений максимум.`;
  }

  // Tier 3: deep
  return `Ты — финансовый аналитик. Не философ. Не мотиватор. Аналитик.
Каждое утверждение ДОЛЖНО содержать конкретную цифру из данных.

УРОВЕНЬ СИТУАЦИИ: ${severity}

ПРАВИЛА АНАЛИЗА:
- Burn rate > 100% к текущему дню месяца = перерасход
- Anomaly > 2x среднего = нужен alert
- Budget utilization > 90% = concern, > 100% = critical
- Week-over-week рост > 20% = тренд вверх

ДАННЫЕ:
${snapshotText}
${antiRepetition}
${outputRules}

Сделай полный финансовый обзор на основе данных.
Структура:
1. Общая картина (total spend vs budget, budget utilization)
2. Тренды (week/month comparison)
3. Проблемные категории (anomalies, exceeded budgets)
4. Прогноз на конец месяца
5. Рекомендации (max 3, конкретные, с числами)`;
}
