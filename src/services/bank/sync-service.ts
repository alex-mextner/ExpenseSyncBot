// Bank sync service — runs as a separate PM2 process.
// Polls bank APIs every 30 min, upserts accounts/transactions, sends confirmation cards.
import { subDays } from 'date-fns';
import { env } from '../../config/env';
import { database } from '../../database';
import type { BankConnection, BankTransaction } from '../../database/types';
import { decryptData } from '../../utils/crypto';
import { createLogger } from '../../utils/logger.ts';
import { preFillTransaction } from './prefill';
import type { ScrapeResult, ZenAccount, ZenTransaction } from './registry';
import { BANK_REGISTRY } from './registry';
import { createZenMoneyShim } from './runtime';
import { sendMessage } from './telegram-sender';

const logger = createLogger('sync-service');

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

export function startSyncService(): void {
  const connections = database.bankConnections.findAllActive();
  logger.info({ count: connections.length }, 'Bank sync service starting');

  for (const conn of connections) {
    scheduleConnection(conn);
  }
}

function scheduleConnection(conn: BankConnection): void {
  const initialDelayMs = (conn.id % 30) * 60 * 1000;

  logger.info(
    { connectionId: conn.id, bank: conn.bank_name, delayMin: conn.id % 30 },
    'Scheduling connection',
  );

  setTimeout(() => {
    runSyncCycle(conn.id).catch((err) =>
      logger.error({ err, connectionId: conn.id }, 'Unhandled sync cycle error'),
    );

    setInterval(() => {
      runSyncCycle(conn.id).catch((err) =>
        logger.error({ err, connectionId: conn.id }, 'Unhandled sync cycle error'),
      );
    }, SYNC_INTERVAL_MS);
  }, initialDelayMs);
}

async function runSyncCycle(connectionId: number): Promise<void> {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn || conn.status !== 'active') return;

  const plugin = BANK_REGISTRY[conn.bank_name];
  if (!plugin) {
    logger.warn({ bankName: conn.bank_name }, 'Unknown bank in registry');
    return;
  }

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

    // Set up ZenMoney shim and run scrape
    const shim = createZenMoneyShim(connectionId, database.db, preferences);
    (globalThis as { ZenMoney?: typeof shim }).ZenMoney = shim;

    const { scrape } = await plugin.plugin();
    const rawResult = (await scrape({ preferences, fromDate, toDate })) as
      | Partial<ScrapeResult>
      | undefined;

    // Merge results from both scrape() return and accumulated addAccount/addTransaction calls
    const accounts: ZenAccount[] = [
      ...(rawResult?.accounts ?? []),
      ...(shim._getCollectedAccounts() as ZenAccount[]),
    ];
    const transactions: ZenTransaction[] = [
      ...(rawResult?.transactions ?? []),
      ...(shim._getCollectedTransactions() as ZenTransaction[]),
    ];

    // Check for setResult fallback (legacy plugins)
    const setResultData = shim._getSetResult() as Partial<ScrapeResult> | undefined;
    if (setResultData) {
      accounts.push(...(setResultData.accounts ?? []));
      transactions.push(...(setResultData.transactions ?? []));
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
      const status = signType === 'reversal' ? 'skipped_reversal' : 'pending';

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

      // AI pre-fill and send confirmation card
      const prefilled = await preFillTransaction(inserted);

      const isLarge = tx.currency === 'EUR' ? amount >= env.LARGE_TX_THRESHOLD_EUR : false;

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
  } catch (error) {
    await handleSyncError(connectionId, conn, error);
  }
}

async function handleSyncError(
  connectionId: number,
  conn: BankConnection,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
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
        `⚠️ ${conn.display_name} — ошибка синхронизации\n\nНе удаётся подключиться 3 раза подряд.\nПоследняя ошибка: ${message}\n\nВозможно, изменился пароль или истекла сессия.\n/bank ${conn.bank_name} — переподключить`,
      ).catch((e) => logger.error({ err: e }, 'Failed to send escalation alert'));
    }
  }
}

function determineSignType(tx: ZenTransaction): 'debit' | 'credit' | 'reversal' {
  if (tx.sum < 0) return 'debit';
  return 'credit';
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
  const merchant = tx.merchant_normalized ?? tx.merchant ?? 'Неизвестно';
  const mccLine = tx.mcc ? `\n🏷 MCC: ${tx.mcc}` : '';

  return `${prefix} ${bankName} — ${tx.amount.toFixed(2)} ${tx.currency}
📍 ${merchant}
🗂 Категория: ${prefilled.category}
💬 Комментарий: ${prefilled.comment}${mccLine}`;
}
