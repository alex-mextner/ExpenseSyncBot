// Builds bank status panel text and keyboard — shared between bot commands and sync service.
import { database } from '../../database';
import type { BankConnection } from '../../database/types';

export interface PanelButton {
  text: string;
  callback_data: string;
}

/**
 * Reminder appended to the /bank panel when chat cards are off. In that mode the
 * sync is balance-only (transactions are not pulled at all), so the panel explains
 * why no transactions show up and how to turn them back on.
 */
function bankCardsOffHint(cardsEnabled: boolean): string {
  return cardsEnabled
    ? ''
    : '\n\n🔕 Транзакции банка не синхронизируются — виден только баланс. Включить в /settings';
}

/** Whether the group that owns this connection currently has chat cards enabled. */
function cardsEnabledForConnection(conn: BankConnection): boolean {
  return Boolean(database.groups.findById(conn.group_id)?.bank_cards_enabled);
}

/**
 * Per-connection status section (balance, recent operations, errors).
 * Does NOT include the cards-off hint — that is panel-level and added once by the
 * public builders, so the combined multi-bank panel never repeats it per section.
 * When cards are off the sync is balance-only, so the "recent operations" list is
 * omitted — otherwise stale pending rows would contradict the "только баланс" hint.
 */
function renderBankSection(conn: BankConnection, cardsEnabled: boolean): string {
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

  const pendingTxs = cardsEnabled
    ? database.bankTransactions.findPendingByConnectionId(conn.id).slice(0, 3)
    : [];
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
 * Single-connection panel text. The cards-off hint is resolved from the owning
 * group here, so it persists across every render of the panel — the initial
 * /bank view, sync-service status edits, and panel navigation alike.
 */
export function buildBankStatusText(conn: BankConnection): string {
  const cardsEnabled = cardsEnabledForConnection(conn);
  return `${renderBankSection(conn, cardsEnabled)}${bankCardsOffHint(cardsEnabled)}`;
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
  // Clock drift / bad inputs → clamp to 0 to avoid "-10 мин" display.
  const diff = Math.max(0, Date.now() - new Date(isoDate).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} мин`;
  return `${Math.floor(mins / 60)} ч`;
}

/**
 * Combined status text for multiple bank connections in one message.
 * Each bank is a separate section separated by a blank line.
 */
export function buildCombinedBankStatusText(
  connections: BankConnection[],
  totalEur: number,
): string {
  // All connections in a panel belong to the same group, so the first one decides
  // the cards state. Sections render without the hint (appended once below the total)
  // but DO respect cardsEnabled so the balance-only sections drop their tx lines.
  const first = connections[0];
  const cardsEnabled = first ? cardsEnabledForConnection(first) : true;
  const sections = connections.map((conn) => renderBankSection(conn, cardsEnabled)).join('\n\n');
  return `${sections}\n\nИтого: ~${totalEur.toFixed(0)} EUR${bankCardsOffHint(cardsEnabled)}`;
}

/**
 * Combined keyboard for multi-bank panel.
 * Per-bank row: sync button (if available) + settings button.
 * Bottom row: global sync (if any bank is syncable) + add bank.
 */
export function buildCombinedBankKeyboard(connections: BankConnection[]): PanelButton[][] {
  const rows: PanelButton[][] = [];

  for (const conn of connections) {
    const row: PanelButton[] = [];
    if (conn.last_sync_at && conn.consecutive_failures === 0 && conn.status === 'active') {
      row.push({ text: `🔄 ${conn.display_name}`, callback_data: `bank_sync:${conn.id}` });
    }
    row.push({ text: `⚙️ ${conn.display_name}`, callback_data: `bank_settings:${conn.id}` });
    rows.push(row);
  }

  const canSyncAll = connections.some(
    (c) => c.last_sync_at && c.consecutive_failures === 0 && c.status === 'active',
  );
  const bottomRow: PanelButton[] = [];
  if (canSyncAll) {
    bottomRow.push({ text: '🔄 Синхронизировать все', callback_data: 'bank_sync_all' });
  }
  bottomRow.push({ text: '➕ Добавить банк', callback_data: 'bank_add' });
  rows.push(bottomRow);

  return rows;
}
