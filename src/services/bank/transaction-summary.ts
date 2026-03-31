// Builds a truncated summary of old bank transactions for Telegram display.

import type { BankTransaction } from '../../database/types';
import { escapeHtml } from '../../utils/html';
import { pluralize } from '../../utils/pluralize';
import { formatAmount } from '../currency/converter';

const MAX_VISIBLE = 10;

/**
 * Builds a truncated summary of old transactions using the N+2 rule:
 * either show all items, or truncate so that "и ещё N" has N ≥ 3.
 */
export function buildOldTxSummaryText(
  txs: { tx: BankTransaction; category: string }[],
  bankName: string,
): string {
  const total = txs.length;
  const showAll = total - MAX_VISIBLE < 3;
  const visible = showAll ? txs : txs.slice(0, MAX_VISIBLE);

  const lines = visible.map(({ tx }) => {
    const merchant = tx.merchant_normalized ?? tx.merchant ?? '—';
    return `• ${tx.date} — ${formatAmount(tx.amount, tx.currency)} — ${escapeHtml(merchant)}`;
  });

  if (!showAll) {
    lines.push(`\n<i>...и ещё ${total - MAX_VISIBLE}</i>`);
  }

  const txWord = pluralize(
    total,
    'необработанная транзакция',
    'необработанные транзакции',
    'необработанных транзакций',
  );
  return `📋 ${escapeHtml(bankName)} — ${total} ${txWord}\n\n${lines.join('\n')}\n\nПоказать для подтверждения?`;
}
