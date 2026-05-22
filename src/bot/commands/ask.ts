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
import { validateAdvice } from '../../services/ai/advice-validator';
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
 * Per-tier: deep (3k tokens) needs more time, especially with thinking models.
 */
const ADVICE_TIMEOUT_MS: Record<AdviceTier, number> = {
  quick: 60_000,
  alert: 90_000,
  deep: 120_000,
};

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
 * Check smart triggers and dispatch:
 *   budget_threshold:exceeded → always send factual message to chat + write advice_log
 *   other trigger, AUTO_ADVICE_ENABLED=true  → send AI advice via sendSmartAdvice
 *   other trigger, AUTO_ADVICE_ENABLED=false → log context for analysis only
 *
 * Once-per-month dedup for budget_exceeded: checkSmartTriggers calls hasTopicThisMonth
 * before returning the trigger, so if we wrote an advice_log entry this month it returns
 * null before we even get here.
 */
export async function maybeSmartAdvice(groupId: number): Promise<void> {
  try {
    const snapshot = spendingAnalytics.getFinancialSnapshot(groupId);
    const trigger = checkSmartTriggers(groupId, snapshot);
    if (!trigger) return;

    // Other triggers: send to chat when flag is on.
    if (env.AUTO_ADVICE_ENABLED) {
      await sendSmartAdvice(groupId, trigger, snapshot);
      recordAdviceSent(groupId, trigger.tier);
      return;
    }

    // Flag is off: log trigger context for offline analysis.
    // recordAdviceSent sets in-memory cooldown so the same tier doesn't re-fire
    // on every expense within the cooldown window (4h quick / 1h alert).
    // advice_log entry activates hasTopicThisMonth dedup for monthly triggers.
    const group = database.groups.findById(groupId);
    const snapshotText = formatSnapshotForPrompt(
      snapshot,
      groupId,
      group?.default_currency ?? BASE_CURRENCY,
    );
    logger.info(
      {
        groupId,
        trigger: {
          type: trigger.type,
          tier: trigger.tier,
          topic: trigger.topic,
          data: trigger.data,
        },
        severity: computeOverallSeverity(snapshot),
        context: snapshotText,
      },
      '[ADVICE] Auto-advice suppressed — trigger would have fired',
    );
    recordAdviceSent(groupId, trigger.tier);
    database.adviceLogs.create({
      group_id: groupId,
      tier: trigger.tier,
      trigger_type: trigger.type,
      trigger_data: JSON.stringify(trigger.data),
      topic: trigger.topic,
      advice_text: '[auto-advice suppressed]',
    });
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
    let writer = new StatusWriter({ header, mode: 'plain' });

    let rawAdvice: string | undefined;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const result = await aiStreamRound(
          {
            messages: [{ role: 'user', content: fullPrompt }],
            maxTokens: tierConfig.max_tokens,
            temperature: tierConfig.temperature,
            chain: 'smart',
            signal: AbortSignal.timeout(ADVICE_TIMEOUT_MS[tier]),
          },
          { onTextDelta: (delta) => writer.append(delta) },
        );
        rawAdvice = result.text;
        break;
      } catch (err) {
        if (attempt === 0) {
          // First attempt failed — silently retry with a fresh message
          logger.warn({ err }, '[ADVICE] First attempt failed, retrying');
          await writer.close();
          writer = new StatusWriter({ header, mode: 'plain' });
          continue;
        }
        // Second attempt also failed — show error to the user
        await writer.finalizeError('<i>❌ Генерация прервана, попробуй ещё раз</i>');
        throw err;
      }
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

    // QA pass: reject hallucinated/generic/contradictory advice before the user sees the final version.
    // The streamed placeholder is still up — if rejected, we delete it and skip the send.
    const validation = await validateAdvice({ tier, trigger, advice: cleanAdvice });
    if (!validation.approved) {
      logger.warn(
        {
          groupId,
          tier,
          triggerType: trigger.type,
          topic: trigger.topic,
          reason: validation.reason,
        },
        '[ADVICE] Validator rejected advice, not sending',
      );
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
      ? `\nRecent ${recentTopics.length} advice topics: ${JSON.stringify(recentTopics)}\nDo NOT repeat these topics. Find a new angle.\n`
      : '';

  const toneOfVoice = `
TONE OF VOICE:
Write like a friend who understands finances — simple, human, no bureaucratic or statistical jargon.
Address the user informally ("ты" in Russian). Never say "пользователь", "наблюдается", "зафиксирован".

BAD examples (❌):
- "Обнаружен разрыв сильной корреляции r=+0.94"
- "Зафиксирована аномалия отклонения 2.3σ в категории транспорт"
- "Наблюдается acceleration spend velocity на 47%"
- "Budget utilization составляет 89% при burn rate 1.2x"
- "Медианное значение расходов демонстрирует восходящий тренд"

GOOD examples (✅):
- "Транспорт и еда раньше росли вместе, а в этом месяце еда улетела отдельно — стоит глянуть почему"
- "На транспорт потратил в 2.3 раза больше обычного — 15 000 RSD вместо привычных 6 500"
- "Темп трат ускорился почти вдвое за последнюю неделю"
- "Бюджет на еду почти исчерпан — потрачено 89% (45 000 из 50 000 RSD)"
- "Траты на еду понемногу растут каждый месяц"

Rules:
- Name specific amounts and categories but explain them in plain language
- "в 2 раза больше обычного" instead of "deviation 2x"
- "потрачено 80% бюджета" instead of "burn rate 0.8"
- No correlation coefficients, sigmas, z-scores — translate into understandable words
- Short sentences. One idea = one sentence`;

  const outputRules = `
OUTPUT RULES:
- Use ONLY these HTML tags: <b>, <i>, <code>, <blockquote>. NO Markdown (**, *, \`, ##).
- Do NOT invent links! Do not use <a> without real URLs.
- When mentioning anomalies (Nx), ALWAYS explain in plain language, e.g. "в 4.5 раза выше обычного за последние 3 месяца".
- ALWAYS respond in Russian.`;

  if (tier === 'quick') {
    return `You are a financial assistant. You speak simply and to the point.
Every statement MUST contain a specific number from the data.
${toneOfVoice}

SITUATION LEVEL: ${severity}
${severity === 'good' ? 'Praise the user and give optimization advice.' : 'Start with the most important observation.'}

DATA:
${snapshotText}
${antiRepetition}
${outputRules}

Give ONE specific financial insight based on the data above.
No philosophizing. Name a specific number and a specific action.
Maximum 1-2 sentences.`;
  }

  if (tier === 'alert') {
    return `You are a financial assistant. You speak simply and to the point.
Every statement MUST contain a specific number from the data.
${toneOfVoice}

SITUATION LEVEL: ${severity}
TRIGGER: ${trigger.type} — ${JSON.stringify(trigger.data)}

DATA:
${snapshotText}
${antiRepetition}
${outputRules}

A financial situation requiring attention has been detected.
Describe the problem with specific numbers. Suggest 1-2 actions.
3-5 sentences maximum.`;
  }

  // Tier 3: deep
  return `You are a financial assistant. You speak simply and to the point.
Every statement MUST contain a specific number from the data.
${toneOfVoice}

SITUATION LEVEL: ${severity}

ANALYSIS RULES (for your internal use, do NOT use these terms in the response):
- Spent over 100% of budget by current day of month = overspending
- Spending over 2x the average = problem
- Budget used 90%+ = time to slow down, 100%+ = exceeded
- Week-over-week spending growth 20%+ = rising trend

DATA:
${snapshotText}
${antiRepetition}
${outputRules}

Create a full financial overview based on the data.
Structure:
1. Overall picture (total spent, budget utilization)
2. Trends (week/month comparison)
3. Problem categories (where spending is above normal, where budget is exceeded)
4. End-of-month forecast
5. Recommendations (max 3, specific, with numbers)`;
}
