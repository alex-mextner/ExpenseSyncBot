// Bank sync service — periodic sync via node-cron every 30 min.
// Upserts accounts/transactions from connected banks, sends confirmation cards.

import { subDays } from 'date-fns';
import cron from 'node-cron';
import type { CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import type { BankConnection, BankTransaction } from '../../database/types';
import { decryptData } from '../../utils/crypto';
import { createLogger } from '../../utils/logger.ts';
import { convertToEUR } from '../currency/converter';
import { buildBankManageKeyboard, buildBankStatusText } from './panel-builder';
import { preFillTransaction } from './prefill';
import type { ScrapeResult, ZenAccount, ZenTransaction } from './registry';
import { BANK_REGISTRY } from './registry';
import { createZenMoneyShim } from './runtime';
import { editMessageText, sendMessage } from './telegram-sender';

const logger = createLogger('sync-service');

const MAX_CONSECUTIVE_FAILURES = 3;

// Mutex that serializes ZenPlugin execution — globalThis.ZenMoney is not concurrency-safe.
let shimMutex: Promise<void> = Promise.resolve();

// Per-connection lock — prevents overlapping sync cycles for the same connection.
const syncingConnections = new Set<number>();

export function startSyncService(): void {
  // Run initial sync for all existing active connections immediately on startup.
  const connections = database.bankConnections.findAllActive();
  logger.info({ count: connections.length }, 'Bank sync service starting — running initial sync');
  for (const conn of connections) {
    runSyncCycle(conn.id).catch((err) =>
      logger.error({ err, connectionId: conn.id }, 'Initial startup sync failed'),
    );
  }

  // Schedule periodic sync every 30 min.
  // Queries active connections at each tick so new connections are picked up automatically.
  cron.schedule('*/30 * * * *', () => {
    const active = database.bankConnections.findAllActive();
    logger.info({ count: active.length }, 'Cron sync tick');
    for (const conn of active) {
      runSyncCycle(conn.id).catch((err) =>
        logger.error({ err, connectionId: conn.id }, 'Unhandled sync cycle error'),
      );
    }
  });

  logger.info('Bank sync cron scheduled (every 30 min)');
}

export function triggerManualSync(connectionId: number): Promise<void> {
  return runSyncCycle(connectionId);
}

/**
 * Called after a new bank connection is activated during runtime.
 * Runs the initial sync immediately; subsequent syncs are handled by the cron job.
 */
export function activateNewConnection(connectionId: number): void {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn || conn.status !== 'active') return;

  logger.info({ connectionId, bank: conn.bank_name }, 'New connection — running initial sync');

  runSyncCycle(connectionId).catch((err) =>
    logger.error({ err, connectionId }, 'Initial sync failed'),
  );
}

async function runSyncCycle(connectionId: number): Promise<void> {
  if (syncingConnections.has(connectionId)) {
    logger.info({ connectionId }, 'Sync already in progress — skipping');
    return;
  }

  const conn = database.bankConnections.findById(connectionId);
  if (!conn || conn.status !== 'active') return;

  const plugin = BANK_REGISTRY[conn.bank_name];
  if (!plugin) {
    logger.warn({ bankName: conn.bank_name }, 'Unknown bank in registry');
    return;
  }

  syncingConnections.add(connectionId);
  logger.info({ connectionId, bank: conn.bank_name }, 'Starting sync cycle');

  try {
    // Load and decrypt credentials
    const credentials = database.bankCredentials.findByConnectionId(connectionId);
    if (!credentials) {
      logger.warn({ connectionId }, 'No credentials found for connection');
      return;
    }

    const preferences = JSON.parse(decryptData(credentials.encrypted_data)) as Record<
      string,
      string
    >;

    const fromDate = conn.last_sync_at ? new Date(conn.last_sync_at) : subDays(new Date(), 30);
    const toDate = new Date();

    // Serialize plugin execution — globalThis.ZenMoney is shared and not concurrency-safe.
    const prevMutex = shimMutex;
    let releaseMutex!: () => void;
    shimMutex = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    await prevMutex;

    let accounts: ZenAccount[] = [];
    let transactions: ZenTransaction[] = [];

    try {
      const shim = createZenMoneyShim(connectionId, database.db, preferences);
      (globalThis as { ZenMoney?: typeof shim }).ZenMoney = shim;

      const { scrape } = await plugin.plugin();
      const rawResult = (await scrape({ preferences, fromDate, toDate })) as
        | Partial<ScrapeResult>
        | undefined;

      accounts = [
        ...(rawResult?.accounts ?? []),
        ...(shim._getCollectedAccounts() as ZenAccount[]),
      ];
      transactions = [
        ...(rawResult?.transactions ?? []),
        ...(shim._getCollectedTransactions() as ZenTransaction[]),
      ];

      const setResultData = shim._getSetResult() as Partial<ScrapeResult> | undefined;
      if (setResultData) {
        accounts.push(...(setResultData.accounts ?? []));
        transactions.push(...(setResultData.transactions ?? []));
      }
    } finally {
      delete (globalThis as { ZenMoney?: unknown }).ZenMoney;
      releaseMutex();
    }

    // Upsert accounts
    for (const account of accounts) {
      database.bankAccounts.upsert({
        connection_id: connectionId,
        account_id: account.id,
        title: account.title,
        balance: account.balance,
        currency: account.currency,
        type: account.type ?? null,
      });
    }

    // Load approved merchant rules once for this cycle
    const approvedRules = database.merchantRules.findApproved();
    const group = database.groups.findById(conn.group_id);
    if (!group) {
      logger.warn({ groupId: conn.group_id }, 'Group not found for connection');
      return;
    }

    // Process transactions
    for (const tx of transactions) {
      const amount = Math.abs(tx.sum);
      if (amount === 0) continue;

      const signType = determineSignType(tx);
      // Credit/incoming transactions are stored for reference but not confirmed as expenses
      const status: BankTransaction['status'] =
        signType === 'debit' ? 'pending' : 'skipped_reversal';

      // Apply merchant normalization
      const merchantNormalized = applyMerchantRules(tx.merchant, approvedRules);

      const inserted = database.bankTransactions.insertIgnore({
        connection_id: connectionId,
        external_id: tx.id,
        date: tx.date.includes('T') ? (tx.date.split('T')[0] ?? tx.date) : tx.date,
        amount,
        sign_type: signType,
        currency: tx.currency,
        merchant: tx.merchant ?? null,
        merchant_normalized: merchantNormalized,
        mcc: tx.mcc ?? null,
        raw_data: JSON.stringify(tx),
        status,
      });

      if (!inserted || status !== 'pending') continue;

      // AI pre-fill and persist so the confirm callback can read it back
      const prefilled = await preFillTransaction(inserted);
      database.bankTransactions.setPrefill(inserted.id, prefilled.category, prefilled.comment);

      // Large transaction: compare EUR equivalent to threshold
      const amountInEur = convertToEUR(amount, tx.currency as CurrencyCode);
      const isLarge = amountInEur >= env.LARGE_TX_THRESHOLD_EUR;

      const cardText = formatConfirmationCard(inserted, prefilled, conn.display_name, isLarge);

      const result = await sendMessage(env.BOT_TOKEN, group.telegram_group_id, cardText, {
        ...(conn.panel_message_thread_id !== null
          ? { message_thread_id: conn.panel_message_thread_id }
          : {}),
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Принять', callback_data: `bank_confirm:${inserted.id}` },
              { text: '✏️ Исправить', callback_data: `bank_edit:${inserted.id}` },
            ],
          ],
        },
      });

      if (result) {
        database.bankTransactions.setTelegramMessageId(inserted.id, result.message_id);
      }
    }

    // Success: reset failures
    database.bankConnections.update(connectionId, {
      consecutive_failures: 0,
      last_sync_at: new Date().toISOString(),
      last_error: null,
    });

    logger.info(
      { connectionId, accounts: accounts.length, transactions: transactions.length },
      'Sync cycle completed',
    );

    // Update panel message with fresh status
    const freshConn = database.bankConnections.findById(connectionId);
    if (freshConn?.panel_message_id && group) {
      const panelText = buildBankStatusText(freshConn);
      const keyboard = buildBankManageKeyboard(freshConn);
      await editMessageText(
        env.BOT_TOKEN,
        group.telegram_group_id,
        freshConn.panel_message_id,
        panelText,
        {
          reply_markup: { inline_keyboard: keyboard },
        },
      ).catch((err) => logger.warn({ err }, 'Failed to update panel message after sync'));
    }
  } catch (error) {
    await handleSyncError(connectionId, conn, error);
  } finally {
    syncingConnections.delete(connectionId);
  }
}

/**
 * Maps ZenPlugin error types to human-readable messages.
 * ZPAPIError does not extend Error, so instanceof Error won't work.
 */
function zenErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);

  const name = (error as { constructor?: { name?: string } }).constructor?.name ?? '';
  const msg = (error as { message?: string }).message;
  const bankMsg = (error as { bankMessage?: string }).bankMessage;

  const knownErrors: Record<string, string> = {
    InvalidLoginOrPasswordError: 'Неверный логин или пароль',
    PinCodeInsteadOfPasswordError: 'Введён PIN вместо пароля',
    PasswordExpiredError: 'Пароль истёк — смени в интернет-банке',
    InvalidOtpCodeError: 'Неверный код подтверждения',
    TemporaryUnavailableError: 'Банк временно недоступен',
    IncompatibleVersionError: 'Несовместимая версия плагина',
    PreviousSessionNotClosedError: 'Предыдущая сессия не закрыта — попробуем позже',
    UserInteractionError: 'Требуется действие в приложении банка',
    SubscriptionRequiredError: 'Требуется подписка в приложении банка',
  };

  if (name in knownErrors) return knownErrors[name] ?? String(error);
  if (name === 'BankMessageError' && bankMsg) return `Сообщение от банка: ${bankMsg}`;
  if (name === 'InvalidPreferencesError' || name === 'TemporaryError') {
    return msg || 'Ошибка авторизации';
  }

  // Fallback: use message if non-empty, otherwise constructor name or raw string
  if (msg) return msg;
  if (name && name !== 'Object') return name;
  return String(error);
}

async function handleSyncError(
  connectionId: number,
  conn: BankConnection,
  error: unknown,
): Promise<void> {
  const message = zenErrorMessage(error);
  const failures = conn.consecutive_failures + 1;

  database.bankConnections.update(connectionId, {
    consecutive_failures: failures,
    last_error: message,
  });

  logger.error({ err: error, connectionId, failures }, 'Sync cycle failed');

  // Send alert only on the 3rd failure (not on every subsequent failure)
  if (failures === MAX_CONSECUTIVE_FAILURES) {
    const group = database.groups.findById(conn.group_id);
    if (group) {
      await sendMessage(
        env.BOT_TOKEN,
        group.telegram_group_id,
        `⚠️ ${escapeHtml(conn.display_name)} — ошибка синхронизации\n\nНе удаётся подключиться 3 раза подряд.\nПоследняя ошибка: ${escapeHtml(message)}\n\nВозможно, изменился пароль или истекла сессия.\n/bank ${escapeHtml(conn.bank_name)} — переподключить`,
        group.active_topic_id !== null ? { message_thread_id: group.active_topic_id } : undefined,
      ).catch((e) => logger.error({ err: e }, 'Failed to send escalation alert'));
    }
  }
}

function determineSignType(tx: ZenTransaction): 'debit' | 'credit' | 'reversal' {
  if (tx.sum < 0) return 'debit';
  return 'credit';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyMerchantRules(
  merchant: string | undefined,
  rules: { pattern: string; flags: string; replacement: string }[],
): string | null {
  if (!merchant) return null;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags);
      if (regex.test(merchant)) {
        return merchant.replace(regex, rule.replacement);
      }
    } catch {
      // ignore invalid regex
    }
  }
  return null;
}

function formatConfirmationCard(
  tx: BankTransaction,
  prefilled: { category: string; comment: string },
  bankName: string,
  isLarge: boolean,
): string {
  const prefix = isLarge ? '⚠️ Крупная транзакция' : '💳';
  const merchant = escapeHtml(tx.merchant_normalized ?? tx.merchant ?? 'Неизвестно');
  const mccLine = tx.mcc ? `\n🏷 MCC: ${tx.mcc}` : '';

  return `${prefix} ${escapeHtml(bankName)} — ${tx.amount.toFixed(2)} ${escapeHtml(tx.currency)}
📍 ${merchant}
🗂 Категория: ${escapeHtml(prefilled.category)}
💬 Комментарий: ${escapeHtml(prefilled.comment)}${mccLine}`;
}
