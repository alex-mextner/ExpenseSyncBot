# Bank Integration Implementation Plan — Part 4/7: Tasks 10-14: ZenPlugin shim, Telegram sender, AI pre-fill, sync, merchant normalization

[← Back to index](../2026-03-27-bank-integration.md)

## Task 11: Telegram sender (bank-sync direct API calls)

**Files:**

- Create: `src/services/bank/telegram-sender.ts`

- [ ] **Step 1: Create `src/services/bank/telegram-sender.ts`**

```typescript
// Send-only Telegram Bot API client for the bank-sync service.
// The main bot handles incoming updates; bank-sync uses this to send notifications only.
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('telegram-sender');

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageResult {
  message_id: number;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function telegramRequest<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as TelegramResponse<T>;
    if (!data.ok) {
      logger.warn({ method, description: data.description }, 'Telegram API call failed');
      return null;
    }
    return data.result ?? null;
  } catch (error) {
    logger.error({ err: error, method }, 'Telegram API request error');
    return null;
  }
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: {
    message_thread_id?: number;
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  return telegramRequest<SendMessageResult>(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export async function editMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  options?: {
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<void> {
  await telegramRequest(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export async function deleteMessage(
  botToken: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  await telegramRequest(botToken, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/telegram-sender.ts
git commit -m "feat(bank): direct Telegram API sender for bank-sync"
```

---

## Task 12: AI transaction pre-fill

**Files:**

- Create: `src/services/bank/prefill.ts`

- [ ] **Step 1: Create `src/services/bank/prefill.ts`**

```typescript
// AI pre-fill for bank transactions — suggests category and comment before showing confirmation card.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import type { BankTransaction } from '../../database/types';

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
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/prefill.ts
git commit -m "feat(bank): AI transaction pre-fill (category + comment)"
```

---

## Task 13: Sync service

**Files:**

- Create: `src/services/bank/sync-service.ts`

- [ ] **Step 1: Create `src/services/bank/sync-service.ts`**

```typescript
// Bank sync service — runs as a separate PM2 process.
// Polls bank APIs every 30 min, upserts accounts/transactions, sends confirmation cards.
import { subDays } from 'date-fns';
import { database } from '../../database';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { decryptData } from '../../utils/crypto';
import { BANK_REGISTRY } from './registry';
import type { ScrapeResult, ZenAccount, ZenTransaction } from './registry';
import { createZenMoneyShim } from './runtime';
import { sendMessage } from './telegram-sender';
import { preFillTransaction } from './prefill';
import type { BankConnection } from '../../database/types';

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

    const preferences = JSON.parse(decryptData(credentials.encrypted_data)) as Record<string, string>;

    const fromDate = conn.last_sync_at ? new Date(conn.last_sync_at) : subDays(new Date(), 30);
    const toDate = new Date();

    // Set up ZenMoney shim and run scrape
    const shim = createZenMoneyShim(connectionId, database.db, preferences);
    (globalThis as { ZenMoney?: typeof shim }).ZenMoney = shim;

    const { scrape } = await plugin.plugin();
    const rawResult = (await scrape({ preferences, fromDate, toDate })) as Partial<ScrapeResult> | undefined;

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

      const signType = determinSignType(tx);
      const status = signType === 'reversal' ? 'skipped_reversal' : 'pending';

      // Apply merchant normalization
      const merchantNormalized = applyMerchantRules(tx.merchant, approvedRules);

      const inserted = database.bankTransactions.insertIgnore({
        connection_id: connectionId,
        external_id: tx.id,
        date: tx.date.includes('T') ? tx.date.split('T')[0] : tx.date,
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

      const isLarge =
        tx.currency === 'EUR'
          ? amount >= env.LARGE_TX_THRESHOLD_EUR
          : false; // Simple check — extend with currency conversion if needed

      const cardText = formatConfirmationCard(inserted, prefilled, conn.display_name, isLarge);

      const result = await sendMessage(env.BOT_TOKEN, group.telegram_group_id, cardText, {
        message_thread_id: conn.panel_message_thread_id ?? undefined,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Принять', callback_data: `bank_confirm:${inserted.id}` },
            { text: '✏️ Исправить', callback_data: `bank_edit:${inserted.id}` },
          ]],
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

function determinSignType(tx: ZenTransaction): 'debit' | 'credit' | 'reversal' {
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
  tx: import('../../database/types').BankTransaction,
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
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/sync-service.ts
git commit -m "feat(bank): sync service — scrape loop, confirmation cards, error escalation"
```

---

## Task 14: Merchant normalization agent

**Files:**

- Create: `src/services/bank/merchant-agent.ts`

- [ ] **Step 1: Create `src/services/bank/merchant-agent.ts`**

```typescript
// Merchant normalization AI agent — batch-processes unmatched merchant strings
// into pending_review rules. Runs after each sync cycle and on new rule requests.
// Only active when BOT_ADMIN_CHAT_ID is configured.
import Anthropic from '@anthropic-ai/sdk';
import { database } from '../../database';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { sendMessage } from './telegram-sender';
import type { MerchantRuleRequest } from '../../database/types';

const logger = createLogger('merchant-agent');

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

interface AiRuleSuggestion {
  pattern: string;
  replacement: string;
  category: string | null;
  confidence: number;
}

/**
 * Process unmatched merchant strings and generate normalization rules.
 * No-op if BOT_ADMIN_CHAT_ID is not configured.
 */
export async function processMerchantRequests(): Promise<void> {
  if (!env.BOT_ADMIN_CHAT_ID) return;
  if (!env.ANTHROPIC_API_KEY) return;

  const requests = database.merchantRules.findUnprocessedRequests();
  if (requests.length === 0) return;

  logger.info({ count: requests.length }, 'Processing merchant rule requests');

  // Collect existing approved rules for context
  const existingRules = database.merchantRules.findApproved().map((r) => ({
    pattern: r.pattern,
    replacement: r.replacement,
    category: r.category,
  }));

  // Batch: up to 20 at a time
  const batch = requests.slice(0, 20);

  const suggestions = await callAiForRules(batch, existingRules);

  for (let i = 0; i < batch.length; i++) {
    const request = batch[i];
    const suggestion = suggestions[i];

    database.merchantRules.markRequestProcessed(request.id);

    if (!suggestion) continue;

    // Insert rule with pending_review status
    const rule = database.merchantRules.insert({
      pattern: suggestion.pattern,
      replacement: suggestion.replacement,
      category: suggestion.category,
      confidence: suggestion.confidence,
      source: 'ai',
    });

    // Find example matches from existing transactions
    const examples = findExampleMatches(request.merchant_raw, suggestion.pattern, suggestion.replacement);

    // Send admin approval card
    await sendAdminApprovalCard(rule.id, suggestion, examples);
  }

  // Prune old processed requests
  database.merchantRules.pruneOldRequests();
}

async function callAiForRules(
  requests: MerchantRuleRequest[],
  existingRules: { pattern: string; replacement: string; category: string | null }[],
): Promise<(AiRuleSuggestion | null)[]> {
  const merchantList = requests
    .map((r, i) => `${i + 1}. "${r.merchant_raw}"${r.mcc ? ` (MCC: ${r.mcc})` : ''}${r.user_category ? ` → категория пользователя: ${r.user_category}` : ''}`)
    .join('\n');

  const existingList = existingRules
    .slice(0, 10)
    .map((r) => `"${r.pattern}" → "${r.replacement}"${r.category ? ` [${r.category}]` : ''}`)
    .join('\n');

  const prompt = `Создай правила нормализации для этих строк мерчантов.

Мерчанты для обработки:
${merchantList}

Существующие правила (для согласованности):
${existingList || '(пусто)'}

Для каждого мерчанта ответь JSON массивом с ${requests.length} объектами:
[{
  "pattern": "GLOVO.*",       // regexp для нормализации (пиши .*  для захвата суффиксов)
  "replacement": "Glovo",     // нормализованное название
  "category": "еда",          // категория расхода или null
  "confidence": 0.95          // уверенность 0.0-1.0
}, ...]

Возвращай ровно ${requests.length} объектов в том же порядке.`;

  try {
    const response = await getClient().messages.create({
      model: env.AI_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');

    const parsed = JSON.parse(match[0]) as AiRuleSuggestion[];
    return parsed;
  } catch (error) {
    logger.error({ err: error }, 'AI merchant rule generation failed');
    return requests.map(() => null);
  }
}

function findExampleMatches(
  merchantRaw: string,
  pattern: string,
  replacement: string,
): string[] {
  try {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(merchantRaw)) {
      return [`"${merchantRaw}" → "${replacement}"`];
    }
  } catch {
    // ignore invalid regex
  }
  return [];
}

async function sendAdminApprovalCard(
  ruleId: number,
  suggestion: AiRuleSuggestion,
  examples: string[],
): Promise<void> {
  if (!env.BOT_ADMIN_CHAT_ID) return;

  const exampleLines = examples.length > 0
    ? `\n\nПримеры совпадений:\n${examples.map((e) => `• ${e}`).join('\n')}`
    : '';

  const text = `🔧 Новое правило для мерчанта\n\nПаттерн: <code>${suggestion.pattern}</code>\n→ <b>${suggestion.replacement}</b>\n🗂 Категория: ${suggestion.category ?? '—'}\n📊 Уверенность: ${Math.round(suggestion.confidence * 100)}%${exampleLines}`;

  await sendMessage(env.BOT_TOKEN, env.BOT_ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Принять', callback_data: `merchant_approve:${ruleId}` },
        { text: '✏️ Исправить', callback_data: `merchant_edit:${ruleId}` },
        { text: '❌ Отклонить', callback_data: `merchant_reject:${ruleId}` },
      ]],
    },
  }).catch((e) => logger.error({ err: e }, 'Failed to send admin approval card'));
}
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/merchant-agent.ts
git commit -m "feat(bank): merchant normalization AI agent"
```

---

