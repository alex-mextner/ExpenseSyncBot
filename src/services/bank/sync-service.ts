// Bank sync service — periodic sync via node-cron every 30 min.
// Upserts accounts/transactions from connected banks, sends confirmation cards.

import { format, startOfDay, subDays } from 'date-fns';
import cron from 'node-cron';
import { env } from '../../config/env';
import { database } from '../../database';
import type { BankConnection, BankTransaction, Group } from '../../database/types';
import { decryptData } from '../../utils/crypto';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { convertAnyToEUR, formatAmount } from '../currency/converter';
import { getOtpHint } from './otp-hints';
import { cancelOtpRequest, registerOtpRequest } from './otp-manager';
import { buildBankManageKeyboard, buildBankStatusText } from './panel-builder';
import type { PrefillResult } from './prefill';
import { preFillTransactions } from './prefill';
import type { BankPlugin, ScrapeResult, ZenAccount, ZenTransaction } from './registry';
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

interface MerchantRule {
  pattern: string;
  flags: string;
  replacement: string;
}

/** Thrown by the readLine bridge when a cron (non-manual) sync hits an interactive prompt. */
const OTP_REQUIRED_MESSAGE = 'OTP required — use manual sync button';

/** Everything a sync cycle needs after the pre-flight checks passed. */
interface SyncContext {
  connectionId: number;
  conn: BankConnection;
  group: Group;
  plugin: BankPlugin;
  preferences: Record<string, string>;
  allowOtp: boolean;
  fromDate: Date;
  toDate: Date;
}

type ZenMoneyShim = ReturnType<typeof createZenMoneyShim>;

/** Holds the release function of the shim mutex slot currently owned by one sync cycle.
 *  Reassignable because the OTP wait gives the slot up and re-acquires a new one. */
interface ShimMutexHandle {
  release: () => void;
}

/** Queues behind the previous mutex holder; resolves when it is this cycle's turn. */
function acquireShimMutex(handle: ShimMutexHandle): Promise<void> {
  const previous = shimMutex;
  shimMutex = new Promise<void>((resolve) => {
    handle.release = resolve;
  });
  return previous;
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
    const ctx = loadSyncContext(conn, plugin, allowOtp);
    if (!ctx) return;

    const scraped = await scrapeBank(ctx);
    await showProcessingProgress(ctx, scraped.transactions.length);

    const transactions = normalizeScrapedTransactions(scraped);
    upsertAccounts(connectionId, scraped.accounts);
    await syncTransactionsIfEnabled(ctx, transactions);

    // Success: reset failures
    database.bankConnections.update(connectionId, {
      consecutive_failures: 0,
      last_sync_at: new Date().toISOString(),
      last_error: null,
    });

    logger.info(
      { connectionId, accounts: scraped.accounts.length, transactions: transactions.length },
      'Sync cycle completed',
    );

    await refreshPanelAfterSync(ctx);
  } catch (error) {
    await handleCycleError(connectionId, conn, error);
  } finally {
    syncingConnections.delete(connectionId);
  }
}

/**
 * Loads credentials, the cron-initialization gate and the owning group.
 * Returns null (after logging) when the cycle must not proceed.
 */
function loadSyncContext(
  conn: BankConnection,
  plugin: BankPlugin,
  allowOtp: boolean,
): SyncContext | null {
  const connectionId = conn.id;
  const credentials = database.bankCredentials.findByConnectionId(connectionId);
  if (!credentials) {
    logger.warn({ connectionId }, 'No credentials found for connection');
    return null;
  }

  const preferences = JSON.parse(decryptData(credentials.encrypted_data)) as Record<string, string>;

  // Cron syncs must not start if no plugin state exists yet — it means the user hasn't
  // completed the initial setup (login OTP + device trust). Starting would send unwanted SMS.
  if (!allowOtp) {
    const hasState = database.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM bank_plugin_state WHERE connection_id = ?',
      connectionId,
    );
    if (!hasState || hasState.cnt === 0) {
      logger.info({ connectionId }, 'Skipping cron sync — plugin not initialized yet');
      return null;
    }
  }

  const group = database.groups.findById(conn.group_id);
  if (!group) {
    logger.warn({ groupId: conn.group_id }, 'Group not found for connection');
    return null;
  }

  // Floor to start of yesterday so timezone-bucketed APIs (e.g. TBC-GE Georgia midnight
  // = UTC 20:00 prev day) don't get filtered out by a precise intra-day timestamp.
  // Computed here, before the shim-mutex wait, so the window does not drift with queue time.
  const fromDate = conn.last_sync_at
    ? startOfDay(subDays(new Date(conn.last_sync_at), 1))
    : startOfDay(subDays(new Date(), 30));
  const toDate = new Date();

  return { connectionId, conn, group, plugin, preferences, allowOtp, fromDate, toDate };
}

/** Edits the bank panel message with a transient progress line; failures are ignored. */
async function editPanelProgress(group: Group, panelMsgId: number, text: string): Promise<void> {
  await withChatContext(group.telegram_group_id, null, () =>
    editMessageText(panelMsgId, text),
  ).catch(() => {});
}

/**
 * Runs the plugin under the global shim mutex and returns everything it produced.
 * The mutex is released (and any pending OTP request cancelled) even when the plugin throws.
 */
async function scrapeBank(ctx: SyncContext): Promise<ScrapeResult> {
  const { conn, group } = ctx;

  // shimRef allows the readLine bridge to reference the shim before it is created.
  const shimRef: { current: ZenMoneyShim | null } = { current: null };
  const mutex: ShimMutexHandle = { release: () => {} };
  const readLineImpl = createReadLineBridge(ctx, mutex, shimRef);

  // Serialize plugin execution — globalThis.ZenMoney is shared and not concurrency-safe.
  await acquireShimMutex(mutex);

  // Show connecting progress now that we have the mutex and are about to scrape.
  if (conn.panel_message_id) {
    await editPanelProgress(
      group,
      conn.panel_message_id,
      `⌛ ${escapeHtml(conn.display_name)} — Подключаемся...`,
    );
  }

  try {
    return await runPluginScrape(ctx, shimRef, readLineImpl);
  } finally {
    delete (globalThis as { ZenMoney?: unknown }).ZenMoney;
    mutex.release(); // release before cancelling OTP so other syncs can queue up
    cancelOtpRequest(ctx.connectionId); // clean up if plugin exited without consuming the OTP
  }
}

/** Installs the ZenMoney shim globals, runs the plugin's scrape() and merges every result channel. */
async function runPluginScrape(
  ctx: SyncContext,
  shimRef: { current: ZenMoneyShim | null },
  readLineImpl: (prompt: string) => Promise<string>,
): Promise<ScrapeResult> {
  const { connectionId, conn, plugin, preferences, fromDate, toDate } = ctx;

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
  logger.info(
    {
      connectionId,
      bank: conn.bank_name,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
    },
    'Starting scrape',
  );
  const rawResult = (await scrape({ preferences, fromDate, toDate })) as
    | Partial<ScrapeResult>
    | undefined;

  const accounts = [
    ...(rawResult?.accounts ?? []),
    ...(shim._getCollectedAccounts() as ZenAccount[]),
  ];
  const transactions = [
    ...(rawResult?.transactions ?? []),
    ...(shim._getCollectedTransactions() as ZenTransaction[]),
  ];
  logger.info(
    { connectionId, bank: conn.bank_name, rawTxCount: transactions.length },
    'Scrape returned',
  );

  const setResultData = shim._getSetResult() as Partial<ScrapeResult> | undefined;
  if (setResultData) {
    accounts.push(...(setResultData.accounts ?? []));
    transactions.push(...(setResultData.transactions ?? []));
  }
  return { accounts, transactions };
}

/**
 * Builds the readLine() implementation handed to the plugin shim. For manual syncs it asks
 * the user for an OTP in Telegram while temporarily giving up the shim mutex.
 */
function createReadLineBridge(
  ctx: SyncContext,
  mutex: ShimMutexHandle,
  shimRef: { current: ZenMoneyShim | null },
): (prompt: string) => Promise<string> {
  const { connectionId, conn, group } = ctx;

  return async (prompt: string): Promise<string> => {
    logger.info({ connectionId, prompt }, 'Plugin requesting interactive input (readLine)');

    if (!ctx.allowOtp) {
      // Cron sync — don't interrupt user with automatic OTP requests.
      throw new Error(OTP_REQUIRED_MESSAGE);
    }

    // Prefer the bank panel thread; fall back to the group's active topic so the
    // prompt is visible where the user actually reads messages.
    const otpThreadId = conn.panel_message_thread_id ?? group.active_topic_id;
    const promptMsgId = await sendOtpPrompt(ctx, prompt, otpThreadId);

    // Release the global shim mutex while waiting for user OTP input so other sync
    // cycles are not blocked for the full 5-minute OTP wait window.
    delete (globalThis as { ZenMoney?: unknown }).ZenMoney;
    const releaseBeforeOtp = mutex.release;
    mutex.release = () => {}; // guard against double-release from finally
    releaseBeforeOtp();

    const code = await awaitOtpCode(ctx, promptMsgId);

    // Send a new "accepted" message — keep the original credentials panel intact
    // so the final sync status continues to edit it.
    await withChatContext(group.telegram_group_id, otpThreadId, () =>
      sendMessage('⌛ Принято, синхронизируем...'),
    ).catch(() => {});

    // Re-acquire the global shim mutex before the plugin resumes execution.
    await acquireShimMutex(mutex);
    if (shimRef.current) {
      (globalThis as { ZenMoney?: unknown }).ZenMoney = shimRef.current;
    }

    return code;
  };
}

/** Sends the OTP prompt and returns its message id (null when sending produced no message). */
async function sendOtpPrompt(
  ctx: SyncContext,
  prompt: string,
  otpThreadId: number | null,
): Promise<number | null> {
  const { conn, group } = ctx;
  const hint = getOtpHint(conn.bank_name, prompt);
  const otpText = `🔐 ${escapeHtml(conn.display_name)} — код подтверждения\n\n${escapeHtml(prompt)}${hint ? `\n\n💡 ${escapeHtml(hint)}` : ''}\n\nОтправь код сюда (есть 5 минут).`;

  // Always send a new message for OTP prompts so it doesn't overwrite the
  // credentials panel that is still visible above in the chat.
  const sent = await withChatContext(group.telegram_group_id, otpThreadId, () =>
    sendMessage(otpText),
  );
  return sent?.message_id ?? null;
}

/** Waits for the user's OTP; on timeout turns the prompt message into a retry button. */
async function awaitOtpCode(ctx: SyncContext, promptMsgId: number | null): Promise<string> {
  const { connectionId, group } = ctx;
  try {
    return await registerOtpRequest(connectionId, group.telegram_group_id);
  } catch (err) {
    // OTP timed out — edit the prompt message to offer a retry button.
    if (promptMsgId && err instanceof Error && err.message.includes('истекло')) {
      await withChatContext(group.telegram_group_id, null, () =>
        editMessageText(
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
        ),
      ).catch(() => {});
    }
    throw err;
  }
}

/** Scrape done — re-read panel_message_id (OTP handler may have updated it) and show
 *  intermediate progress so the user sees we're still working. */
async function showProcessingProgress(ctx: SyncContext, txCount: number): Promise<void> {
  const connAfterScrape = database.bankConnections.findById(ctx.connectionId);
  if (!connAfterScrape?.panel_message_id) return;

  const txInfo = txCount > 0 ? `\n\nПолучено транзакций: ${txCount}` : '';
  await editPanelProgress(
    ctx.group,
    connAfterScrape.panel_message_id,
    `⌛ ${escapeHtml(ctx.conn.display_name)} — Обрабатываем данные...${txInfo}`,
  );
}

/** Normalizes transactions from ZenPlugins movements-based format to our flat ZenTransaction. */
function normalizeScrapedTransactions(scraped: ScrapeResult): ZenTransaction[] {
  // Build account currency map for ZenPlugins-format transaction normalization
  const accountCurrencyMap = new Map<string, string>();
  for (const acc of scraped.accounts) {
    const currency = acc.instrument ?? acc.currency ?? '';
    if (currency) accountCurrencyMap.set(acc.id, currency);
  }

  const normalizedTransactions: ZenTransaction[] = [];
  for (const rawTx of scraped.transactions) {
    const normalized = normalizePluginsTransaction(rawTx, accountCurrencyMap);
    if (normalized !== null) normalizedTransactions.push(normalized);
  }
  return normalizedTransactions;
}

function upsertAccounts(connectionId: number, accounts: ZenAccount[]): void {
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
}

/**
 * Transaction sync is opt-in per group (bank_cards_enabled). When off, the
 * cycle is balance-only: accounts/balances are still upserted so /bank
 * shows the balance, but transactions are neither stored nor carded — so no
 * pending backlog accumulates while cards are off.
 */
async function syncTransactionsIfEnabled(
  ctx: SyncContext,
  transactions: ZenTransaction[],
): Promise<void> {
  const { connectionId, group, conn } = ctx;
  if (!group.bank_cards_enabled) {
    logger.info(
      { connectionId, groupId: group.id, transactions: transactions.length },
      'Bank cards disabled for group — balance-only sync, transactions skipped',
    );
    return;
  }

  // Load approved merchant rules once for this cycle
  const approvedRules = database.merchantRules.findApproved();
  const today = format(new Date(), 'yyyy-MM-dd');

  // Phase 1: insert all transactions into DB
  const newPendingTxs: BankTransaction[] = [];
  for (const tx of transactions) {
    const inserted = insertBankTransaction(connectionId, tx, approvedRules);
    if (inserted) newPendingTxs.push(inserted);
  }

  // Phase 2+3: AI prefill, per-tx confirmation cards, and old-tx summary
  await pushAutomaticCards(newPendingTxs, conn, group, today);
}

/** Stores one scraped transaction; returns the new row only when it is a freshly inserted pending debit. */
function insertBankTransaction(
  connectionId: number,
  tx: ZenTransaction,
  approvedRules: MerchantRule[],
): BankTransaction | null {
  const amount = Math.abs(tx.sum);
  if (amount === 0) return null;

  const signType = determineSignType(tx);
  // Credit/incoming transactions are stored for reference but not confirmed as expenses
  const status: BankTransaction['status'] = signType === 'debit' ? 'pending' : 'skipped_reversal';

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

  return inserted && status === 'pending' ? inserted : null;
}

/** Update panel message with fresh status after a successful sync. */
async function refreshPanelAfterSync(ctx: SyncContext): Promise<void> {
  const freshConn = database.bankConnections.findById(ctx.connectionId);
  if (!freshConn?.panel_message_id) return;

  const panelMsgId = freshConn.panel_message_id;
  const panelText = buildBankStatusText(freshConn);
  const keyboard = buildBankManageKeyboard(freshConn);
  await withChatContext(ctx.group.telegram_group_id, null, () =>
    editMessageText(panelMsgId, panelText, {
      reply_markup: { inline_keyboard: keyboard },
    }),
  ).catch((err) => logger.warn({ err }, 'Failed to update panel message after sync'));
}

/**
 * Routes a failed cycle: OTP events are not bank-side failures and don't count against
 * consecutive_failures; everything else goes through handleSyncError.
 */
async function handleCycleError(
  connectionId: number,
  conn: BankConnection,
  error: unknown,
): Promise<void> {
  if (error instanceof Error && error.message.includes('истекло')) {
    logger.info({ connectionId }, 'OTP not entered in time — sync paused until user retries');
    return;
  }
  if (error instanceof Error && error.message === OTP_REQUIRED_MESSAGE) {
    logger.info({ connectionId }, 'OTP required for cron sync — notifying user to sync manually');
    await notifyManualSyncNeeded(connectionId, conn);
    return;
  }
  await handleSyncError(connectionId, conn, error);
}

/** Tells the user (panel edit, else a new thread message) that a code is needed for syncing. */
async function notifyManualSyncNeeded(connectionId: number, conn: BankConnection): Promise<void> {
  const notifyGroup = database.groups.findById(conn.group_id);
  const freshConn = database.bankConnections.findById(connectionId);
  if (!freshConn || !notifyGroup) return;

  const threadId = freshConn.panel_message_thread_id ?? notifyGroup.active_topic_id;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Синхронизировать', callback_data: `bank_sync:${connectionId}` }],
    ],
  };
  if (freshConn.panel_message_id) {
    const panelMsgId = freshConn.panel_message_id;
    await withChatContext(notifyGroup.telegram_group_id, null, () =>
      editMessageText(
        panelMsgId,
        `🔐 ${escapeHtml(conn.display_name)} — для синхронизации нужен код`,
        { reply_markup: keyboard },
      ),
    ).catch(() => {});
  } else if (threadId !== null) {
    await withChatContext(notifyGroup.telegram_group_id, threadId, () =>
      sendMessage(
        `🔐 ${escapeHtml(conn.display_name)} — требует код. Нажми кнопку для синхронизации.`,
        { reply_markup: keyboard },
      ),
    ).catch(() => {});
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

  // Always update the panel message to reflect the new error state
  const freshConn = database.bankConnections.findById(connectionId);
  if (freshConn?.panel_message_id && group) {
    const panelMsgId = freshConn.panel_message_id;
    await withChatContext(group.telegram_group_id, null, () =>
      editMessageText(panelMsgId, buildBankStatusText(freshConn), {
        reply_markup: { inline_keyboard: buildBankManageKeyboard(freshConn) },
      }),
    ).catch((err) => logger.warn({ err }, 'Failed to update panel message after error'));
  }

  // Send alert only on the 3rd failure (not on every subsequent failure)
  if (failures === MAX_CONSECUTIVE_FAILURES) {
    if (group) {
      await withChatContext(group.telegram_group_id, group.active_topic_id, () =>
        sendMessage(
          `⚠️ ${escapeHtml(conn.display_name)} — ошибка синхронизации\n\nНе удаётся подключиться 3 раза подряд.\nПоследняя ошибка: ${escapeHtml(message)}\n\nВозможно, изменился пароль или истекла сессия.\n/bank ${escapeHtml(conn.bank_name)} — переподключить`,
        ),
      ).catch((e) => logger.error({ err: e }, 'Failed to send escalation alert'));
    }
  }
}

type PluginsMovement = ZenPluginsTransaction['movements'][number];

/** Raw ZenPlugins dates are Date objects or strings; ISO string for Dates. */
function rawDateToString(date: ZenPluginsTransaction['date']): string {
  return date instanceof Date ? date.toISOString() : String(date);
}

/** movement.id can be null for some transaction types (e.g. unresolved holds).
 *  Generate a deterministic synthetic ID so they are not silently dropped.
 *  Known collision risk: two different holds for identical sum+timestamp+account
 *  on the same ms — second one is silently deduped by insertIgnore. Accepted. */
function movementId(
  movement: PluginsMovement,
  date: ZenPluginsTransaction['date'],
  accId: string,
): string {
  if (movement.id !== null && movement.id !== undefined) return movement.id;
  const dateKey = date instanceof Date ? date.getTime() : String(date);
  return Buffer.from(`synthetic:${movement.sum ?? 0}:${dateKey}:${accId}`).toString('base64');
}

/** Populates invoice fields when the operation currency differs from the account currency.
 *  Both sum and invoice.sum follow ZenMoney sign convention (negative = debit). */
function applyInvoice(result: ZenTransaction, movement: PluginsMovement, currency: string): void {
  if (movement.invoice && movement.invoice.instrument !== currency) {
    result.invoice_sum = Math.abs(movement.invoice.sum);
    result.invoice_currency = movement.invoice.instrument;
  }
}

function applyMerchant(result: ZenTransaction, merchant: ZenPluginsTransaction['merchant']): void {
  if (merchant === null || merchant === undefined) return;
  const title = 'title' in merchant ? (merchant as Merchant).title : merchant.fullTitle;
  if (title) result.merchant = title;
  if (merchant.mcc !== null) result.mcc = merchant.mcc;
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

  const acc = movement.account;
  const accId = 'id' in acc ? acc.id : '';
  const id = movementId(movement, raw.date, accId);

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

  const result: ZenTransaction = { id, sum, currency, date: rawDateToString(raw.date) };

  if (accId) result.account = accId;
  applyInvoice(result, movement, currency);
  applyMerchant(result, raw.merchant);
  if (raw.comment) result.comment = raw.comment;

  return result;
}

function determineSignType(tx: ZenTransaction): 'debit' | 'credit' | 'reversal' {
  if (tx.sum < 0) return 'debit';
  return 'credit';
}

function applyMerchantRules(merchant: string | undefined, rules: MerchantRule[]): string | null {
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

/** Stores AI-prefilled categories for the new pending transactions. */
function storePrefills(newPendingTxs: BankTransaction[], prefillResults: PrefillResult[]): void {
  for (let i = 0; i < newPendingTxs.length; i++) {
    const tx = newPendingTxs[i];
    const prefilled = prefillResults[i];
    if (tx && prefilled) {
      database.bankTransactions.setPrefill(tx.id, prefilled.category, '');
    }
  }
}

function isFromExcludedAccount(tx: BankTransaction, connectionId: number): boolean {
  if (!tx.account_id) return false;
  const accounts = database.bankAccounts.findByConnectionId(connectionId);
  const account = accounts.find((a) => a.account_id === tx.account_id);
  return account?.is_excluded === 1;
}

/** Sends one confirmation card for today's transaction and records its Telegram message id. */
async function sendTodayCard(
  inserted: BankTransaction,
  category: string,
  conn: BankConnection,
  group: Group,
): Promise<void> {
  // Large transaction: compare EUR equivalent to threshold
  const amountInEur = convertAnyToEUR(inserted.amount, inserted.currency);
  const isLarge = amountInEur >= env.LARGE_TX_THRESHOLD_EUR;

  const cardText = formatConfirmationCard(inserted, category, conn.display_name, isLarge);

  const result = await withChatContext(group.telegram_group_id, conn.panel_message_thread_id, () =>
    sendMessage(cardText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Принять', callback_data: `bank_confirm:${inserted.id}` },
            { text: '✏️ Исправить', callback_data: `bank_edit:${inserted.id}` },
          ],
        ],
      },
    }),
  );

  if (result) {
    database.bankTransactions.setTelegramMessageId(inserted.id, result.message_id);
  }
}

/**
 * Runs the chat-card steps of a sync cycle: AI-prefill the new pending
 * transactions, push a confirmation card for each of today's, and send an
 * old-tx summary for the rest. Called only when the group has bank cards
 * enabled (the gate lives in runSyncCycle).
 */
async function pushAutomaticCards(
  newPendingTxs: BankTransaction[],
  conn: BankConnection,
  group: Group,
  today: string,
): Promise<void> {
  // Phase 2: batch AI pre-fill for all new pending transactions
  const prefillResults = await preFillTransactions(newPendingTxs, group.id);
  storePrefills(newPendingTxs, prefillResults);

  // Phase 3: send confirmation cards — only for today's transactions
  for (let i = 0; i < newPendingTxs.length; i++) {
    const inserted = newPendingTxs[i];
    const prefilled = prefillResults[i];
    if (!inserted || !prefilled) continue;

    // Skip cards for old transactions — stored in DB but no card sent
    if (inserted.date !== today) continue;

    // Skip cards for transactions from excluded accounts
    if (isFromExcludedAccount(inserted, conn.id)) continue;

    await sendTodayCard(inserted, prefilled.category, conn, group);
  }

  // Notify about old (non-today) transactions that were inserted this cycle
  const oldTxsWithPrefill = newPendingTxs
    .map((tx, i) => ({
      tx,
      category: prefillResults[i]?.category ?? tx.prefill_category ?? '—',
    }))
    .filter(({ tx }) => tx.date !== today);
  if (oldTxsWithPrefill.length > 0) {
    await notifyOldTransactions(oldTxsWithPrefill, conn, group);
  }
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

  const amountStr =
    tx.invoice_amount != null && tx.invoice_currency
      ? `${formatAmount(tx.invoice_amount, tx.invoice_currency)} (${formatAmount(tx.amount, tx.currency)})`
      : formatAmount(tx.amount, tx.currency);

  return `${prefix} ${escapeHtml(bankName)} — ${amountStr}
📅 ${dateTime}
📍 ${merchant}
🗂 Категория: ${escapeHtml(category)}${mccLine}`;
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
 * Sends a summary of newly inserted old (non-today) transactions with show/skip buttons.
 * Called from runSyncCycle after Phase 3 when old pending txs are detected.
 */
export async function notifyOldTransactions(
  txsWithPrefill: { tx: BankTransaction; category: string }[],
  conn: BankConnection,
  group: Group,
): Promise<void> {
  if (txsWithPrefill.length === 0) return;

  const text = buildOldTxSummaryText(txsWithPrefill, conn.display_name);
  const threadId = conn.panel_message_thread_id ?? group.active_topic_id;

  await withChatContext(group.telegram_group_id, threadId, () =>
    sendMessage(text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📋 Показать', callback_data: `bank_show_old:${conn.id}` },
            { text: '🗑 Пропустить', callback_data: `bank_skip_old:${conn.id}` },
          ],
        ],
      },
    }),
  );
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
  await withChatContext(group.telegram_group_id, cardThreadId, async () => {
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
  await withChatContext(group.telegram_group_id, skipThreadId, async () => {
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
