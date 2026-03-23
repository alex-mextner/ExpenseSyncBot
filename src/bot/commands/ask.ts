/**
 * Handles @botname questions in groups (Anthropic agent) and smart financial advice.
 */
import Anthropic from '@anthropic-ai/sdk';
import { format } from 'date-fns';
import type { Bot } from 'gramio';
import { env } from '../../config/env';
import { database } from '../../database';
import type { Group, User } from '../../database/types';
import { AI_BASE_URL, AI_MODEL, ExpenseBotAgent } from '../../services/ai/agent';
import type { AgentContext } from '../../services/ai/types';
import { checkSmartTriggers, recordAdviceSent } from '../../services/analytics/advice-triggers';
import {
  computeOverallSeverity,
  formatSnapshotForPrompt,
} from '../../services/analytics/formatters';
import { spendingAnalytics } from '../../services/analytics/spending-analytics';
import type { AdviceTier, FinancialSnapshot, TriggerResult } from '../../services/analytics/types';
import { sanitizeHtmlForTelegram, stripAllHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import type { Ctx } from '../types';

const logger = createLogger('ask');

/**
 * Handle questions to the bot via @botname question
 */
export async function handleAskQuestion(
  ctx: Ctx['Message'],
  question: string,
  bot: Bot,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
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
    await ctx.send('❌ AI не настроен. Нужен ANTHROPIC_API_KEY.');
    return;
  }

  await handleAskWithAnthropic(ctx, question, bot, group, user, userName, userFullName);
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

    // Save only the final text response to chat history (not tool_use rounds)
    database.chatMessages.create({
      group_id: group.id,
      user_id: user.id,
      role: 'assistant',
      content: finalResponse,
    });

    // Prune old messages (keep last 50)
    database.chatMessages.pruneOldMessages(group.id, 50);

    // Maybe send daily advice (20% probability)
    await maybeSmartAdvice(ctx, group.id);
  } catch (error) {
    logger.error({ err: error }, '[ASK] Anthropic agent error');
    await ctx.send('❌ Ошибка при обработке вопроса. Попробуй еще раз.');
  }
}

/**
 * /advice command handler - request deep financial analysis (Tier 3)
 */
export async function handleAdviceCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  // Deep analysis: Tier 3, manual trigger
  const snapshot = spendingAnalytics.getFinancialSnapshot(group.id);
  const trigger: TriggerResult = {
    type: 'manual',
    tier: 'deep',
    topic: `deep_analysis:${format(new Date(), 'yyyy-MM-dd')}`,
    data: {},
  };

  await sendSmartAdvice(ctx, group.id, trigger, snapshot);
}

/**
 * Check smart triggers and maybe send advice
 */
export async function maybeSmartAdvice(ctx: Ctx['Message'], groupId: number): Promise<void> {
  try {
    const snapshot = spendingAnalytics.getFinancialSnapshot(groupId);
    const trigger = checkSmartTriggers(groupId, snapshot);

    if (!trigger) return;

    logger.info(
      `[ADVICE] Smart trigger fired: ${trigger.type} (tier: ${trigger.tier}) for group ${groupId}`,
    );
    await sendSmartAdvice(ctx, groupId, trigger, snapshot);
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
  ctx: Ctx['Message'],
  groupId: number,
  trigger: TriggerResult,
  snapshot: FinancialSnapshot,
): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) {
    logger.info('[ADVICE] No ANTHROPIC_API_KEY, skipping advice');
    return;
  }

  try {
    const tier = trigger.tier;
    const severity = computeOverallSeverity(snapshot);
    const snapshotText = formatSnapshotForPrompt(snapshot);

    // Get recent advice topics for anti-repetition
    const recentTopics = database.adviceLogs.getRecentTopics(groupId, 5);

    // Get group for custom prompt
    const group = database.groups.findById(groupId);

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

    const anthropic = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: AI_BASE_URL,
    });
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: tierConfig.max_tokens,
      messages: [{ role: 'user', content: fullPrompt }],
    });
    let advice = '';
    for (const block of response.content) {
      if (block.type === 'text') advice += block.text;
    }

    if (!advice) return;

    // Clean up think tags
    const cleanAdvice = processThinkTagsForAdvice(advice);
    const sanitizedAdvice = sanitizeHtmlForTelegram(cleanAdvice);
    if (!sanitizedAdvice || sanitizedAdvice.length < 10) return;

    // Send with tier-appropriate header
    const header = `${tierConfig.emoji} ${tierConfig.title}`;
    const message = `\n\n${header}\n\n${sanitizedAdvice}`;

    try {
      await ctx.send(message, { parse_mode: 'HTML' });
    } catch (sendErr: unknown) {
      if (sendErr instanceof Error && sendErr.message.includes("can't parse entities")) {
        logger.error('[ADVICE] HTML parse error, falling back to plain text');
        await ctx.send(
          `${tierConfig.emoji} ${tierConfig.title.replace(/<[^>]+>/g, '')}\n\n${stripAllHtml(cleanAdvice)}`,
        );
      } else {
        throw sendErr;
      }
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
