# Uzum (apelsin-uz) + KapitalBank-UZ Fix & CLI Runner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix auth bugs in kapitalbank-uz and apelsin-uz (Uzum) ZenPlugins, extract the ZenMoney shim into `libs/`, add test coverage for both converters, and create a standalone CLI runner for manual plugin testing.

**Architecture:** The ZenMoney shim (`createZenMoneyShim`) moves from `src/services/bank/runtime.ts` to `libs/zenmoney-shim.ts`, keeping the same API. The bot continues to import from there. A new `scripts/zen-run.ts` CLI runner instantiates the shim with an in-memory SQLite and calls a plugin's `scrape()` function directly, printing results as JSON. Plugin fixes stay inside the ZenPlugins submodule; tests for the converters go in `__tests__/` inside the submodule.

**Tech Stack:** Bun, bun:sqlite, TypeScript (parent project), JavaScript + Jest (ZenPlugins submodule), ts-standard linter (ZenPlugins), readline (Node.js built-in, for CLI OTP prompts)

---

## File Map

### Modified (parent project)
- `libs/zenmoney-shim.ts` — **new** — shim extracted from `src/services/bank/runtime.ts`; adds `takePicture` stub
- `src/services/bank/runtime.ts` — **modified** — becomes re-export of `libs/zenmoney-shim.ts`
- `src/services/bank/runtime.test.ts` — **modified** — update import path
- `src/services/bank/sync-service.ts` — **modified** — update import path
- `scripts/zen-run.ts` — **new** — CLI runner that runs any ZenPlugin without the bot

### Modified (ZenPlugins submodule)
- `src/plugins/kapitalbank-uz/index.js` — fix missing `TemporaryError` import, remove stray `takePicture` call, fix `else { throw new TemporaryError }` → `throw e`
- `src/plugins/kapitalbank-uz/__tests__/accounts/account.test.js` — **new** — `convertAccount` tests
- `src/plugins/kapitalbank-uz/__tests__/transactions/deposit-tx.test.js` — **new** — `convertDepositTransaction` tests
- `src/plugins/apelsin-uz/index.js` — fix inner catch: `e` → `ex`, `throw e` → `throw ex`
- `src/plugins/apelsin-uz/__tests__/accounts/wallet.test.js` — **new** — `convertWallet` tests
- `src/plugins/apelsin-uz/__tests__/transactions/mastercard.test.js` — **new** — `convertMasterCardTransaction` tests

---

## Task 1: Extract shim to `libs/zenmoney-shim.ts`

**Files:**
- Create: `libs/zenmoney-shim.ts`
- Modify: `src/services/bank/runtime.ts`
- Modify: `src/services/bank/runtime.test.ts`
- Modify: `src/services/bank/sync-service.ts`

- [ ] **Step 1: Create `libs/` directory and `libs/zenmoney-shim.ts`**

  Copy the full contents of `src/services/bank/runtime.ts` to `libs/zenmoney-shim.ts`, then add `takePicture` to the interface and implementation. The import path for `createLogger` must be updated to `../src/utils/logger.ts`.

  `libs/zenmoney-shim.ts`:
  ```ts
  // ZenMoney API shim — standalone lib used by the bot and CLI runner.
  import type { Database } from 'bun:sqlite'
  import { createLogger } from '../src/utils/logger.ts'

  const logger = createLogger('zen-runtime')

  export interface ZenMoneyShim {
    getData(key: string): unknown
    setData(key: string, value: unknown): void
    saveData(key?: string, value?: unknown): void
    getPreferences(): Record<string, string>
    addAccount(account: unknown): void
    addTransaction(tx: unknown): void
    readLine(prompt: string): Promise<string>
    takePicture(format: string): Promise<Blob>
    setResult(data: unknown): void
    trustCertificates(): void
    clearData(): void
    isAccountSkipped(id: string): boolean
    getCookies(): Promise<
      Array<{
        name: string
        value: string
        domain: string
        path: string
        persistent: boolean
        secure: string | null
        expires: string | null
      }>
    >
    setCookie(domain: string, name: string, value: string | null): Promise<void>
    clearCookies(): Promise<void>
    saveCookies(): Promise<void>
    restoreCookies(): Promise<void>
    setClientPfx(pfx: Uint8Array | null, domain: string): void
    logEvent(type: string, data?: Record<string, unknown>): void
    locale: string
    application: { platform: string; version: string; build: string }
    device: {
      id: string
      manufacturer: string
      model: string
      brand: string
      os: { name: string; version: string }
    }
    _getCollectedAccounts(): unknown[]
    _getCollectedTransactions(): unknown[]
    _getSetResult(): unknown
  }

  export function createZenMoneyShim(
    connectionId: number,
    db: Database,
    preferences: Record<string, string>,
    readLineImpl?: (prompt: string) => Promise<string>,
    takePictureImpl?: (format: string) => Promise<Blob>,
  ): ZenMoneyShim {
    const collectedAccounts: unknown[] = []
    const collectedTransactions: unknown[] = []
    let setResultValue: unknown

    const getState = db.query<{ value: string }, [number, string]>(
      'SELECT value FROM bank_plugin_state WHERE connection_id = ? AND key = ?',
    )
    const upsertState = db.query<void, [number, string, string]>(`
      INSERT INTO bank_plugin_state (connection_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(connection_id, key) DO UPDATE SET value = excluded.value
    `)
    const clearState = db.query<void, [number]>(
      'DELETE FROM bank_plugin_state WHERE connection_id = ?',
    )

    return {
      getData(key: string): unknown {
        const row = getState.get(connectionId, key)
        if (!row) return undefined
        try {
          return JSON.parse(row.value)
        } catch {
          return row.value
        }
      },
      setData(key: string, value: unknown): void {
        upsertState.run(connectionId, key, JSON.stringify(value))
      },
      saveData(key?: string, value?: unknown): void {
        if (key !== undefined) {
          upsertState.run(connectionId, key, JSON.stringify(value))
        }
      },
      getPreferences(): Record<string, string> {
        return preferences
      },
      addAccount(account: unknown): void {
        collectedAccounts.push(account)
      },
      addTransaction(tx: unknown): void {
        collectedTransactions.push(tx)
      },
      readLine(prompt: string): Promise<string> {
        if (readLineImpl) return readLineImpl(prompt)
        logger.warn({ prompt }, 'ZenMoney.readLine called but no readLine handler registered')
        return Promise.resolve('')
      },
      takePicture(format: string): Promise<Blob> {
        if (takePictureImpl) return takePictureImpl(format)
        throw new Error('ZenMoney.takePicture is not supported in automated sync mode')
      },
      setResult(data: unknown): void {
        setResultValue = data
      },
      trustCertificates(): void {},
      isAccountSkipped(_id: string): boolean {
        return false
      },
      async getCookies() {
        return []
      },
      async setCookie(_domain: string, _name: string, _value: string | null) {},
      async clearCookies() {},
      async saveCookies() {},
      async restoreCookies() {},
      setClientPfx(_pfx: Uint8Array | null, _domain: string) {},
      logEvent(_type: string, _data?: Record<string, unknown>) {},
      locale: 'en',
      application: { platform: 'Android', version: '6.66.3', build: '6663' },
      device: {
        id: 'expensesyncbot_device',
        manufacturer: 'Samsung',
        model: 'SM-G991B',
        brand: 'Samsung',
        os: { name: 'Android', version: '13' },
      },
      clearData(): void {
        clearState.run(connectionId)
      },
      _getCollectedAccounts(): unknown[] {
        return collectedAccounts
      },
      _getCollectedTransactions(): unknown[] {
        return collectedTransactions
      },
      _getSetResult(): unknown {
        return setResultValue
      },
    }
  }
  ```

- [ ] **Step 2: Replace `src/services/bank/runtime.ts` with a re-export**

  `src/services/bank/runtime.ts`:
  ```ts
  // Re-export from the shared shim library.
  export type { ZenMoneyShim } from '../../libs/zenmoney-shim'
  export { createZenMoneyShim } from '../../libs/zenmoney-shim'
  ```

- [ ] **Step 3: Update `src/services/bank/sync-service.ts` import — no change needed**

  The import `from './runtime'` still works since `runtime.ts` re-exports everything.

- [ ] **Step 4: Verify typecheck passes**

  ```bash
  timeout 60 bun run type-check
  ```
  Expected: zero errors.

- [ ] **Step 5: Run existing runtime tests**

  ```bash
  timeout 60 bun test src/services/bank/runtime.test.ts
  ```
  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add libs/zenmoney-shim.ts src/services/bank/runtime.ts
  git commit -m "refactor(bank): extract ZenMoney shim to libs/zenmoney-shim.ts"
  ```

---

## Task 2: Fix kapitalbank-uz bugs

All work happens inside `src/services/bank/ZenPlugins/`. Run all commands from that directory.

**Files:**
- Modify: `src/plugins/kapitalbank-uz/index.js`
- Create: `src/plugins/kapitalbank-uz/__tests__/accounts/account.test.js`
- Create: `src/plugins/kapitalbank-uz/__tests__/transactions/deposit-tx.test.js`

- [ ] **Step 1: Write failing test for `convertAccount` (the converter, not card)**

  The current `accounts/` tests only cover `convertCard` and `convertDeposit`. There is no test for `convertAccount`.

  `src/plugins/kapitalbank-uz/__tests__/accounts/account.test.js`:
  ```js
  import {
    convertAccount
  } from '../../converters'

  describe('convertAccount', () => {
    it('converts USD account', () => {
      expect(convertAccount({
        guid: 'AC-abcd1234-0000-0000-0000-000000000001',
        accountNumber: 'UZ12345678901234567890',
        currency: { name: 'USD', scale: 2 },
        balance: 150075
      })).toEqual({
        id: 'AC-abcd1234-0000-0000-0000-000000000001',
        title: 'Счёт USD *0001',
        syncIds: ['UZ12345678901234567890'],
        instrument: 'USD',
        type: 'checking',
        balance: 1500.75
      })
    })

    it('converts UZS account', () => {
      expect(convertAccount({
        guid: 'AC-abcd1234-0000-0000-0000-000000000002',
        accountNumber: 'UZ98765432109876543210',
        currency: { name: 'UZS', scale: 2 },
        balance: 5000000000
      })).toEqual({
        id: 'AC-abcd1234-0000-0000-0000-000000000002',
        title: 'Счёт UZS *0002',
        syncIds: ['UZ98765432109876543210'],
        instrument: 'UZS',
        type: 'checking',
        balance: 50000000
      })
    })
  })
  ```

- [ ] **Step 2: Run test from inside ZenPlugins directory — confirm it fails**

  ```bash
  cd src/services/bank/ZenPlugins && npm install --ignore-scripts && npx jest src/plugins/kapitalbank-uz/__tests__/accounts/account.test.js --no-coverage 2>&1 | tail -20
  ```
  Expected: FAIL — `convertAccount` doesn't match (or similar).

  > **Note:** The test may fail because `convertAccount` in `kapitalbank-uz/converters.js` uses `account.guid.slice(-4)` for the title. Verify the actual title format against the converter source and adjust fixtures if needed.

- [ ] **Step 3: Write failing test for `convertDepositTransaction`**

  `src/plugins/kapitalbank-uz/__tests__/transactions/deposit-tx.test.js`:
  ```js
  import {
    convertDepositTransaction
  } from '../../converters'

  describe('convertDepositTransaction', () => {
    it('returns null for INTEREST activity', () => {
      const deposit = { id: 'DP-001' }
      const rawTx = {
        activity: { type: 'INTEREST', description: 'Interest payment' },
        amount: 50000,
        currency: { name: 'UZS', scale: 2 },
        paymentDate: '2025-03-01 10:00:00.+0000'
      }
      expect(convertDepositTransaction(deposit, rawTx)).toBeNull()
    })

    it('converts PARTIAL_REPLENISHMENT as credit', () => {
      const deposit = { id: 'DP-002' }
      const rawTx = {
        activity: { type: 'PARTIAL_REPLENISHMENT', description: 'Пополнение вклада' },
        amount: 1000000,
        currency: { name: 'UZS', scale: 2 },
        paymentDate: '2025-03-15 12:30:00.+0000'
      }
      const result = convertDepositTransaction(deposit, rawTx)
      expect(result).not.toBeNull()
      expect(result.movements[0].account.id).toBe('DP-002')
      expect(result.movements[0].sum).toBe(10000)
      expect(result.comment).toBe('Пополнение вклада')
      expect(result.hold).toBe(false)
    })
  })
  ```

- [ ] **Step 4: Run deposit-tx test — confirm it fails or passes (baseline)**

  ```bash
  npx jest src/plugins/kapitalbank-uz/__tests__/transactions/deposit-tx.test.js --no-coverage 2>&1 | tail -20
  ```

- [ ] **Step 5: Fix `index.js` — add missing import and remove stray `takePicture`**

  Open `src/plugins/kapitalbank-uz/index.js`. Make three changes:

  **Change 1 — add `TemporaryError` to the import at the top** (it's imported in `api.js` but missing in `index.js`):
  ```js
  // Before:
  import { InvalidLoginOrPasswordError } from '../../errors'
  // After:
  import { InvalidLoginOrPasswordError, TemporaryError } from '../../errors'
  ```

  **Change 2 — remove the three stray debug lines at the top of `scrape()`**:
  ```js
  // Remove these three lines from the start of `scrape()`:
  const photoFromCamera = await ZenMoney.takePicture('jpeg')
  console.log(typeof photoFromCamera)
  console.log(photoFromCamera)
  await blobToBase64WithResolution(photoFromCamera, 480, 640)
  console.log('toBase64 complete')
  ```
  The function body after removal should start directly with `if (isFirstRun) {`.

  **Change 3 — fix the `else` branch in `updateToken`** (hides the real error by wrapping it in TemporaryError):
  ```js
  // Before:
  } else {
    throw new TemporaryError('Problems with identification')
  }
  // After:
  } else {
    throw e
  }
  ```

- [ ] **Step 6: Run ts-standard on changed files**

  ```bash
  npx ts-standard src/plugins/kapitalbank-uz/index.js 2>&1 | tail -20
  ```
  Expected: no errors. Fix any spacing/semicolon issues reported before continuing.

- [ ] **Step 7: Run all kapitalbank-uz tests**

  ```bash
  npx jest src/plugins/kapitalbank-uz/ --no-coverage 2>&1 | tail -30
  ```
  Expected: all tests pass.

- [ ] **Step 8: Commit (from ZenPlugins submodule)**

  ```bash
  git add src/plugins/kapitalbank-uz/index.js \
    src/plugins/kapitalbank-uz/__tests__/accounts/account.test.js \
    src/plugins/kapitalbank-uz/__tests__/transactions/deposit-tx.test.js
  git commit -m "fix(kapitalbank-uz): add missing TemporaryError import, remove stray takePicture call, fix error re-throw"
  ```

- [ ] **Step 9: Push to fork**

  ```bash
  git push fork HEAD
  ```

---

## Task 3: Fix apelsin-uz (Uzum) bugs and add tests

All work inside `src/services/bank/ZenPlugins/`.

**Files:**
- Modify: `src/plugins/apelsin-uz/index.js`
- Create: `src/plugins/apelsin-uz/__tests__/accounts/wallet.test.js`
- Create: `src/plugins/apelsin-uz/__tests__/transactions/mastercard.test.js`

- [ ] **Step 1: Write failing test for `convertWallet`**

  `src/plugins/apelsin-uz/__tests__/accounts/wallet.test.js`:
  ```js
  import { convertWallet } from '../../converters'

  describe('convertWallet', () => {
    it('converts UZS wallet', () => {
      expect(convertWallet({
        id: 101,
        account: '22600000099031231001',
        balance: 3050000,
        currency: { name: 'UZS', scale: 2 }
      })).toEqual({
        id: '101',
        type: 'checking',
        title: 'Кошелёк UZS',
        instrument: 'UZS',
        syncIds: ['22600000099031231001'],
        balance: 30500
      })
    })

    it('uses id as syncId when account is absent', () => {
      expect(convertWallet({
        id: 202,
        balance: 100,
        currency: { name: 'USD', scale: 2 }
      })).toEqual({
        id: '202',
        type: 'checking',
        title: 'Кошелёк USD',
        instrument: 'USD',
        syncIds: ['202'],
        balance: 1
      })
    })
  })
  ```

- [ ] **Step 2: Run wallet test — confirm passes (baseline)**

  ```bash
  cd src/services/bank/ZenPlugins && npx jest src/plugins/apelsin-uz/__tests__/accounts/wallet.test.js --no-coverage 2>&1 | tail -20
  ```
  Expected: PASS — `convertWallet` is simple and likely correct already.

- [ ] **Step 3: Write test for `convertMasterCardTransaction`**

  `src/plugins/apelsin-uz/__tests__/transactions/mastercard.test.js`:
  ```js
  import { convertMasterCardTransaction } from '../../converters'

  describe('convertMasterCardTransaction', () => {
    it('converts regular outcome (back: false)', () => {
      const card = { id: 'mc-card', instrument: 'USD' }
      const rawTx = {
        transDate: 1700000000000,
        amount: '-1500',
        fee: '0',
        currency: { name: 'USD' },
        merchantName: 'AMAZON',
        back: false
      }
      const result = convertMasterCardTransaction(card, rawTx)
      expect(result).not.toBeNull()
      expect(result.movements[0].sum).toBe(-1500)
      expect(result.merchant.title).toBe('AMAZON')
      expect(result.hold).toBe(false)
    })

    it('converts refund (back: true) — no merchant', () => {
      const card = { id: 'mc-card', instrument: 'USD' }
      const rawTx = {
        transDate: 1700000000000,
        amount: '500',
        fee: '0',
        currency: { name: 'USD' },
        merchantName: 'AMAZON',
        back: true
      }
      const result = convertMasterCardTransaction(card, rawTx)
      expect(result).not.toBeNull()
      expect(result.movements[0].sum).toBe(500)
      expect(result.merchant).toBeNull()
    })

    it('returns null for zero amount', () => {
      const card = { id: 'mc-card', instrument: 'UZS' }
      const rawTx = {
        transDate: 1700000000000,
        amount: '0',
        fee: '0',
        currency: { name: 'UZS' },
        merchantName: 'TEST',
        back: false
      }
      expect(convertMasterCardTransaction(card, rawTx)).toBeNull()
    })
  })
  ```

- [ ] **Step 4: Run mastercard test**

  ```bash
  npx jest src/plugins/apelsin-uz/__tests__/transactions/mastercard.test.js --no-coverage 2>&1 | tail -30
  ```
  Expected: passes or reveals specific bugs in `convertMasterCardTransaction`.

- [ ] **Step 5: Fix `index.js` — auth retry logic**

  Open `src/plugins/apelsin-uz/index.js`. The inner `catch` block for the token refresh has two bugs:

  ```js
  // Before (buggy):
  } catch (ex) {
    if (e instanceof AuthError) {
      console.info('try to do cold auth')
      await coldAuth(preferences)
      uzcardCards = await getUzcardCards()
    } else {
      throw e
    }
  }

  // After (fixed):
  } catch (ex) {
    if (ex instanceof AuthError) {
      console.info('try to do cold auth')
      await coldAuth(preferences)
      uzcardCards = await getUzcardCards()
    } else {
      throw ex
    }
  }
  ```

- [ ] **Step 6: Run ts-standard on changed file**

  ```bash
  npx ts-standard src/plugins/apelsin-uz/index.js 2>&1 | tail -20
  ```
  Expected: no errors.

- [ ] **Step 7: Run all apelsin-uz tests**

  ```bash
  npx jest src/plugins/apelsin-uz/ --no-coverage 2>&1 | tail -30
  ```
  Expected: all tests pass.

- [ ] **Step 8: Commit and push**

  ```bash
  git add src/plugins/apelsin-uz/index.js \
    src/plugins/apelsin-uz/__tests__/accounts/wallet.test.js \
    src/plugins/apelsin-uz/__tests__/transactions/mastercard.test.js
  git commit -m "fix(apelsin-uz): fix inner catch auth retry (e → ex), add wallet and mastercard converter tests"
  git push fork HEAD
  ```

---

## Task 4: Create CLI runner `scripts/zen-run.ts`

All work in the parent project root.

**Files:**
- Create: `scripts/zen-run.ts`

The runner:
1. Takes plugin name as first CLI arg
2. Reads credentials as `--key value` pairs from remaining args
3. Creates an in-memory SQLite with the `bank_plugin_state` table
4. Instantiates the shim (connection ID = 1)
5. Sets `globalThis.ZenMoney` to the shim
6. Dynamically imports the plugin from `src/services/bank/ZenPlugins/src/plugins/<name>/index.js`
7. Calls `scrape({ preferences, fromDate, toDate, isFirstRun })`
8. Prints accounts and transactions as JSON
9. OTP prompts are handled via stdin readline

- [ ] **Step 1: Write the CLI runner**

  `scripts/zen-run.ts`:
  ```ts
  // CLI runner for ZenPlugins — runs a bank plugin without the bot for manual testing.
  import { Database } from 'bun:sqlite'
  import { createInterface } from 'node:readline'
  import { resolve } from 'node:path'
  import { createZenMoneyShim } from '../libs/zenmoney-shim'

  const [pluginName, ...rest] = process.argv.slice(2)

  if (!pluginName) {
    console.error('Usage: bun scripts/zen-run.ts <plugin-name> [--key value ...] [--from YYYY-MM-DD]')
    console.error('Example: bun scripts/zen-run.ts apelsin-uz --phone 998901234567 --password Secret1')
    process.exit(1)
  }

  // Parse --key value pairs from remaining args
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '')
    const val = rest[i + 1]
    if (key && val !== undefined) flags[key] = val
  }

  const fromDate = flags.from ? new Date(flags.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const toDate = new Date()

  // Credentials: all flags except 'from' go to preferences
  const { from: _from, ...preferences } = flags

  // In-memory SQLite with the required table
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE bank_plugin_state (
      connection_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (connection_id, key)
    )
  `)

  // readline for OTP prompts
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const readLineImpl = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(`\n[OTP] ${prompt}: `, resolve))

  const shim = createZenMoneyShim(1, db, preferences, readLineImpl)
  ;(globalThis as unknown as Record<string, unknown>).ZenMoney = shim

  const pluginPath = resolve(
    import.meta.dir,
    '../src/services/bank/ZenPlugins/src/plugins',
    pluginName,
    'index.js',
  )

  const isFirstRun = !db.query('SELECT 1 FROM bank_plugin_state WHERE connection_id = 1').get()

  console.error(`[zen-run] Loading plugin: ${pluginName}`)
  console.error(`[zen-run] isFirstRun: ${isFirstRun}`)
  console.error(`[zen-run] fromDate: ${fromDate.toISOString()}`)

  const pluginModule = await import(pluginPath) as { scrape: (args: {
    preferences: Record<string, string>
    fromDate: Date
    toDate: Date
    isFirstRun: boolean
  }) => Promise<{ accounts: unknown[]; transactions: unknown[] }> }

  const result = await pluginModule.scrape({ preferences, fromDate, toDate, isFirstRun })

  rl.close()

  console.log(JSON.stringify({ accounts: result.accounts, transactions: result.transactions }, null, 2))

  console.error(`[zen-run] Done: ${result.accounts.length} accounts, ${result.transactions.length} transactions`)
  ```

- [ ] **Step 2: Verify type check passes**

  ```bash
  timeout 60 bun run type-check 2>&1 | tail -20
  ```
  Expected: no errors relating to `scripts/zen-run.ts`.

- [ ] **Step 3: Test the CLI runner with a dry run (no credentials)**

  This should print an error about missing plugin args or fail gracefully (not crash with an uncaught exception):
  ```bash
  timeout 10 bun scripts/zen-run.ts 2>&1
  ```
  Expected: `Usage:` message and exits with code 1.

  ```bash
  timeout 10 bun scripts/zen-run.ts nonexistent-plugin --phone 123 2>&1
  ```
  Expected: import error saying the module doesn't exist (graceful crash).

- [ ] **Step 4: Commit**

  ```bash
  git add scripts/zen-run.ts
  git commit -m "feat(scripts): add zen-run CLI for testing ZenPlugins without the bot"
  ```

---

## Task 5: Run full test suite and verify coverage

- [ ] **Step 1: Run parent project tests**

  ```bash
  timeout 120 bun run test 2>&1 | tail -30
  ```
  Expected: all existing tests pass.

- [ ] **Step 2: Run ZenPlugins test suite for both plugins**

  ```bash
  cd src/services/bank/ZenPlugins && timeout 60 npx jest src/plugins/kapitalbank-uz/ src/plugins/apelsin-uz/ --no-coverage 2>&1 | tail -40
  ```
  Expected: all tests pass, green.

- [ ] **Step 3: Check coverage for the two converters**

  ```bash
  timeout 60 npx jest src/plugins/kapitalbank-uz/converters.js src/plugins/apelsin-uz/converters.js --coverage 2>&1 | grep -E "converters|%|Stmts" | head -20
  ```
  Expected: statement coverage ≥ 70% for both converter files.

- [ ] **Step 4: If coverage is low — add more cases**

  For **kapitalbank-uz/converters.js** — the `CONVERSION` and `DEPOSITS_TRANSACTION` module branches in `convertCardOrAccountTransaction` are not covered by any existing test. Add a test case in `__tests__/transactions/outcome.test.js`:

  ```js
  it('converts CONVERSION transaction with comment', (rawTransaction, transaction) => {
    const card = { id: 'card', instrument: 'UZS' }
    const rawTx = {
      group: { title: 'Конвертация', type: 'CONVERSION' },
      module: 'CONVERSION',
      transactionDate: '2025-03-01 10:00:00.+0000',
      transactionGuid: 'CNV-abc12345',
      transactionType: 'DEBIT',
      status: 'SUCCESS',
      name: 'Обмен валюты USD/UZS',
      amount: 10000,
      currency: { name: 'UZS', scale: 2 }
    }
    const result = convertCardOrAccountTransaction(card, rawTx)
    expect(result.comment).toBe('Обмен валюты')
    expect(result.movements[0].sum).toBe(-100)
  })
  ```

- [ ] **Step 5: Final commit with any coverage additions**

  ```bash
  cd src/services/bank/ZenPlugins
  git add -u
  git commit -m "test(kapitalbank-uz): add CONVERSION module coverage"
  git push fork HEAD
  ```

---

## Self-Review Checklist

- **Spec coverage:**
  - ✅ kapitalbank-uz: `TemporaryError` import fixed (Task 2)
  - ✅ kapitalbank-uz: stray `takePicture` removed (Task 2)
  - ✅ apelsin-uz: inner catch `e` → `ex` fixed (Task 3)
  - ✅ shim extracted to `libs/` (Task 1)
  - ✅ `takePicture` added to shim interface (Task 1)
  - ✅ CLI runner created (Task 4)
  - ✅ Tests for converters added (Tasks 2, 3)
  - ✅ Coverage check (Task 5)

- **No placeholders:** all code is complete and specific.

- **Type consistency:** `createZenMoneyShim` signature in Task 1 Step 1 matches usage in Task 4 Step 1. `ZenMoneyShim.takePicture(format: string): Promise<Blob>` is consistent throughout.

---

## Credentials to Request Before Execution

Before running Task 4 (CLI runner), ask the user for:
- Phone number (format: `998XXXXXXXXX`)
- Password
- Whether to test apelsin-uz or kapitalbank-uz first
