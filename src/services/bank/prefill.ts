// AI pre-fill for bank transactions — suggests category and comment before showing confirmation card.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.ts';
import type { BankTransaction } from '../../database/types.ts';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('bank-prefill');

export interface PrefillResult {
  category: string;
  comment: string;
}

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

function buildMccLabel(mcc: number | null): string {
  if (!mcc) return '';
  // Common MCC descriptions — not exhaustive, but covers top categories
  const MCC_LABELS: Record<number, string> = {
    5411: 'Продуктовые магазины',
    5812: 'Рестораны',
    5814: 'Фастфуд',
    5912: 'Аптеки',
    5541: 'АЗС',
    4111: 'Транспорт',
    4121: 'Такси',
    7011: 'Отели',
    4722: 'Туристические агентства',
    5999: 'Разное',
  };
  return MCC_LABELS[mcc] ? ` (${MCC_LABELS[mcc]})` : '';
}

export async function preFillTransaction(tx: BankTransaction): Promise<PrefillResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return { category: 'прочее', comment: tx.merchant_normalized ?? tx.merchant ?? '' };
  }

  const merchantDisplay = tx.merchant_normalized ?? tx.merchant ?? 'неизвестно';
  const mccLabel = buildMccLabel(tx.mcc);

  const prompt = `Определи категорию расхода на основе:
Мерчант: ${merchantDisplay}${tx.mcc ? `\nMCC: ${tx.mcc}${mccLabel}` : ''}
Сумма: ${tx.amount} ${tx.currency}

Ответь ТОЛЬКО JSON без пояснений:
{"category": "название категории", "comment": "краткий комментарий"}

Категория — одно-два слова на русском (еда, транспорт, здоровье, кафе, продукты, одежда, развлечения, коммунальные, прочее).`;

  try {
    const response = await getClient().messages.create({
      model: env.AI_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[^}]+\}/);
    if (!match) throw new Error('No JSON in response');

    const parsed = JSON.parse(match[0]) as { category?: string; comment?: string };
    return {
      category: parsed.category ?? 'прочее',
      comment: parsed.comment ?? merchantDisplay,
    };
  } catch (error) {
    logger.warn({ err: error, merchant: merchantDisplay }, 'Pre-fill failed, using defaults');
    return { category: 'прочее', comment: merchantDisplay };
  }
}
