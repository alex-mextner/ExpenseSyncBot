// Bank sync service — periodic sync via node-cron every 30 min.
// Upserts accounts/transactions from connected banks, sends confirmation cards.

import { format, subDays } from 'date-fns';
import cron from 'node-cron';
import { env } from '../../config/env';
import { database } from '../../database';
import type { BankConnection, BankTransaction } from '../../database/types';
import { decryptData } from '../../utils/crypto';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { convertAnyToEUR, formatAmount } from '../currency/converter';
import { getOtpHint } from './otp-hints';
import { cancelOtpRequest, registerOtpRequest } from './otp-manager';
import { buildBankManageKeyboard, buildBankStatusText } from './panel-builder';
import { preFillTransactions } from './prefill';
import type { ScrapeResult, ZenAccount, ZenTransaction } from './registry';
import { BANK_REGISTRY } from './registry';
import { createZenMoneyShim } from './runtime';
import { editMessageText, sendMessage, withChatContext } from './telegram-sender';
import { buildOldTxSummaryText } from './transaction-summary';
import type {
  AccountReferenceByData,
  Merchant,
  Transaction as ZenPluginsTransaction,
} from './zenmoney-types';

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
  return runSyncCycle(connectionId, true);
}

/**
 * Called after a new bank connection is activated during runtime.
 * Runs the initial sync immediately; subsequent syncs are handled by the cron job.
 */
export function activateNewConnection(connectionId: number): Promise<void> {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn || conn.status !== 'active') return Promise.resolve();

  logger.info({ connectionId, bank: conn.bank_name }, 'New connection — running initial sync');

  return runSyncCycle(connectionId, true).catch((err) =>
    logger.error({ err, connectionId }, 'Initial sync failed'),
  );
}

async function runSyncCycle(connectionId: number, allowOtp = false): Promise<void> {
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

    // Cron syncs must not start if no plugin state exists yet — it means the user hasn't
    // completed the initial setup (login OTP + device trust). Starting would send unwanted SMS.
    if (!allowOtp) {
      const hasState = database.queryOne<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM bank_plugin_state WHERE connection_id = ?',
        connectionId,
      );
      if (!hasState || hasState.cnt === 0) {
        logger.info({ connectionId }, 'Skipping cron sync — plugin not initialized yet');
        return;
      }
    }

    const fromDate = conn.last_sync_at ? new Date(conn.last_sync_at) : subDays(new Date(), 30);
    const toDate = new Date();

    const group = database.groups.findById(conn.group_id);
    if (!group) {
      logger.warn({ groupId: conn.group_id }, 'Group not found for connection');
      return;
    }

    const threadId = conn.panel_message_thread_id ?? group.active_topic_id;
    await withChatContext(env.BOT_TOKEN, group.telegram_group_id, threadId, async () => {
      // shimRef allows readLineImpl to reference the shim before it is created.
      const shimRef: { current: ReturnType<typeof createZenMoneyShim> | null } = { current: null };

      // releaseMutex declared here so readLineImpl closure can reassign it on re-acquire.
      let releaseMutex: () => void = () => {};

      const readLineImpl = async (prompt: string): Promise<string> => {
        logger.info({ connectionId, prompt }, 'Plugin requesting interactive input (readLine)');

        if (!allowOtp) {
          // Cron sync — don't interrupt user with automatic OTP requests.
          throw new Error('OTP required — use manual sync button');
        }

        const hint = getOtpHint(conn.bank_name, prompt);
        const otpText = `🔐 ${escapeHtml(conn.display_name)} — код подтверждения\n\n${escapeHtml(prompt)}${hint ? `\n\n💡 ${escapeHtml(hint)}` : ''}\n\nОтправь код сюда (есть 5 минут).`;

        // Always send a new message for OTP prompts so it doesn't overwrite the
        // credentials panel that is still visible above in the chat.
        const sent = await sendMessage(otpText);
        const promptMsgId: number | null = sent?.message_id ?? null;

        // Release the global shim mutex while waiting for user OTP input so other sync
        // cycles are not blocked for the full 5-minute OTP wait window.
        delete (globalThis as { ZenMoney?: unknown }).ZenMoney;
        const releaseBeforeOtp = releaseMutex;
        releaseMutex = () => {}; // guard against double-release from finally
        releaseBeforeOtp();

        let code: string;
        try {
          code = await registerOtpRequest(connectionId, group.telegram_group_id);
        } catch (err) {
          // OTP timed out — edit the prompt message to offer a retry button.
          if (promptMsgId && err instanceof Error && err.message.includes('истекло')) {
            await editMessageText(
              promptMsgId,
              `⏰ Время ожидания кода истекло.\n\nНажми кнопку ниже чтобы синхронизировать снова.`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🔄 Синхронизировать снова',
                        callback_data: `bank_sync:${connectionId}`,
                      },
                    ],
                  ],
                },
              },
            ).catch(() => {});
          }
          throw err;
        }

        // Send a new "accepted" message — keep the original credentials panel intact
        // so the final sync status continues to edit it.
        await sendMessage('⌛ Принято, синхронизируем...').catch(() => {});

        // Re-acquire the global shim mutex before the plugin resumes execution.
        const prevForReacquire = shimMutex;
        shimMutex = new Promise<void>((resolve) => {
          releaseMutex = resolve;
        });
        await prevForReacquire;
        if (shimRef.current) {
          (globalThis as { ZenMoney?: unknown }).ZenMoney = shimRef.current;
        }

        return code;
      };

      // Serialize plugin execution — globalThis.ZenMoney is shared and not concurrency-safe.
      const prevMutex = shimMutex;
      shimMutex = new Promise<void>((resolve) => {
        releaseMutex = resolve;
      });
      await prevMutex;

      // Show connecting progress now that we have the mutex and are about to scrape.
      if (conn.panel_message_id) {
        await editMessageText(
          conn.panel_message_id,
          `⌛ ${escapeHtml(conn.display_name)} — Подключаемся...`,
        ).catch(() => {});
      }

      let accounts: ZenAccount[] = [];
      let transactions: ZenTransaction[] = [];

      try {
        const shim = createZenMoneyShim(connectionId, database.getDb(), preferences, readLineImpl);
        shimRef.current = shim;
        (globalThis as { ZenMoney?: typeof shim }).ZenMoney = shim;
        // assert() is a ZenPlugins global not available in Bun — set before plugin runs.
        (globalThis as { assert?: unknown }).assert = function assert(
          condition: unknown,
          ...args: unknown[]
        ): asserts condition {
          if (!condition) {
            throw new Error(`Assertion failed: ${args.map(String).join(' ')}`);
          }
        };

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
        releaseMutex(); // release before cancelling OTP so other syncs can queue up
        cancelOtpRequest(connectionId); // clean up if plugin exited without consuming the OTP
      }

      // Scrape done — re-read panel_message_id (OTP handler may have updated it) and show
      // intermediate progress so the user sees we're still working.
      const connAfterScrape = database.bankConnections.findById(connectionId);
      if (connAfterScrape?.panel_message_id) {
        const txCount = transactions.length;
        const txInfo = txCount > 0 ? `\n\nПолучено транзакций: ${txCount}` : '';
        await editMessageText(
          connAfterScrape.panel_message_id,
          `⌛ ${escapeHtml(conn.display_name)} — Обрабатываем данные...${txInfo}`,
        ).catch(() => {});
      }

      // Build account currency map for ZenPlugins-format transaction normalization
      const accountCurrencyMap = new Map<string, string>();
      for (const acc of accounts) {
        const currency = acc.instrument ?? acc.currency ?? '';
        if (currency) accountCurrencyMap.set(acc.id, currency);
      }

      // Normalize transactions from ZenPlugins movements-based format to our flat ZenTransaction
      const normalizedTransactions: ZenTransaction[] = [];
      for (const rawTx of transactions) {
        const normalized = normalizePluginsTransaction(rawTx, accountCurrencyMap);
        if (normalized !== null) normalizedTransactions.push(normalized);
      }
      transactions = normalizedTransactions;

      // Upsert accounts
      for (const account of accounts) {
        const currency = account.instrument ?? account.currency ?? '';
        if (!currency) {
          logger.warn({ accountId: account.id }, 'Account has no currency/instrument — skipping');
          continue;
        }
        database.bankAccounts.upsert({
          connection_id: connectionId,
          account_id: account.id,
          title: account.title,
          balance: account.balance ?? 0,
          currency,
          type: account.type ?? null,
        });
      }

      // Load approved merchant rules once for this cycle
      const approvedRules = database.merchantRules.findApproved();

      // Phase 1: insert all transactions into DB
      const newPendingTxs: BankTransaction[] = [];
      for (const tx of transactions) {
        const amount = Math.abs(tx.sum);
        if (amount === 0) continue;

        const signType = determineSignType(tx);
        // Credit/incoming transactions are stored for reference but not confirmed as expenses
        const status: BankTransaction['status'] =
          signType === 'debit' ? 'pending' : 'skipped_reversal';

        // Apply merchant normalization
        const merchantNormalized = applyMerchantRules(tx.merchant, approvedRules);

        const txDate = tx.date.includes('T') ? (tx.date.split('T')[0] ?? tx.date) : tx.date;
        const txTime = extractTime(tx.date);

        const inserted = database.bankTransactions.insertIgnore({
          connection_id: connectionId,
          external_id: tx.id,
          account_id: tx.account ?? null,
          date: txDate,
          time: txTime,
          amount,
          sign_type: signType,
          currency: tx.currency,
          merchant: tx.merchant ?? null,
          merchant_normalized: merchantNormalized,
          mcc: tx.mcc ?? null,
          raw_data: JSON.stringify(tx),
          status,
        });

        if (inserted && status === 'pending') {
          newPendingTxs.push(inserted);
        }
      }

      // Phase 2: batch AI pre-fill for all new pending transactions
      const prefillResults = await preFillTransactions(newPendingTxs, group.id);
      for (let i = 0; i < newPendingTxs.length; i++) {
        const tx = newPendingTxs[i];
        const prefilled = prefillResults[i];
        if (tx && prefilled) {
          database.bankTransactions.setPrefill(tx.id, prefilled.category, '');
        }
      }

      // Phase 3: send confirmation cards
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const todayTxs: { tx: BankTransaction; category: string }[] = [];
      const oldTxs: { tx: BankTransaction; category: string }[] = [];

      const excludedAccountIds = getExcludedAccountIds(connectionId);

      for (let i = 0; i < newPendingTxs.length; i++) {
        const inserted = newPendingTxs[i];
        const prefilled = prefillResults[i];
        if (!inserted || !prefilled) continue;

        if (inserted.account_id && excludedAccountIds.has(inserted.account_id)) continue;

        if (inserted.date === todayStr) {
          todayTxs.push({ tx: inserted, category: prefilled.category });
        } else {
          oldTxs.push({ tx: inserted, category: prefilled.category });
        }
      }

      // Check for orphaned today's transactions from previous syncs (user ignored the summary).
      // These have no telegram_message_id — send cards now so they don't stay stuck.
      const orphanedToday = getUnsentPendingTxs(connectionId).filter(
        (tx) => tx.date === todayStr && !newPendingTxs.some((n) => n.id === tx.id),
      );
      for (const tx of orphanedToday) {
        todayTxs.push({ tx, category: tx.prefill_category ?? '—' });
      }

      if (oldTxs.length > 0) {
        // Old transactions exist — defer ALL cards (including today's) behind user confirmation.
        // Summary is a gate: user decides whether to review old ones first.
        // Telegram delivery failure here is not a bank sync error — don't let it bubble up.
        await sendOldTransactionsSummary(oldTxs, conn).catch((err) =>
          logger.error({ err, connectionId }, 'Failed to send old transactions summary'),
        );
      } else {
        // No old transactions — send today's cards immediately
        for (const { tx, category } of todayTxs) {
          await sendConfirmationCard(tx, category, conn).catch((err) =>
            logger.error({ err, txId: tx.id }, 'Failed to send confirmation card'),
          );
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
      if (freshConn?.panel_message_id) {
        const panelText = buildBankStatusText(freshConn);
        const keyboard = buildBankManageKeyboard(freshConn);
        await editMessageText(freshConn.panel_message_id, panelText, {
          reply_markup: { inline_keyboard: keyboard },
        }).catch((err) => logger.warn({ err }, 'Failed to update panel message after sync'));
      }
    }); // end withChatContext
  } catch (error) {
    // OTP events are not bank-side failures — don't count them against consecutive_failures.
    if (error instanceof Error && error.message.includes('истекло')) {
      logger.info({ connectionId }, 'OTP not entered in time — sync paused until user retries');
      return;
    }
    if (error instanceof Error && error.message === 'OTP required — use manual sync button') {
      logger.info({ connectionId }, 'OTP required for cron sync — notifying user to sync manually');
      const notifyGroup = database.groups.findById(conn.group_id);
      const freshConn = database.bankConnections.findById(connectionId);
      if (freshConn && notifyGroup) {
        const keyboard = {
          inline_keyboard: [
            [{ text: '🔄 Синхронизировать', callback_data: `bank_sync:${connectionId}` }],
          ],
        };
        const notifyThreadId = freshConn.panel_message_thread_id ?? notifyGroup.active_topic_id;
        await withChatContext(
          env.BOT_TOKEN,
          notifyGroup.telegram_group_id,
          notifyThreadId,
          async () => {
            if (freshConn.panel_message_id) {
              await editMessageText(
                freshConn.panel_message_id,
                `🔐 ${escapeHtml(conn.display_name)} — для синхронизации нужен код`,
                { reply_markup: keyboard },
              ).catch(() => {});
            } else {
              await sendMessage(
                `🔐 ${escapeHtml(conn.display_name)} — требует код. Нажми кнопку для синхронизации.`,
                { reply_markup: keyboard },
              ).catch(() => {});
            }
          },
        );
      }
      return;
    }
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

  const group = database.groups.findById(conn.group_id);
  if (!group) return;

  const errorThreadId = conn.panel_message_thread_id ?? group.active_topic_id;
  await withChatContext(env.BOT_TOKEN, group.telegram_group_id, errorThreadId, async () => {
    // Always update the panel message to reflect the new error state
    const freshConn = database.bankConnections.findById(connectionId);
    if (freshConn?.panel_message_id) {
      await editMessageText(freshConn.panel_message_id, buildBankStatusText(freshConn), {
        reply_markup: { inline_keyboard: buildBankManageKeyboard(freshConn) },
      }).catch((err) => logger.warn({ err }, 'Failed to update panel message after error'));
    }

    // Send alert only on the 3rd failure (not on every subsequent failure)
    if (failures === MAX_CONSECUTIVE_FAILURES) {
      await sendMessage(
        `⚠️ ${escapeHtml(conn.display_name)} — ошибка синхронизации\n\nНе удаётся подключиться 3 раза подряд.\nПоследняя ошибка: ${escapeHtml(message)}\n\nВозможно, изменился пароль или истекла сессия.\n/bank ${escapeHtml(conn.bank_name)} — переподключить`,
      ).catch((e) => logger.error({ err: e }, 'Failed to send escalation alert'));
    }
  });
}

/** Converts ZenPlugins movements-based Transaction to our flat ZenTransaction.
 *  Passes through objects that are already in ZenTransaction format. */
export function normalizePluginsTransaction(
  raw: ZenTransaction | ZenPluginsTransaction,
  accountCurrencyMap: Map<string, string>,
): ZenTransaction | null {
  if (!('movements' in raw)) return raw;

  const movement = raw.movements[0];
  if (!movement) {
    logger.warn('normalizePluginsTransaction: transaction has empty movements array — skipping');
    return null;
  }

  // movement.id can be null for some transaction types (e.g. unresolved holds).
  // Generate a deterministic synthetic ID so they are not silently dropped.
  // Known collision risk: two different holds for identical sum+timestamp+account
  // on the same ms — second one is silently deduped by insertIgnore. Accepted.
  const acc = movement.account;
  const accId = 'id' in acc ? acc.id : '';
  const id =
    movement.id ??
    Buffer.from(
      `synthetic:${movement.sum ?? 0}:${raw.date instanceof Date ? raw.date.getTime() : String(raw.date)}:${accId}`,
    ).toString('base64');

  const sum = movement.sum;
  if (sum === null) return null;

  const currency =
    'instrument' in acc
      ? (acc as AccountReferenceByData).instrument
      : (accountCurrencyMap.get(acc.id) ?? '');

  if (!currency) {
    logger.warn({ txId: id }, 'No currency found for transaction — skipping');
    return null;
  }

  const date = raw.date instanceof Date ? raw.date.toISOString() : String(raw.date);

  const result: ZenTransaction = { id, sum, currency, date };

  if (accId) result.account = accId;

  if (raw.merchant !== null && raw.merchant !== undefined) {
    const title =
      'title' in raw.merchant ? (raw.merchant as Merchant).title : raw.merchant.fullTitle;
    if (title) result.merchant = title;
    if (raw.merchant.mcc !== null) result.mcc = raw.merchant.mcc;
  }

  if (raw.comment) result.comment = raw.comment;

  return result;
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

/** Extracts HH:MM from an ISO datetime string. Returns null if no time component. */
function extractTime(dateStr: string): string | null {
  if (!dateStr.includes('T')) return null;
  const timePart = dateStr.split('T')[1];
  if (!timePart) return null;
  // Strip timezone offset and seconds — keep HH:MM
  const hhmm = timePart.slice(0, 5);
  return /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : null;
}

async function sendConfirmationCard(
  tx: BankTransaction,
  category: string,
  conn: BankConnection,
): Promise<void> {
  const amountInEur = convertAnyToEUR(tx.amount, tx.currency);
  const isLarge = amountInEur >= env.LARGE_TX_THRESHOLD_EUR;

  const cardText = formatConfirmationCard(tx, category, conn.display_name, isLarge);

  const result = await sendMessage(cardText, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: `bank_confirm:${tx.id}` },
          { text: '✏️ Исправить', callback_data: `bank_edit:${tx.id}` },
        ],
      ],
    },
  });

  if (result) {
    database.bankTransactions.setTelegramMessageId(tx.id, result.message_id);
  }
}

async function sendOldTransactionsSummary(
  oldTxs: { tx: BankTransaction; category: string }[],
  conn: BankConnection,
): Promise<void> {
  const text = buildOldTxSummaryText(oldTxs, conn.display_name);

  await sendMessage(text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Показать', callback_data: `bank_show_old:${conn.id}` },
          { text: '⏭ Пропустить', callback_data: `bank_skip_old:${conn.id}` },
        ],
      ],
    },
  });
}

/** Returns account IDs excluded from sync for a given connection. */
function getExcludedAccountIds(connectionId: number): Set<string> {
  return new Set(
    database.bankAccounts
      .findByConnectionId(connectionId)
      .filter((a) => a.is_excluded === 1)
      .map((a) => a.account_id),
  );
}

/** Returns unsent pending transactions for a connection, excluding excluded accounts. */
function getUnsentPendingTxs(connectionId: number): BankTransaction[] {
  const excludedIds = getExcludedAccountIds(connectionId);

  return database.bankTransactions
    .findPendingByConnectionId(connectionId)
    .filter(
      (tx) => tx.telegram_message_id === null && !(tx.account_id && excludedIds.has(tx.account_id)),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

/**
 * Sends confirmation cards for all pending transactions without cards (old + today).
 * Old transactions first (chronological), then today's.
 * Called from callback handler when user clicks "Показать".
 */
export async function sendOldTransactionCards(connectionId: number): Promise<number> {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn) return 0;

  const group = database.groups.findById(conn.group_id);
  if (!group) return 0;

  const unsent = getUnsentPendingTxs(connectionId);

  const cardThreadId = conn.panel_message_thread_id ?? group.active_topic_id;
  await withChatContext(env.BOT_TOKEN, group.telegram_group_id, cardThreadId, async () => {
    for (const tx of unsent) {
      const category = tx.prefill_category ?? '—';
      await sendConfirmationCard(tx, category, conn).catch((err) =>
        logger.error({ err, txId: tx.id }, 'Failed to send confirmation card'),
      );
    }
  });

  return unsent.length;
}

/**
 * Skips old transactions, then sends cards for today's.
 * Called from callback handler when user clicks "Пропустить".
 * Returns count of skipped old transactions.
 */
export async function skipOldTransactions(connectionId: number): Promise<number> {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn) return 0;

  const group = database.groups.findById(conn.group_id);
  if (!group) return 0;

  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const unsent = getUnsentPendingTxs(connectionId);

  let skippedCount = 0;
  const skipThreadId = conn.panel_message_thread_id ?? group.active_topic_id;
  await withChatContext(env.BOT_TOKEN, group.telegram_group_id, skipThreadId, async () => {
    for (const tx of unsent) {
      if (tx.date !== todayStr) {
        database.bankTransactions.updateStatus(tx.id, conn.group_id, 'skipped');
        skippedCount++;
      } else {
        const category = tx.prefill_category ?? '—';
        await sendConfirmationCard(tx, category, conn).catch((err) =>
          logger.error({ err, txId: tx.id }, 'Failed to send confirmation card'),
        );
      }
    }
  });

  return skippedCount;
}

function formatConfirmationCard(
  tx: BankTransaction,
  category: string,
  bankName: string,
  isLarge: boolean,
): string {
  const prefix = isLarge ? '⚠️ Крупная транзакция' : '💳';
  const merchant = escapeHtml(tx.merchant_normalized ?? tx.merchant ?? 'Неизвестно');
  const mccLine = tx.mcc ? `\n🏷 MCC: ${tx.mcc}` : '';
  const dateTime = tx.time ? `${tx.date} ${tx.time}` : tx.date;

  return `${prefix} ${escapeHtml(bankName)} — ${formatAmount(tx.amount, tx.currency)}
📅 ${dateTime}
📍 ${merchant}
🗂 Категория: ${escapeHtml(category)}${mccLine}`;
}
