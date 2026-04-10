// AI pre-fill for bank transactions — batch-suggests category before showing confirmation card.
// Processes up to 10 transactions per API call; includes group's actual categories and MCC history.
import { database } from '../../database';
import type { BankTransaction } from '../../database/types.ts';
import { createLogger } from '../../utils/logger.ts';
import { aiStreamRound, stripThinkingTags } from '../ai/streaming';
import { getMccLabel } from './mcc-labels.ts';

const logger = createLogger('bank-prefill');

export interface PrefillResult {
  category: string;
}

const BATCH_SIZE = 10;

/**
 * Build a map of MCC code → categories used for past confirmed transactions in this group.
 * Used to give the AI historical context for better classification.
 */
function buildMccHistory(groupId: number, mccs: number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (mccs.length === 0) return result;

  for (const mcc of mccs) {
    const rows = database.queryAll<{ category: string }>(
      `SELECT DISTINCT e.category
       FROM bank_transactions bt
       JOIN expenses e ON bt.matched_expense_id = e.id
       WHERE bt.mcc = ? AND e.group_id = ?
       ORDER BY e.created_at DESC
       LIMIT 5`,
      mcc,
      groupId,
    );

    if (rows.length > 0) {
      result.set(
        mcc,
        rows.map((r) => r.category),
      );
    }
  }
  return result;
}

async function callAiBatch(
  txs: BankTransaction[],
  groupCategories: string[],
  mccHistory: Map<number, string[]>,
): Promise<string[]> {
  const categoriesList =
    groupCategories.length > 0 ? groupCategories.join(', ') : 'еда, транспорт, здоровье, прочее';

  const txLines = txs
    .map((tx, i) => {
      const mccLabel = getMccLabel(tx.mcc);
      const mccPart = tx.mcc ? `MCC ${tx.mcc}${mccLabel ? ` (${mccLabel})` : ''}` : null;
      const historyCategories = tx.mcc ? mccHistory.get(tx.mcc) : undefined;
      const historyPart =
        historyCategories && historyCategories.length > 0
          ? `ранее: ${historyCategories.join(', ')}`
          : null;
      const hints = [mccPart, historyPart].filter(Boolean).join('; ');
      const merchant = tx.merchant_normalized ?? tx.merchant ?? 'неизвестно';
      return `${i + 1}. "${merchant}" — ${tx.amount} ${tx.currency}${hints ? ` [${hints}]` : ''}`;
    })
    .join('\n');

  const prompt = `Определи категорию для каждой транзакции из этого списка.

Доступные категории: ${categoriesList}

Транзакции:
${txLines}

Ответь JSON массивом из ${txs.length} строк (только категории, в том же порядке):
["категория1", "категория2", ...]

Используй только категории из списка. Если подходящей нет — "прочее".`;

  try {
    const { text } = await aiStreamRound({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 200,
      chain: 'fast',
    });

    const cleaned = stripThinkingTags(text);
    const match = cleaned.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error('No JSON array in response');

    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed) || parsed.length !== txs.length) {
      throw new Error(
        `AI returned ${Array.isArray(parsed) ? parsed.length : 'non-array'}, expected ${txs.length}`,
      );
    }
    return parsed.map((v) => (typeof v === 'string' ? v : 'прочее'));
  } catch (error) {
    logger.warn({ err: error }, 'AI batch pre-fill failed, using defaults');
    return txs.map(() => 'прочее');
  }
}

/**
 * Pre-fill categories for a batch of bank transactions.
 * Calls AI once per batch of up to BATCH_SIZE transactions.
 * Falls back to "прочее" if AI is unavailable.
 */
export async function preFillTransactions(
  txs: BankTransaction[],
  groupId: number,
): Promise<PrefillResult[]> {
  if (txs.length === 0) return [];

  const groupCategories = database.categories
    .findByGroupId(groupId)
    .map((c: { name: string }) => c.name);

  const mccs = [...new Set(txs.map((t) => t.mcc).filter((m): m is number => m !== null))];
  const mccHistory = buildMccHistory(groupId, mccs);

  const results: PrefillResult[] = [];

  for (let i = 0; i < txs.length; i += BATCH_SIZE) {
    const batch = txs.slice(i, i + BATCH_SIZE);
    const categories = await callAiBatch(batch, groupCategories, mccHistory);
    for (const category of categories) {
      results.push({ category });
    }
  }

  return results;
}
