# Bank Integration Implementation Plan — Part 5/7: Tasks 15-16: AI bank tools, confirmation/edit flows

[← Back to index](../2026-03-27-bank-integration.md)

## Task 15: AI bank tools

**Files:**

- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`

- [ ] **Step 1: Write a test for the new tools**

```typescript
// src/services/ai/bank-tools.test.ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from '../../database/repositories/group.repository';
import { BankConnectionsRepository } from '../../database/repositories/bank-connections.repository';
import { BankAccountsRepository } from '../../database/repositories/bank-accounts.repository';
import { BankTransactionsRepository } from '../../database/repositories/bank-transactions.repository';
import { executeTool } from './tool-executor';
import type { AgentContext } from './types';

let db: Database;
let groupId: number;

db = createTestDb();
const groupRepo = new GroupRepository(db);
const connRepo = new BankConnectionsRepository(db);
const accRepo = new BankAccountsRepository(db);
const txRepo = new BankTransactionsRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

// Mock the database singleton to use our test db
import { database } from '../../database';
// Note: in integration tests we override database.bankTransactions etc. via the same db

describe('bank AI tools', () => {
  // These tests verify the tool returns structured results; actual AI calls are not made.
  test('get_bank_balances returns empty list when no connections', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      defaultCurrency: 'EUR',
      bot: null as never,
      ctx: null as never,
    };
    const result = await executeTool('get_bank_balances', {}, ctx);
    expect(result.success).toBe(true);
  });

  test('get_bank_transactions returns empty list when no transactions', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      defaultCurrency: 'EUR',
      bot: null as never,
      ctx: null as never,
    };
    const result = await executeTool('get_bank_transactions', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
  });

  test('find_missing_expenses returns no missing when no transactions', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      defaultCurrency: 'EUR',
      bot: null as never,
      ctx: null as never,
    };
    const result = await executeTool('find_missing_expenses', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/ai/bank-tools.test.ts
```

Expected: FAIL — tools don't exist yet.

- [ ] **Step 3: Add tool definitions to `src/services/ai/tools.ts`**

Append to the `TOOL_DEFINITIONS` array (after the `manage_category` tool):

```typescript
  {
    name: 'get_bank_transactions',
    description:
      'Get bank transactions for a period. All results are scoped to this group only. Use to answer questions about bank spending or reconciliation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description: '"current_month" | "last_month" | "YYYY-MM"',
        },
        bank_name: {
          type: 'string',
          description: 'Filter by bank registry key (e.g. "tbc"). Omit for all banks.',
        },
        status: {
          type: 'string',
          description: '"pending" | "confirmed" | "skipped" — omit for all statuses.',
        },
      },
    },
  },
  {
    name: 'get_bank_balances',
    description:
      'Get current account balances from all connected banks for this group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bank_name: {
          type: 'string',
          description: 'Optional: filter to specific bank registry key.',
        },
      },
    },
  },
  {
    name: 'find_missing_expenses',
    description:
      'Compare bank transactions vs recorded expenses. Returns unmatched bank debit transactions that may be missing from the expense log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description: '"current_month" | "last_month" | "YYYY-MM"',
        },
      },
    },
  },
```

- [ ] **Step 4: Add tool implementations to `src/services/ai/tool-executor.ts`**

In the `switch (name)` block, before the `default` case, add:

```typescript
      case 'get_bank_transactions':
        return executeGetBankTransactions(input, ctx);
      case 'get_bank_balances':
        return executeGetBankBalances(input, ctx);
      case 'find_missing_expenses':
        return await executeFindMissingExpenses(input, ctx);
```

At end of file, add:

```typescript
function executeGetBankTransactions(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const filters = {
    period: typeof input['period'] === 'string' ? input['period'] : undefined,
    bank_name: typeof input['bank_name'] === 'string' ? input['bank_name'] : undefined,
    status: typeof input['status'] === 'string'
      ? (input['status'] as import('../../database/types').BankTransaction['status'])
      : undefined,
  };

  const transactions = database.bankTransactions.findByGroupId(ctx.groupId, filters);

  return {
    success: true,
    data: transactions.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      category_suggestion: null, // populated by prefill at confirmation time
      status: tx.status,
      sign_type: tx.sign_type,
    })),
  };
}

function executeGetBankBalances(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const bankName = typeof input['bank_name'] === 'string' ? input['bank_name'] : undefined;

  const accounts = database.bankAccounts.findByGroupId(ctx.groupId);
  const filtered = bankName
    ? accounts.filter((a) => {
        const conn = database.bankConnections.findById(a.connection_id);
        return conn?.bank_name === bankName;
      })
    : accounts;

  return {
    success: true,
    data: filtered.map((a) => ({
      bank_name: database.bankConnections.findById(a.connection_id)?.bank_name,
      account_title: a.title,
      balance: a.balance,
      currency: a.currency,
      type: a.type,
    })),
  };
}

async function executeFindMissingExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const period = typeof input['period'] === 'string' ? input['period'] : 'current_month';
  const { startDate, endDate } = resolvePeriodDates(period);

  const unmatched = database.bankTransactions.findUnmatched(ctx.groupId, startDate, endDate);
  const expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

  const results = unmatched.map((tx) => {
    // Try fuzzy match against expenses
    const exactMatch = expenses.find(
      (e) =>
        Math.abs(e.amount - tx.amount) < 0.01 &&
        e.currency === tx.currency &&
        Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 2 * 86400 * 1000,
    );

    if (exactMatch) {
      database.bankTransactions.setMatchedExpense(tx.id, ctx.groupId, exactMatch.id);
      return null; // matched
    }

    const probableMatch = expenses.find(
      (e) =>
        Math.abs(e.amount - tx.amount) < 0.01 &&
        e.currency === tx.currency &&
        Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 5 * 86400 * 1000,
    );

    return {
      tx_id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      status: probableMatch ? 'probable_match' : 'missing',
      probable_expense_id: probableMatch?.id ?? null,
    };
  });

  const missing = results.filter(Boolean);

  return {
    success: true,
    data: missing,
    summary: `${missing.length} транзакций без записи в расходах за период ${startDate}–${endDate}`,
  };
}

function resolvePeriodDates(period: string): { startDate: string; endDate: string } {
  const now = new Date();
  if (period === 'current_month') {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay}` };
  }
  if (period === 'last_month') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, d.getMonth() + 1, 0).getDate();
    return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay}` };
  }
  const [year, month] = period.split('-').map(Number);
  if (year && month) {
    const lastDay = new Date(year, month, 0).getDate();
    return {
      startDate: `${year}-${String(month).padStart(2, '0')}-01`,
      endDate: `${year}-${String(month).padStart(2, '0')}-${lastDay}`,
    };
  }
  return { startDate: '2000-01-01', endDate: '2099-12-31' };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test src/services/ai/bank-tools.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/bank-tools.test.ts
git commit -m "feat(bank): AI bank tools — get_bank_transactions, get_bank_balances, find_missing_expenses"
```

---

## Task 16: Confirmation flow + edit flow handlers

**Files:**

- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Add bank callback cases to `callback.handler.ts`**

At the end of the imports section, add:

```typescript
import { handleBankConfirmCallback, handleBankEditCallback } from '../commands/bank';
```

In the `switch (action)` block, add before the `default` case:

```typescript
      case 'bank_confirm': {
        const txId = Number(params[0]);
        if (!chatId || !txId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        await handleBankConfirmCallback(ctx, txId, chatId);
        break;
      }

      case 'bank_edit': {
        const txId = Number(params[0]);
        if (!chatId || !txId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        await handleBankEditCallback(ctx, txId, chatId);
        break;
      }

      case 'merchant_approve': {
        const ruleId = Number(params[0]);
        if (!ruleId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        database.merchantRules.updateStatus(ruleId, 'approved');
        await ctx.answerCallbackQuery({ text: '✅ Правило принято' });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        break;
      }

      case 'merchant_reject': {
        const ruleId = Number(params[0]);
        if (!ruleId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        database.merchantRules.updateStatus(ruleId, 'rejected');
        await ctx.answerCallbackQuery({ text: '❌ Правило отклонено' });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        break;
      }

      case 'merchant_edit': {
        const ruleId = Number(params[0]);
        if (!ruleId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        await ctx.answerCallbackQuery();
        await ctx.reply('Ответь на это сообщение — напиши исправленное название (или "название|категория"):');
        // TODO: implement reply-based edit for merchant rules (out of scope for this task)
        break;
      }
```

- [ ] **Step 2: Add edit-flow routing to `message.handler.ts`**

Find the section in `handleExpenseMessage` that handles group messages. Add this block early in the function, before the expense parsing logic:

```typescript
  // Bank transaction edit flow — route replies to pending edit transactions
  const replyToMessageId = ctx.replyToMessage?.id;
  if (isGroup && replyToMessageId && text) {
    const { handleBankEditReply } = await import('../commands/bank');
    const chatId = ctx.chat?.id;
    if (chatId) {
      const handled = await handleBankEditReply(ctx, replyToMessageId, chatId, text);
      if (handled) return;
    }
  }
```

- [ ] **Step 3: Type-check**

```bash
bun run type-check
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callback.handler.ts src/bot/handlers/message.handler.ts
git commit -m "feat(bank): callback routing for bank_confirm/bank_edit and merchant rule approval"
```

---

