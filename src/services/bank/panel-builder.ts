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

/**
 * @param expanded - when true (e.g. /bank tbc explicit call), show management buttons directly
 *   instead of the collapsed ⚙️ navigation button used in the summary panel.
 */
export function buildBankManageKeyboard(conn: BankConnection, expanded = false): PanelButton[][] {
  if (!expanded) {
    const rows: PanelButton[][] = [
      [{ text: `⚙️ ${conn.display_name}`, callback_data: `bank_settings:${conn.id}` }],
    ];
    if (conn.last_sync_at && conn.consecutive_failures === 0) {
      rows.push([{ text: '🔄 Синхронизировать', callback_data: `bank_sync:${conn.id}` }]);
    }
    return rows;
  }

  // Expanded: management buttons shown directly, no ⚙️ wrapper
  const rows: PanelButton[][] = [];
  if (conn.last_sync_at && conn.consecutive_failures === 0) {
    rows.push([{ text: '🔄 Синхронизировать', callback_data: `bank_sync:${conn.id}` }]);
  }
  const accounts = database.bankAccounts.findByConnectionId(conn.id);
  if (accounts.length > 0) {
    rows.push([{ text: '📋 Счета', callback_data: `bank_accounts:${conn.id}` }]);
  }
  rows.push([{ text: '🔄 Переподключить', callback_data: `bank_reconnect:${conn.id}` }]);
  rows.push([{ text: '🔌 Отключить', callback_data: `bank_disconnect:${conn.id}` }]);
  return rows;
}

export function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} мин`;
  return `${Math.floor(mins / 60)} ч`;
}
