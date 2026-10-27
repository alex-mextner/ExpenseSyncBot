# Monthly Budget Tabs Implementation Plan — Part 5/5: Tasks 9-11 and verification checklist

[← Back to index](../2026-03-27-sheets-monthly-budget-tabs.md)

### Task 9: Remove old Budget functions from `sheets.ts`

**Files:**

- Modify: `src/services/google/sheets.ts`

At this point, `budget.ts` no longer imports `createBudgetSheet`, `hasBudgetSheet`, `readBudgetData`, `writeBudgetRow`. Time to delete them and fix `createExpenseSpreadsheet`.

- [ ] **Step 9.1: Remove old Budget functions from `sheets.ts`**

Delete these functions entirely:

- `createEmptyBudgetSheet` (private, lines ~478–555)
- `createBudgetSheet` (lines ~560–658)
- `readBudgetData` (lines ~663–705)
- `writeBudgetRow` (lines ~710–768)
- `hasBudgetSheet` (lines ~773–791)
- `BUDGET_SHEET_CONFIG` constant (lines ~459–462)
- `normalizeMonth` function (lines ~468–473) — it's now in `budget-migration.ts`

Also remove the `normalizeMonth` call and the `createEmptyBudgetSheet` call from `createExpenseSpreadsheet`. Specifically, remove this line near line 118:

```ts
  await createEmptyBudgetSheet(refreshToken, spreadsheetId);
```

- [ ] **Step 9.2: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 9.3: Run lint**

```bash
node_modules/.bin/biome lint src/services/google/sheets.ts
```

Expected: no warnings or errors

- [ ] **Step 9.4: Run full test suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 9.5: Commit**

```bash
git add src/services/google/sheets.ts
git commit -m "chore(sheets): remove flat Budget sheet functions, stop creating Budget tab on setup"
```

---

### Task 10: Update `spreadsheet.ts` command

**Files:**

- Modify: `src/bot/commands/spreadsheet.ts`

- [ ] **Step 10.1: Rewrite `handleSpreadsheetCommand`**

```ts
// /spreadsheet command — shows current year's spreadsheet and list of previous years

import { database } from '../../database';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import type { Ctx } from '../types';

export async function handleSpreadsheetCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup) {
    await ctx.send('Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.send('Группа не настроена. Используй /connect для настройки.');
    return;
  }

  const currentYear = new Date().getFullYear();
  const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
  const all = database.groupSpreadsheets.listAll(group.id);

  if (!currentSpreadsheetId && all.length === 0) {
    await ctx.send('Таблица не создана. Завершите настройку: /connect');
    return;
  }

  let message = '';

  if (currentSpreadsheetId) {
    message += `Таблица ${currentYear}:\n${getSpreadsheetUrl(currentSpreadsheetId)}\n`;
  } else {
    message += `Таблица за ${currentYear} ещё не создана.\n`;
  }

  const previous = all.filter((e) => e.year < currentYear);
  if (previous.length > 0) {
    message += `\nПредыдущие годы:\n`;
    for (const { year, spreadsheetId } of previous) {
      message += `• ${year}: ${getSpreadsheetUrl(spreadsheetId)}\n`;
    }
  }

  message +=
    `\nМожно редактировать прямо в таблице. После правок:\n` +
    `• /sync — подхватить изменения расходов\n` +
    `• /budget sync — подхватить изменения бюджетов`;

  await ctx.send(message.trim());
}
```

- [ ] **Step 10.2: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 10.3: Commit**

```bash
git add src/bot/commands/spreadsheet.ts
git commit -m "feat(bot): /spreadsheet shows current year + list of previous years"
```

---

### Task 11: cron.ts + bot/index.ts — wire everything together

**Files:**

- Create: `src/bot/cron.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 11.1: Create `src/bot/cron.ts`**

```ts
// Monthly budget tab auto-clone — runs at 00:00 on the 1st of every month

import cron from 'node-cron';
import { database } from '../database';
import {
  cloneMonthTab,
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  monthTabExists,
} from '../services/google/sheets';
import { monthAbbrFromDate, prevMonthAbbr } from '../services/google/month-abbr';
import { createLogger } from '../utils/logger.ts';
import type { BotInstance } from './types';

const logger = createLogger('cron');

export function registerMonthlyCron(bot: BotInstance): void {
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[CRON] Monthly tab auto-clone started');

    const now = new Date();
    const year = now.getFullYear();
    const month = monthAbbrFromDate(now);

    const groups = database.groups.findAll();

    for (const group of groups) {
      if (!group.google_refresh_token) continue;

      // Only active groups (have at least one spreadsheet entry)
      const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);
      if (allSpreadsheets.length === 0) continue;

      try {
        let spreadsheetId = database.groupSpreadsheets.getByYear(group.id, year);

        if (!spreadsheetId) {
          // New year — create spreadsheet (Expenses tab only)
          const { spreadsheetId: newId } = await createExpenseSpreadsheet(
            group.google_refresh_token,
            group.default_currency,
            group.enabled_currencies,
          );
          database.groupSpreadsheets.setYear(group.id, year, newId);
          spreadsheetId = newId;
          logger.info(`[CRON] Created new spreadsheet for group ${group.id}, year ${year}: ${newId}`);
        }

        const tabAlreadyExists = await monthTabExists(
          group.google_refresh_token,
          spreadsheetId,
          month,
        );
        if (tabAlreadyExists) {
          logger.info(`[CRON] Tab ${month} already exists for group ${group.id}, skipping`);
          continue;
        }

        const { year: prevYear, month: prevMonth } = prevMonthAbbr(year, month);
        const prevSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, prevYear);

        let notifyText: string;
        if (
          prevSpreadsheetId &&
          (await monthTabExists(group.google_refresh_token, prevSpreadsheetId, prevMonth))
        ) {
          await cloneMonthTab(
            group.google_refresh_token,
            prevSpreadsheetId,
            prevMonth,
            spreadsheetId,
            month,
          );
          notifyText = `Создана вкладка ${month} — скопирована из ${prevMonth}`;
          logger.info(`[CRON] Cloned ${prevMonth} → ${month} for group ${group.id}`);
        } else {
          await createEmptyMonthTab(group.google_refresh_token, spreadsheetId, month);
          notifyText = `Создана вкладка ${month}`;
          logger.info(`[CRON] Created empty tab ${month} for group ${group.id}`);
        }

        await bot.api
          .sendMessage({ chat_id: group.telegram_group_id, text: notifyText })
          .catch((err: unknown) =>
            logger.error({ err }, `[CRON] Failed to notify group ${group.id}`),
          );
      } catch (err) {
        logger.error({ err }, `[CRON] Failed for group ${group.id}`);
      }
    }

    logger.info('[CRON] Monthly tab auto-clone complete');
  });

  logger.info('[CRON] Monthly tab cron registered (00:00 on 1st of each month)');
}
```

- [ ] **Step 11.2: Update `src/bot/index.ts` — add startup migration + cron**

Add these imports near the top of `index.ts`:

```ts
import { runYearSplitMigration } from '../services/google/budget-migration';
import { createExpenseSpreadsheet } from '../services/google/sheets';
import { registerMonthlyCron } from './cron';
```

Inside `createBot()`, after all command handlers are registered (just before `return bot`), add:

```ts
  // Register monthly budget tab cron
  registerMonthlyCron(bot);

  return bot;
```

Then, add a startup migration function and call it from the bot startup. In `index.ts` (or wherever the bot is started — look for the `createBot()` call in `src/index.ts`), after the bot starts, add:

```ts
// One-time year-split migration: for each group whose existing spreadsheet pre-dates the
// current year, create a new current-year spreadsheet, copy current-year rows there,
// and clean up the old spreadsheet.
async function runStartupYearSplitMigration(): Promise<void> {
  const currentYear = new Date().getFullYear();
  const groups = database.groups.findAll();

  for (const group of groups) {
    if (!group.google_refresh_token) continue;

    const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);
    if (allSpreadsheets.length === 0) continue;

    // Skip if current year already has a spreadsheet (migration already done or not needed)
    const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
    if (currentSpreadsheetId) continue;

    // Find the most recent prior-year spreadsheet to split from
    const priorSpreadsheet = allSpreadsheets.find((s) => s.year < currentYear);
    if (!priorSpreadsheet) continue;

    try {
      // 1. Create new current-year spreadsheet
      const { spreadsheetId: newId, spreadsheetUrl: newUrl } = await createExpenseSpreadsheet(
        group.google_refresh_token,
        group.default_currency,
        group.enabled_currencies,
      );
      database.groupSpreadsheets.setYear(group.id, currentYear, newId);
      logger.info(`[STARTUP] Created ${currentYear} spreadsheet for group ${group.id}: ${newId}`);

      // 2. Run year-split: move currentYear rows from old spreadsheet to new one
      const backupUrl = await runYearSplitMigration(
        group.google_refresh_token,
        priorSpreadsheet.spreadsheetId,
        newId,
        currentYear,
      );
      if (backupUrl) {
        logger.info(
          `[STARTUP] Year-split done for group ${group.id}. Backup: ${backupUrl}`,
        );
      }

      // 3. Notify the group
      await bot.api
        .sendMessage({
          chat_id: group.telegram_group_id,
          text:
            `Создана таблица ${currentYear}: ${newUrl}\n` +
            `Данные за ${currentYear} перенесены из таблицы ${priorSpreadsheet.year}.`,
          ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
        })
        .catch((err: unknown) =>
          logger.error({ err }, `[STARTUP] Failed to notify group ${group.id}`),
        );
    } catch (err) {
      logger.error({ err }, `[STARTUP] Year-split migration FAILED for group ${group.id} — shutting down`);
      process.exit(1);
    }
  }
}
```

Then call `await runStartupYearSplitMigration()` in the startup sequence (wherever `bot.start()` is called in `src/index.ts`).

- [ ] **Step 11.3: Find where bot is started and add the migration call**

Read `src/index.ts` and find where `bot.start()` is called.

Add `await runStartupYearSplitMigration()` before `bot.start()`. Export the function from
`src/bot/index.ts` and import it in `src/index.ts`.

Note: `runStartupYearSplitMigration` needs access to `bot` to send notifications —
pass `bot` as a parameter or close over it. The cleanest approach: export
`export function createStartupMigration(bot: BotInstance)` that returns the async function.

- [ ] **Step 11.4: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 11.5: Run full test suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 11.6: Run lint on all changed files**

```bash
node_modules/.bin/biome lint src/bot/cron.ts src/bot/index.ts
```

Expected: no errors

- [ ] **Step 11.7: Final full check before commit**

```bash
bun run type-check && bun test && node_modules/.bin/biome lint src/
```

Expected: all pass, no errors

- [ ] **Step 11.8: Commit**

```bash
git add src/bot/cron.ts src/bot/index.ts src/index.ts
git commit -m "feat(bot): register monthly tab cron and startup Budget migration"
```

---

## Verification Checklist

Before calling this done, verify:

- [ ] `bun test` — all tests pass
- [ ] `bun run type-check` — no errors
- [ ] `node_modules/.bin/biome lint src/` — no warnings
- [ ] `database.groupSpreadsheets` accessible in code via `database.groupSpreadsheets.getByYear(...)`
- [ ] `group.spreadsheet_id` still works in all existing command handlers (backward compat via LEFT JOIN)
- [ ] Old `Budget` flat sheet functions no longer exported from `sheets.ts`
- [ ] `createExpenseSpreadsheet` no longer creates a Budget tab
- [ ] `/spreadsheet` command shows current year + previous years
- [ ] Cron registered with `node-cron` expression `'0 0 1 * *'`
- [ ] DB migration maps existing spreadsheet to year of earliest expense (not current year)
- [ ] `runYearSplitMigration` copies splitYear expense rows to new spreadsheet, deletes from old
- [ ] Budget months with year >= splitYear go to new spreadsheet; prior years stay in old
- [ ] Startup migration skips groups that already have a current-year spreadsheet (idempotent)
- [ ] Startup migration sends Telegram notification with new spreadsheet URL after split
- [ ] Startup migration calls `process.exit(1)` on ANY failure after backup
