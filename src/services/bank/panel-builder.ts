// Builds bank status panel text and keyboard — shared between bot commands and sync service.
import { database } from '../../database';
import type { BankConnection } from '../../database/types';

export interface PanelButton {
  text: string;
  callback_data: string;
}

export function buildBankStatusText(conn: BankConnection): string {
  const accounts = database.bankAccounts.findByConnectionId(conn.id);

  const syncLine = conn.last_sync_at
    ? `${timeSince(conn.last_sync_at)} назад`
    : 'ожидает первой синхронизации';

  const statusEmoji = !conn.last_sync_at ? '⌛' : conn.status === 'active' ? '✅' : '⚠️';

  const balanceLine =
    accounts.length > 0
      ? accounts.map((a) => `${a.balance.toFixed(2)} ${a.currency}`).join(', ')
      : conn.last_sync_at
        ? 'балансы не найдены'
        : 'балансы загрузятся после первой синхронизации';

  const pendingTxs = database.bankTransactions.findPendingByConnectionId(conn.id).slice(0, 3);
  const txLines =
    pendingTxs.length > 0
      ? '\n\nПоследние операции:\n' +
        pendingTxs
          .map(
            (tx) =>
              `• ${tx.amount.toFixed(2)} ${tx.currency} — ${tx.merchant_normalized ?? tx.merchant ?? '—'} · ⏳ ожидает`,
          )
          .join('\n')
      : '';

  const errorLine =
    conn.last_error && conn.consecutive_failures > 0
      ? `\n⚠️ Ошибка синхронизации: ${conn.last_error}`
      : '';

  return `🏦 ${conn.display_name} · ${syncLine} · ${statusEmoji}\nБаланс: ${balanceLine}${txLines}${errorLine}`;
}

export function buildBankManageKeyboard(conn: BankConnection): PanelButton[][] {
  const rows: PanelButton[][] = [
    [{ text: `⚙️ ${conn.display_name}`, callback_data: `bank_settings:${conn.id}` }],
  ];

  if (conn.last_sync_at) {
    rows.push([
      { text: '🔄 Синхронизировать', callback_data: `bank_sync:${conn.id}` },
      { text: '🔌 Отключить', callback_data: `bank_disconnect:${conn.id}` },
    ]);
  } else {
    // First sync pending — no manual sync button yet
    rows.push([{ text: '🔌 Отключить', callback_data: `bank_disconnect:${conn.id}` }]);
  }

  return rows;
}

export function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} мин`;
  return `${Math.floor(mins / 60)} ч`;
}
