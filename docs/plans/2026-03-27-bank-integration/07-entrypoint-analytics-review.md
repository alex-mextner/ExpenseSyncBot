# Bank Integration Implementation Plan — Part 7/7: Tasks 18-19 and self-review

[← Back to index](../2026-03-27-bank-integration.md)

## Task 18: Bank-sync entry point

**Files:**

- Create: `bank-sync.ts`

- [ ] **Step 1: Create `bank-sync.ts`**

```typescript
// Entry point for the bank-sync PM2 process.
// Shares the SQLite database with the main bot but runs independently.
import { createLogger } from './src/utils/logger.ts';
import { startSyncService } from './src/services/bank/sync-service';
import { processMerchantRequests } from './src/services/bank/merchant-agent';

const logger = createLogger('bank-sync-main');

logger.info('Bank-sync service starting…');

// Run merchant request processing every 5 minutes
setInterval(() => {
  processMerchantRequests().catch((err) =>
    logger.error({ err }, 'Merchant processing cycle error'),
  );
}, 5 * 60 * 1000);

// Start bank sync scheduler (per-connection polling)
startSyncService();

logger.info('Bank-sync service started');
```

- [ ] **Step 2: Verify it starts without errors**

```bash
bun bank-sync.ts
```

Expected: logs "Bank-sync service started" and hangs (waiting for scheduled ticks). Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add bank-sync.ts
git commit -m "feat(bank): bank-sync entry point for PM2"
```

---

## Task 19: Analytics integration

**Files:**

- Modify: `src/services/analytics/spending-analytics.ts`
- Modify: `src/services/analytics/advice-triggers.ts`
- Modify: `src/services/analytics/formatters.ts`

- [ ] **Step 1: Explore existing analytics structure**

Read the first 60 lines of each file to understand extension points:

```bash
# Read each file
```

- [ ] **Step 2: Extend `formatSnapshotForPrompt` in `formatters.ts`**

Find the `formatSnapshotForPrompt` function. Add bank balance section after existing snapshot content:

```typescript
  // Add bank balances if any connections exist
  const bankAccounts = database.bankAccounts.findByGroupId(groupId);
  if (bankAccounts.length > 0) {
    const balanceLines = bankAccounts
      .map((a) => `${a.title}: ${a.balance.toFixed(2)} ${a.currency}`)
      .join('\n');
    snapshot += `\n\n## Банковские балансы\n${balanceLines}`;
  }

  // Add recent confirmed bank transactions (last 20)
  const recentBankTxs = database.bankTransactions.findByGroupId(groupId, { status: 'confirmed' }).slice(0, 20);
  if (recentBankTxs.length > 0) {
    const txLines = recentBankTxs
      .map((tx) => `${tx.date} ${tx.amount} ${tx.currency} — ${tx.merchant_normalized ?? tx.merchant ?? '—'}`)
      .join('\n');
    snapshot += `\n\n## Подтверждённые банковские транзакции\n${txLines}`;
  }
```

- [ ] **Step 3: Add pending bank transactions trigger to `advice-triggers.ts`**

Find the triggers array or `checkTriggers` function. Add:

```typescript
  // Daily: pending bank transactions need review
  const pendingConnections = database.bankConnections.findActiveByGroupId(groupId);
  let totalPending = 0;
  for (const conn of pendingConnections) {
    totalPending += database.bankTransactions.findPendingByConnectionId(conn.id).length;
  }
  if (totalPending > 0) {
    triggers.push({
      type: 'pending_bank_transactions',
      data: { count: totalPending },
      message: `${totalPending} банковских транзакций ожидают подтверждения`,
    });
  }
```

- [ ] **Step 4: Type-check and lint**

```bash
bun run type-check
bun run lint:fix
```

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Final commit**

```bash
git add src/services/analytics/
git commit -m "feat(bank): analytics integration — bank balances in snapshot, pending tx trigger"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|-----------------|------|
| ZenPlugins git submodule | Task 9 |
| Runtime shim (getData/saveData/addTransaction/etc.) | Task 10 |
| BANK_REGISTRY with TBC + Kaspi | Task 9 |
| DB: bank_connections, bank_credentials, bank_plugin_state | Task 2 |
| DB: bank_accounts, bank_transactions | Task 2 |
| DB: merchant_rules, merchant_rule_requests | Task 2 |
| DB: groups.bank_panel_summary_message_id | Task 2 |
| PRAGMA busy_timeout = 5000 | Task 1 |
| Sync service: 30-min interval with stagger | Task 13 |
| sign_type classification (debit/credit/reversal) | Task 13 |
| ON CONFLICT DO NOTHING for transactions | Task 6 |
| Merchant rules applied after scrape | Task 13 |
| Error escalation after 3 failures | Task 13 |
| Direct Telegram API for bank-sync notifications | Task 11 |
| AI pre-fill (category + comment) | Task 12 |
| Confirmation card with ✅/✏️ buttons | Task 13 |
| Large transaction ⚠️ prefix | Task 13 |
| ✅ Принять → create expense + merchant_rule_request | Task 17 |
| ✏️ Исправить → reply-based edit flow | Task 17 |
| One active edit at a time (block concurrent edits) | Task 17 |
| /bank command — no banks → bank list buttons | Task 17 |
| /bank command — with banks → status panel | Task 17 |
| /bank setup wizard — step-by-step credentials | Task 17 |
| Wizard cancel with /bank отмена | Task 17 |
| Stale setup cleanup (10 min timeout) | Task 3 |
| Multi-bank panel — one message per bank | Task 17 |
| panel_message_id persisted for in-place edits | Task 17 |
| Admin approval cards for merchant rules | Task 14 |
| BOT_ADMIN_CHAT_ID optional — no crash if absent | Task 1 |
| merchant_rule_requests UNIQUE + INSERT OR IGNORE | Task 7 |
| Prune old processed requests after 7 days | Task 7 |
| Layer 1-5 security (group_id scoping) | Tasks 3, 6 |
| AI tools: get_bank_transactions (group-scoped) | Task 15 |
| AI tools: get_bank_balances | Task 15 |
| AI tools: find_missing_expenses (±2/±5 day fuzzy match) | Task 15 |
| Analytics: bank data in formatSnapshotForPrompt | Task 19 |
| Analytics: pending tx daily advice trigger | Task 19 |
| env BOT_ADMIN_CHAT_ID + LARGE_TX_THRESHOLD_EUR | Task 1 |
| bank-sync.ts PM2 entry point | Task 18 |
| crypto utility (AES-256-GCM) | Task 1 |

### Out of scope (per spec)

- Auto-sync confirmed bank transactions to Google Sheets ✓
- Web UI for merchant rules ✓
- Multiple simultaneous edit flows ✓ (blocked with "Сначала заверши текущее исправление")
