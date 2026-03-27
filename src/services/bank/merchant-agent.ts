// Merchant normalization AI agent — batch-processes unmatched merchant strings
// into pending_review rules. Runs after each sync cycle and on new rule requests.
// Only active when BOT_ADMIN_CHAT_ID is configured.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { database } from '../../database';
import type { MerchantRuleRequest } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { sendMessage } from './telegram-sender';

const logger = createLogger('merchant-agent');

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.AI_BASE_URL ? { baseURL: env.AI_BASE_URL } : {}),
    });
  }
  return client;
}

interface AiRuleSuggestion {
  pattern: string;
  replacement: string;
  category: string | null;
  confidence: number;
}

/**
 * Process unmatched merchant strings and generate normalization rules.
 * No-op if BOT_ADMIN_CHAT_ID is not configured.
 */
export async function processMerchantRequests(): Promise<void> {
  if (!env.BOT_ADMIN_CHAT_ID) return;
  if (!env.ANTHROPIC_API_KEY) return;

  const requests = database.merchantRules.findUnprocessedRequests();
  if (requests.length === 0) return;

  logger.info({ count: requests.length }, 'Processing merchant rule requests');

  // Collect existing approved rules for context
  const existingRules = database.merchantRules.findApproved().map((r) => ({
    pattern: r.pattern,
    replacement: r.replacement,
    category: r.category,
  }));

  // Batch: up to 20 at a time
  const batch = requests.slice(0, 20);

  const suggestions = await callAiForRules(batch, existingRules);

  batch.forEach((request, i) => {
    const suggestion = suggestions[i];

    database.merchantRules.markRequestProcessed(request.id);

    if (!suggestion) return;

    // Insert rule with pending_review status
    const rule = database.merchantRules.insert({
      pattern: suggestion.pattern,
      replacement: suggestion.replacement,
      category: suggestion.category,
      confidence: suggestion.confidence,
      source: 'ai',
    });

    // Find example matches from existing transactions
    const examples = findExampleMatches(
      request.merchant_raw,
      suggestion.pattern,
      suggestion.replacement,
    );

    // Send admin approval card
    void sendAdminApprovalCard(rule.id, suggestion, examples);
  });

  // Prune old processed requests
  database.merchantRules.pruneOldRequests();
}

async function callAiForRules(
  requests: MerchantRuleRequest[],
  existingRules: { pattern: string; replacement: string; category: string | null }[],
): Promise<(AiRuleSuggestion | null)[]> {
  const merchantList = requests
    .map(
      (r, i) =>
        `${i + 1}. "${r.merchant_raw}"${r.mcc ? ` (MCC: ${r.mcc})` : ''}${r.user_category ? ` → категория пользователя: ${r.user_category}` : ''}`,
    )
    .join('\n');

  const existingList = existingRules
    .slice(0, 10)
    .map((r) => `"${r.pattern}" → "${r.replacement}"${r.category ? ` [${r.category}]` : ''}`)
    .join('\n');

  const prompt = `Создай правила нормализации для этих строк мерчантов.

Мерчанты для обработки:
${merchantList}

Существующие правила (для согласованности):
${existingList || '(пусто)'}

Для каждого мерчанта ответь JSON массивом с ${requests.length} объектами:
[{
  "pattern": "GLOVO.*",       // regexp для нормализации (пиши .*  для захвата суффиксов)
  "replacement": "Glovo",     // нормализованное название
  "category": "еда",          // категория расхода или null
  "confidence": 0.95          // уверенность 0.0-1.0
}, ...]

Возвращай ровно ${requests.length} объектов в том же порядке.`;

  try {
    const response = await getClient().messages.create({
      model: env.AI_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');

    const parsed = JSON.parse(match[0]) as AiRuleSuggestion[];
    return parsed;
  } catch (error) {
    logger.error({ err: error }, 'AI merchant rule generation failed');
    return requests.map(() => null);
  }
}

function findExampleMatches(merchantRaw: string, pattern: string, replacement: string): string[] {
  try {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(merchantRaw)) {
      return [`"${merchantRaw}" → "${replacement}"`];
    }
  } catch {
    // ignore invalid regex
  }
  return [];
}

async function sendAdminApprovalCard(
  ruleId: number,
  suggestion: AiRuleSuggestion,
  examples: string[],
): Promise<void> {
  if (!env.BOT_ADMIN_CHAT_ID) return;

  const exampleLines =
    examples.length > 0
      ? `\n\nПримеры совпадений:\n${examples.map((e) => `• ${e}`).join('\n')}`
      : '';

  const text = `🔧 Новое правило для мерчанта\n\nПаттерн: <code>${suggestion.pattern}</code>\n→ <b>${suggestion.replacement}</b>\n🗂 Категория: ${suggestion.category ?? '—'}\n📊 Уверенность: ${Math.round(suggestion.confidence * 100)}%${exampleLines}`;

  await sendMessage(env.BOT_TOKEN, env.BOT_ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: `merchant_approve:${ruleId}` },
          { text: '✏️ Исправить', callback_data: `merchant_edit:${ruleId}` },
          { text: '❌ Отклонить', callback_data: `merchant_reject:${ruleId}` },
        ],
      ],
    },
  }).catch((e) => logger.error({ err: e }, 'Failed to send admin approval card'));
}
