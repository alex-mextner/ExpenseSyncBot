/**
 * Handles @botname questions in groups (OpenAI SDK agent) and smart financial advice.
 */
import { format } from 'date-fns';
import type { Bot } from 'gramio';
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import type { Group, User } from '../../database/types';
import { AgentError } from '../../errors';
import { validateAdvice } from '../../services/ai/advice-validator';
import { ExpenseBotAgent } from '../../services/ai/agent';
import { stripThinkingTags } from '../../services/ai/completion';
import type { AgentContext } from '../../services/ai/types';
import { checkSmartTriggers, recordAdviceSent } from '../../services/analytics/advice-triggers';
import { computeOverallSeverity } from '../../services/analytics/formatters';
import { spendingAnalytics } from '../../services/analytics/spending-analytics';
import type { AdviceTier, FinancialSnapshot, TriggerResult } from '../../services/analytics/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
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

const TIER_CONFIGS: Record<AdviceTier, { emoji: string; title: string }> = {
  quick: { emoji: '💡', title: '<b>Инсайт</b>' },
  alert: { emoji: '⚠️', title: '<b>Финансовый алерт</b>' },
  deep: { emoji: '📊', title: '<b>Финансовый обзор</b>' },
};

/**
 * Tiered advice system — all tiers use ExpenseBotAgent with full tool access.
 * Agent fetches actual data via tools, then a validation pass checks for errors.
 * Source data summary is appended as a collapsible blockquote.
 */
async function sendSmartAdvice(
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
    const group = database.groups.findById(groupId);
    const displayCurrency = group?.default_currency ?? BASE_CURRENCY;

    logger.info(`[ADVICE] Generating ${tier} advice (severity: ${severity}) for group ${groupId}`);

    // Build agent context (no real chatId/userId — advice is system-initiated)
    const agentCtx: AgentContext = {
      groupId,
      userId: 0,
      chatId: group?.telegram_group_id ?? 0,
      userName: 'system',
      userFullName: 'Smart Advice',
      customPrompt: group?.custom_prompt ?? null,
      telegramGroupId: group?.telegram_group_id ?? 0,
      isMention: true, // prevent [SKIP]
    };

    const agent = new ExpenseBotAgent(env.ANTHROPIC_API_KEY, agentCtx);

    // Build tier-specific prompt for the agent
    const advicePrompt = buildAdvicePrompt(tier, severity, trigger, groupId, displayCurrency);

    // Run agent in batch mode — no streaming, full tool access
    let advice = stripThinkingTags(await agent.runBatch(advicePrompt));

    if (!advice || advice.length < 10) {
      logger.info('[ADVICE] Agent produced empty/short response, skipping');
      return;
    }

    // Validation pass — check for hallucinations and errors
    const validation = await validateAdvice(env.ANTHROPIC_API_KEY, {
      tier,
      trigger,
      advice,
    });

    if (!validation.approved) {
      logger.info(`[ADVICE] Validation REJECTED: ${validation.reason}`);

      // Retry with validation feedback
      const retryPrompt = `${advicePrompt}\n\n[SYSTEM] Твой предыдущий ответ был отклонён проверкой. Причина: ${validation.reason}\nИсправь ошибки и перепиши ответ.`;
      advice = stripThinkingTags(await agent.runBatch(retryPrompt));

      if (!advice || advice.length < 10) {
        logger.info('[ADVICE] Agent retry produced empty response, skipping');
        return;
      }
    } else {
      logger.info('[ADVICE] Validation APPROVED');
    }

    // Sanitize HTML (advice is already stripped of thinking tags above)
    const sanitizedAdvice = sanitizeHtmlForTelegram(advice);
    if (!sanitizedAdvice || sanitizedAdvice.length < 10) return;

    // Build source data blockquote
    const sourceBlock = buildSourceDataBlock(snapshot, trigger, displayCurrency);

    // Compose final message: header + advice + source data
    const tierConfig = TIER_CONFIGS[tier];
    const header = `${tierConfig.emoji} ${tierConfig.title}`;
    const message = `${header}\n\n${sanitizedAdvice}${sourceBlock}`;

    try {
      await sendMessage(message);
    } catch (sendErr: unknown) {
      if (sendErr instanceof Error && sendErr.message.includes("can't parse entities")) {
        logger.error('[ADVICE] HTML parse error, falling back to plain text');
        await sendMessage(
          `${tierConfig.emoji} ${tierConfig.title.replace(/<[^>]+>/g, '')}\n\n${stripAllHtml(advice)}`,
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
      advice_text: advice,
    });

    logger.info(`[ADVICE] Sent ${tier} advice for group ${groupId}, topic: ${trigger.topic}`);
  } catch (error) {
    logger.error({ err: error }, '[ADVICE] Failed to generate smart advice');
    // Silently fail - advice is not critical
  }
}

/**
 * Build prompt for the advice agent with tier-specific instructions.
 * The agent will use tools to fetch actual data — no data dump in the prompt.
 */
function buildAdvicePrompt(
  tier: AdviceTier,
  severity: string,
  trigger: TriggerResult,
  groupId: number,
  displayCurrency: CurrencyCode,
): string {
  const recentTopics = database.adviceLogs.getRecentTopics(groupId, 5);
  const antiRepetition =
    recentTopics.length > 0
      ? `\nПоследние ${recentTopics.length} советов были на темы: ${JSON.stringify(recentTopics)}\nНЕ повторяй эти темы. Найди новый ракурс.\n`
      : '';

  const outputRules = `
ПРАВИЛА:
- Это проактивное сообщение от бота в группу — пиши от своего лица, не обращайся к конкретному пользователю.
- Используй ТОЛЬКО HTML теги: <b>, <i>, <code>. НЕ Markdown (**, *, \`, ##).
- НЕ используй <blockquote> — он зарезервирован для системных элементов.
- НЕ выдумывай ссылки и URL!
- Все суммы показывай в ${displayCurrency}.
- Каждое утверждение ДОЛЖНО быть подкреплено конкретной цифрой из инструментов.
- ОБЯЗАТЕЛЬНО используй инструменты (get_expenses, get_budgets, get_technical_analysis) для получения актуальных данных. НЕ отвечай по памяти.`;

  if (tier === 'quick') {
    return `Ты — финансовый аналитик. Дай краткий финансовый инсайт для группы.

УРОВЕНЬ СИТУАЦИИ: ${severity}
ТРИГГЕР: ${trigger.type} — ${JSON.stringify(trigger.data)}
${severity === 'good' ? 'Похвали и дай совет по оптимизации.' : 'Начни с самого важного наблюдения.'}
${antiRepetition}
${outputRules}

Используй инструменты, чтобы получить актуальные данные. Затем напиши ОДИН конкретный инсайт — 2-4 предложения с числами и конкретным действием.`;
  }

  if (tier === 'alert') {
    return `Ты — финансовый аналитик. Обнаружена ситуация, требующая внимания.

УРОВЕНЬ СИТУАЦИИ: ${severity}
ТРИГГЕР: ${trigger.type} — ${JSON.stringify(trigger.data)}
${antiRepetition}
${outputRules}

Используй инструменты для получения актуальных данных (расходы, бюджеты, теханализ).
Опиши проблему с конкретными числами. Предложи 1-2 действия. 3-5 предложений.`;
  }

  // Tier 3: deep
  return `Ты — финансовый аналитик. Сделай полный финансовый обзор.

УРОВЕНЬ СИТУАЦИИ: ${severity}
${antiRepetition}
${outputRules}

Используй ВСЕ доступные инструменты для получения полных данных:
- get_expenses (сводка за текущий и прошлый месяц)
- get_budgets (текущие бюджеты)
- get_technical_analysis (прогнозы и тренды)
- get_bank_balances (если есть подключённые банки)

Структура ответа:
1. <b>Общая картина</b> — расходы vs бюджет
2. <b>Тренды</b> — что растёт, что падает
3. <b>Проблемные категории</b> — аномалии, превышения
4. <b>Прогноз</b> — ожидаемые расходы к концу месяца
5. <b>Рекомендации</b> — максимум 3, конкретные, с числами`;
}

/**
 * Build collapsible blockquote with source data for transparency
 */
function buildSourceDataBlock(
  snapshot: FinancialSnapshot,
  trigger: TriggerResult,
  displayCurrency: CurrencyCode,
): string {
  const cv = (eur: number) => convertCurrency(eur, BASE_CURRENCY, displayCurrency);
  const fmt = (eur: number) => formatAmount(cv(eur), displayCurrency);
  const lines: string[] = [];

  // Trigger info
  lines.push(`Триггер: ${trigger.type} (${trigger.tier})`);

  // Budget burn rates (top 3 most concerning)
  const criticalBudgets = snapshot.burnRates
    .filter((br) => br.status !== 'on_track')
    .sort((a, b) => b.projected_total / b.budget_limit - a.projected_total / a.budget_limit)
    .slice(0, 3);
  if (criticalBudgets.length > 0) {
    for (const br of criticalBudgets) {
      const pct = br.budget_limit > 0 ? Math.round((br.spent / br.budget_limit) * 100) : 0;
      lines.push(
        `${br.category}: ${formatAmount(br.spent, br.currency as CurrencyCode)}/${formatAmount(br.budget_limit, br.currency as CurrencyCode)} (${pct}%)`,
      );
    }
  }

  // Anomalies
  if (snapshot.anomalies.length > 0) {
    for (const a of snapshot.anomalies.slice(0, 3)) {
      lines.push(`${a.category}: ${fmt(a.current_month_total)} (норма ~${fmt(a.avg_3_month)})`);
    }
  }

  // Monthly projection
  if (snapshot.projection) {
    lines.push(`Прогноз на месяц: ${fmt(snapshot.projection.projected_total)}`);
  }

  // TA forecasts for key categories
  if (snapshot.technicalAnalysis) {
    const taCats = snapshot.technicalAnalysis.categories
      .filter(
        (c) =>
          c.anomaly.isAnomaly ||
          c.trend.direction === 'rising' ||
          c.currentMonthSpent > c.forecasts.ensemble * 0.8,
      )
      .slice(0, 3);
    for (const cat of taCats) {
      const trendArrow =
        cat.trend.direction === 'rising' ? '↑' : cat.trend.direction === 'falling' ? '↓' : '→';
      lines.push(
        `${cat.category}: текущий ${Math.round(cv(cat.currentMonthSpent))}, прогноз ~${Math.round(cv(cat.forecasts.ensemble))} ${trendArrow}`,
      );
    }
  }

  if (lines.length === 0) return '';

  return `\n\n<blockquote expandable>📋 <b>Данные анализа</b>\n${lines.join('\n')}</blockquote>`;
}
