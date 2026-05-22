# Auto-Advice Flag + Budget-Exceeded Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `AUTO_ADVICE_ENABLED` env flag. When off (default) — all auto-triggers go to logs only except budget-exceeded, which always sends a short message to chat. When on — all triggers send AI advice to chat. Budget-exceeded fires at most once per month per category.

**Architecture:** Only two files change with real logic: `env.ts` (new flag) and `ask.ts` (`maybeSmartAdvice` rewrite). Everything in `advice-triggers.ts` — all 9 trigger types, cooldowns, dedup — stays untouched.

**Tech Stack:** Bun, TypeScript, SQLite, GramIO, Biome, Lefthook

---

## How the Once-Per-Month Dedup Works (Read First)

`checkSmartTriggers` in `advice-triggers.ts` already calls `database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)` before returning a budget_exceeded trigger. If an entry with that topic exists in `advice_log` for this month, the function returns `null` — the trigger never reaches `maybeSmartAdvice`.

So the dedup chain is:
1. User adds expense → `maybeSmartAdvice` called → `checkSmartTriggers` called
2. `checkSmartTriggers` builds topic `budget_threshold:Food:exceeded`, checks `hasTopicThisMonth` → finds nothing → returns trigger
3. `maybeSmartAdvice` sends message → writes row to `advice_log` with that topic
4. Next call → `checkSmartTriggers` → `hasTopicThisMonth` finds the row → returns `null` → no second message

**No code changes needed in `advice-triggers.ts`.** The dedup is already there. The only requirement: `maybeSmartAdvice` must write to `advice_log` after sending.

---

## Three Dispatch Paths in `maybeSmartAdvice`

| Trigger | Flag state | Action |
|---------|-----------|--------|
| `budget_threshold:*:exceeded` | any | Send short factual message to chat + write `advice_log` |
| any other trigger | `AUTO_ADVICE_ENABLED=true` | Call `sendSmartAdvice` (AI generation, streams to Telegram) |
| any other trigger | `AUTO_ADVICE_ENABLED=false` | Log trigger context for analysis + write `advice_log` + call `recordAdviceSent` |

The third path calls `recordAdviceSent` (sets in-memory cooldown) **and** writes to `advice_log` (activates monthly `hasTopicThisMonth` dedup) because different triggers use different dedup mechanisms: `velocity_spike` uses `getRecent` 7-day window, `weekly_check` uses `hasTopicThisMonth`. Both need their respective state updated even in suppress mode, otherwise the same trigger re-fires on every expense.

---

## File Map

| File | What changes and why |
|------|---------------------|
| `src/config/env.ts` | Add `AUTO_ADVICE_ENABLED: boolean` so the flag is available via `env.AUTO_ADVICE_ENABLED` |
| `.env.example` | Document the flag for ops |
| `src/bot/commands/ask.ts` | Rewrite `maybeSmartAdvice` with three-way dispatch; add `formatAmount` import for the budget exceeded message; remove orphaned `recordAdviceSent` call from `sendSmartAdvice` (it was there to set cooldown after sending, but now `maybeSmartAdvice` owns that responsibility) |
| `src/bot/commands/ask.test.ts` | Replace the `maybeSmartAdvice` describe block — old tests tested suppression-only behavior, new tests cover all three paths |

---

## Task 1: Branch Cleanup

The stale branches were partial attempts at this same feature. Both are superseded by this plan. `disable-auto-advice` had the suppress-logging pattern (ported below). `financial-alert-env-flag` had the env.ts wiring (ported below, renamed).

- [ ] **Close PR #87, delete both stale remote branches**

```bash
gh pr close 87 --comment "Superseded by feat/auto-advice-flag"
git push origin --delete disable-auto-advice
git push origin --delete claude/financial-alert-env-flag-8BhYg
```

- [ ] **Create new branch from main**

```bash
git checkout main
git pull origin main
git checkout -b feat/auto-advice-flag
```

---

## Task 2: Add `AUTO_ADVICE_ENABLED` to `env.ts`

**What:** The flag needs to be part of `EnvConfig` so TypeScript knows about it and so `validateEnv()` reads it from `process.env`. Without this, any reference to `env.AUTO_ADVICE_ENABLED` in `ask.ts` would be a type error.

**Files:** `src/config/env.ts`, `.env.example`

- [ ] **Add to `EnvConfig` interface** (after the `AI_DEBUG_LOGS` line)

```typescript
  AI_DEBUG_LOGS: boolean;
  AUTO_ADVICE_ENABLED: boolean;
  NODE_ENV: 'development' | 'production';
```

- [ ] **Add to `validateEnv()` return** (after the `AI_DEBUG_LOGS` line)

```typescript
    AI_DEBUG_LOGS: process.env['AI_DEBUG_LOGS'] === 'true',
    AUTO_ADVICE_ENABLED: process.env['AUTO_ADVICE_ENABLED'] === 'true',
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') || 'development',
```

Default is `false` — the empty string from a missing env var coerces to `false` via `=== 'true'`.

- [ ] **Document in `.env.example`** (add after the `AI_DEBUG_LOGS` entry)

```bash
# Set true to send proactive AI financial insights to chat.
# false (default): triggers are logged for analysis but not sent.
# Budget-exceeded alerts fire regardless of this setting.
AUTO_ADVICE_ENABLED=false
```

- [ ] **Verify typecheck passes**

```bash
tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(config): add AUTO_ADVICE_ENABLED flag (default false)"
```

---

## Task 3: Rewrite `maybeSmartAdvice` in `ask.ts`

**What changes and why:**

The current `maybeSmartAdvice` on `main` calls `sendSmartAdvice` unconditionally — it sends AI advice on every trigger. The `disable-auto-advice` branch replaced that with pure logging. Neither is correct. We need three-way dispatch as described above.

Additionally, `sendSmartAdvice` currently calls `recordAdviceSent(groupId, tier)` after sending AI advice. That call belongs to the caller, not to `sendSmartAdvice`, because now the suppress path in `maybeSmartAdvice` also needs to call it. Leaving it in both places would double-set the cooldown. Remove it from `sendSmartAdvice`.

`formatAmount` is needed to render `620 EUR / 500 EUR · 124%` in the budget exceeded message. Without it we'd have to use raw `.toFixed()` which the project forbids for user-facing amounts (CLAUDE.md).

**Files:** `src/bot/commands/ask.ts`

- [ ] **Add `formatAmount` import** (next to the existing imports from `currency/converter`, or after the `sendMessage` import line)

```typescript
import { formatAmount } from '../../services/currency/converter';
```

- [ ] **Remove `recordAdviceSent` call from `sendSmartAdvice`**

Find in `sendSmartAdvice` — the two lines before `database.adviceLogs.create`:
```typescript
    // Record advice in log and update cooldown
    recordAdviceSent(groupId, tier);
    database.adviceLogs.create({
```

Remove the comment and the `recordAdviceSent` call, keep `database.adviceLogs.create`:
```typescript
    database.adviceLogs.create({
```

- [ ] **Replace the entire `maybeSmartAdvice` function body**

The function signature and export stay the same. Replace everything between `{` and the final `}`:

```typescript
/**
 * Check smart triggers and dispatch:
 *   budget_threshold:exceeded → always send factual message to chat + write advice_log
 *   other trigger, AUTO_ADVICE_ENABLED=true  → send AI advice via sendSmartAdvice
 *   other trigger, AUTO_ADVICE_ENABLED=false → log context for analysis only
 *
 * Once-per-month dedup for budget_exceeded: checkSmartTriggers calls hasTopicThisMonth
 * before returning the trigger, so if we wrote an advice_log entry this month it returns
 * null before we even get here.
 */
export async function maybeSmartAdvice(groupId: number): Promise<void> {
  try {
    const snapshot = spendingAnalytics.getFinancialSnapshot(groupId);
    const trigger = checkSmartTriggers(groupId, snapshot);
    if (!trigger) return;

    // Budget actually exceeded — always notify, once per month per category.
    if (trigger.topic.endsWith(':exceeded')) {
      const { category, spent, limit, currency } = trigger.data as {
        category: string;
        spent: number;
        limit: number;
        currency: string;
      };
      const pct = Math.round((spent / limit) * 100);
      const text =
        `⚠️ <b>${category}</b>: бюджет превышен\n` +
        `${formatAmount(spent, currency)} / ${formatAmount(limit, currency)} · ${pct}%`;

      await sendMessage(text);
      database.adviceLogs.create({
        group_id: groupId,
        tier: trigger.tier,
        trigger_type: trigger.type,
        trigger_data: JSON.stringify(trigger.data),
        topic: trigger.topic,
        advice_text: text,
      });
      logger.info({ groupId, topic: trigger.topic, pct }, '[ADVICE] Budget exceeded alert sent');
      return;
    }

    // Other triggers: send to chat when flag is on.
    if (env.AUTO_ADVICE_ENABLED) {
      await sendSmartAdvice(groupId, trigger, snapshot);
      return;
    }

    // Flag is off: log trigger context for offline analysis.
    // recordAdviceSent sets in-memory cooldown so the same tier doesn't re-fire
    // on every expense within the cooldown window (4h quick / 1h alert).
    // advice_log entry activates hasTopicThisMonth dedup for monthly triggers.
    const group = database.groups.findById(groupId);
    const snapshotText = formatSnapshotForPrompt(
      snapshot,
      groupId,
      group?.default_currency ?? BASE_CURRENCY,
    );
    logger.info(
      {
        groupId,
        trigger: { type: trigger.type, tier: trigger.tier, topic: trigger.topic, data: trigger.data },
        severity: computeOverallSeverity(snapshot),
        context: snapshotText,
      },
      '[ADVICE] Auto-advice suppressed — trigger would have fired',
    );
    recordAdviceSent(groupId, trigger.tier);
    database.adviceLogs.create({
      group_id: groupId,
      tier: trigger.tier,
      trigger_type: trigger.type,
      trigger_data: JSON.stringify(trigger.data),
      topic: trigger.topic,
      advice_text: '[auto-advice suppressed]',
    });
  } catch (error) {
    logger.error({ err: error }, '[ADVICE] Error in smart advice check');
  }
}
```

- [ ] **Verify typecheck**

```bash
tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

Expected: no errors.

---

## Task 4: Update `ask.test.ts` — `maybeSmartAdvice` tests

**What changes and why:** The current `maybeSmartAdvice` describe block tests the suppress-only behavior from `disable-auto-advice`. Those tests now fail because the function has three paths. Replace with 6 tests: one per path plus edge cases.

`env.AUTO_ADVICE_ENABLED` is `false` in tests by default (not set in `.env`). To test the flag=true path, mutate `env` directly inside the test and restore it after — `env` is a plain object, not frozen.

The existing mocks in the file (`mockSendMessage`, `mockAdviceLogs.create`, `checkSmartTriggersMock`, `recordAdviceSentMock`, `mockAiStreamRound`, `logMock`) already cover everything needed.

**Files:** `src/bot/commands/ask.test.ts`

- [ ] **Replace the entire `maybeSmartAdvice` describe block**

Find the block starting with `describe('maybeSmartAdvice', () => {` and replace:

```typescript
describe('maybeSmartAdvice', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockAdviceLogs.create.mockClear();
    mockAiStreamRound.mockReset();
    recordAdviceSentMock.mockClear();
    checkSmartTriggersMock.mockReset().mockReturnValue(null);
    logMock.error.mockReset();
    logMock.info.mockReset();
    logMock.warn.mockReset();
  });

  const budgetExceededTrigger = {
    type: 'budget_threshold' as const,
    tier: 'alert' as const,
    topic: 'budget_threshold:Food:exceeded',
    data: { category: 'Food', spent: 620, limit: 500, currency: 'EUR' },
  };

  const velocityTrigger = {
    type: 'velocity_spike' as const,
    tier: 'quick' as const,
    topic: 'velocity_spike',
    data: { acceleration: 80, recent_avg: 60, earlier_avg: 30 },
  };

  test('does nothing when checkSmartTriggers returns null', async () => {
    await maybeSmartAdvice(1);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockAdviceLogs.create).not.toHaveBeenCalled();
    expect(mockAiStreamRound).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('budget_exceeded: sends factual message to chat regardless of AUTO_ADVICE_ENABLED', async () => {
    // Flag is off by default in tests — this path must fire anyway
    checkSmartTriggersMock.mockReturnValueOnce(budgetExceededTrigger);

    await maybeSmartAdvice(1);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [msg] = mockSendMessage.mock.calls[0] as [string];
    expect(msg).toContain('Food');
    expect(msg).toContain('бюджет превышен');
    expect(msg).toContain('124%');
    // No AI generation — this is a simple factual message
    expect(mockAiStreamRound).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('budget_exceeded: writes to advice_log so monthly dedup fires next time', async () => {
    // The advice_log entry is what hasTopicThisMonth finds on the next call,
    // preventing a second notification this month.
    checkSmartTriggersMock.mockReturnValueOnce(budgetExceededTrigger);

    await maybeSmartAdvice(1);

    expect(mockAdviceLogs.create).toHaveBeenCalledTimes(1);
    const arg = mockAdviceLogs.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['group_id']).toBe(1);
    expect(arg['tier']).toBe('alert');
    expect(arg['topic']).toBe('budget_threshold:Food:exceeded');
    // advice_text contains the message text, not a suppression marker
    expect(arg['advice_text']).not.toBe('[auto-advice suppressed]');
    expect(typeof arg['advice_text']).toBe('string');
  });

  test('other trigger + AUTO_ADVICE_ENABLED=true: calls AI via sendSmartAdvice', async () => {
    const envModule = await import('../../config/env');
    (envModule.env as Record<string, unknown>)['AUTO_ADVICE_ENABLED'] = true;

    checkSmartTriggersMock.mockReturnValueOnce(velocityTrigger);
    mockAiStreamRound.mockImplementationOnce(async (_opts: unknown, callbacks: { onTextDelta?: (t: string) => void }) => {
      callbacks?.onTextDelta?.('траты растут');
      return {
        text: 'траты растут',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: 'траты растут' },
        providerUsed: 'mock',
      };
    });

    await maybeSmartAdvice(1);

    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();

    (envModule.env as Record<string, unknown>)['AUTO_ADVICE_ENABLED'] = false;
  });

  test('other trigger + AUTO_ADVICE_ENABLED=false: logs suppressed, no message, persists cooldown', async () => {
    checkSmartTriggersMock.mockReturnValueOnce(velocityTrigger);

    await maybeSmartAdvice(1);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockAiStreamRound).not.toHaveBeenCalled();
    // Cooldown recorded so same tier doesn't re-fire within 4h
    expect(recordAdviceSentMock).toHaveBeenCalledWith(1, 'quick');
    // advice_log written so monthly dedup works
    expect(mockAdviceLogs.create).toHaveBeenCalledTimes(1);
    const arg = mockAdviceLogs.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['advice_text']).toBe('[auto-advice suppressed]');
    // Full context logged for offline analysis
    const suppressedLog = logMock.info.mock.calls.find((c) =>
      JSON.stringify(c).includes('Auto-advice suppressed'),
    );
    expect(suppressedLog).toBeDefined();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('swallows errors without propagating', async () => {
    const spa = await import('../../services/analytics/spending-analytics');
    (spa.spendingAnalytics.getFinancialSnapshot as ReturnType<typeof mock>).mockImplementationOnce(
      () => { throw new Error('DB down'); },
    );

    await expect(maybeSmartAdvice(1)).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalled();
  });
});
```

- [ ] **Run ask.test.ts**

```bash
bun test src/bot/commands/ask.test.ts 2>&1 | tail -15
```

Expected: all pass, 0 fail.

- [ ] **Commit**

```bash
git add src/bot/commands/ask.ts src/bot/commands/ask.test.ts
git commit -m "feat(advice): three-way dispatch in maybeSmartAdvice

- budget_threshold:exceeded → factual message to chat + advice_log (monthly dedup)
- other triggers + AUTO_ADVICE_ENABLED=true → AI advice via sendSmartAdvice
- other triggers + AUTO_ADVICE_ENABLED=false → log only, no Telegram message"
```

---

## Task 5: Full Suite, Lint, PR

- [ ] **Run all tests**

```bash
bun run test 2>&1 | tail -20
```

Expected: all pass, 0 fail.

- [ ] **Typecheck + lint**

```bash
bun run type-check 2>&1 | grep -v "node_modules" | head -20
bun run lint 2>&1 | tail -10
```

Expected: no errors, 0 warnings. Run `bun run lint:fix` if needed, commit fixes separately.

- [ ] **Push and open PR**

```bash
git push -u origin feat/auto-advice-flag
gh pr create \
  --title "feat(advice): flag-gated auto-advice + always-on budget exceeded alerts" \
  --body "$(cat <<'EOF'
## Summary

- Add `AUTO_ADVICE_ENABLED` env flag (default `false`)
- `maybeSmartAdvice` three-way dispatch:
  - `budget_threshold:exceeded` → factual message to chat, once per month per category
  - Any other trigger + `AUTO_ADVICE_ENABLED=true` → AI advice to chat
  - Any other trigger + `AUTO_ADVICE_ENABLED=false` → log context only, nothing sent
- `checkSmartTriggers` and all trigger logic in `advice-triggers.ts` unchanged
- Closes `disable-auto-advice` (PR #87) and `claude/financial-alert-env-flag-8BhYg`

## Once-per-month dedup for budget_exceeded
`checkSmartTriggers` already calls `hasTopicThisMonth` before returning exceeded triggers.
`maybeSmartAdvice` writes the `advice_log` entry after sending — that entry is what
`hasTopicThisMonth` finds on the next call. No code changes to trigger logic needed.

## Test plan
- [ ] `bun run type-check` — green
- [ ] `bun run lint` — green
- [ ] `bun run test` — all pass
- [ ] Prod, flag off: expense exceeds Food budget → one ⚠️ message; next expense same category same month → no repeat
- [ ] Prod, flag off: velocity spike appears in `pm2 logs` as suppressed, nothing in chat
- [ ] Set `AUTO_ADVICE_ENABLED=true`, restart → velocity spike fires AI advice in chat

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- ✅ `AUTO_ADVICE_ENABLED` flag controls chat vs log-only for non-budget triggers
- ✅ When sending to chat, also writes to `advice_log`
- ✅ `budget_exceeded` always goes to chat, ignores flag
- ✅ `budget_exceeded` once per month per category — explained in detail, no code changes needed in `checkSmartTriggers`
- ✅ Suppress path logs full context + `recordAdviceSent` + `advice_log` entry — explained why both needed
- ✅ `checkSmartTriggers` and `advice-triggers.ts` untouched
- ✅ Both stale branches deleted
- ✅ Manual `/advice` unchanged (`sendSmartAdvice` still works, just loses the orphaned `recordAdviceSent` call)

**Placeholder scan:** none.

**Type consistency:**
- `trigger.data` cast to `{ category, spent, limit, currency }` in budget_exceeded path only ✓
- `formatAmount(spent, currency)` — `(number, string)` matches signature in `converter.ts` ✓
- `recordAdviceSent` stays exported from `advice-triggers.ts`, import in `ask.ts` unchanged ✓
- `env.AUTO_ADVICE_ENABLED` boolean added to both `EnvConfig` interface and `validateEnv()` return ✓
- `trigger.topic.endsWith(':exceeded')` — topic format is `budget_threshold:${category}:exceeded`, endsWith works ✓
