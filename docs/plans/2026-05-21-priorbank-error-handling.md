# PriorBank Error Handling Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two error handling bugs in the PriorBank plugin that cause cryptic downstream crashes when the API returns `success: false` with an unrecognized error message (e.g. maintenance mode) or when GetSalt returns a null/empty result.

**Architecture:** Two targeted changes to `prior.js`: (1) catch-all `throw new BankMessageError(message)` at the end of the `assertResponseSuccess` inner block, so execution never continues past a failed response; (2) null guard in `getSalt` before returning `result.salt`, replacing downstream "Received undefined" TypeError with a meaningful error message.

**Tech Stack:** JavaScript (ES Modules, ASI — no semicolons), Jest via babel-jest (ZenPlugins infra), fetch-mock for HTTP mocking, Node.js crypto, jshashes SHA512

---

## File Structure

| File | Change |
|------|--------|
| `src/services/bank/ZenPlugins/src/plugins/priorbank/prior.js` | Fix `assertResponseSuccess` (catch-all) + `getSalt` (null guard) |
| `src/services/bank/ZenPlugins/src/plugins/priorbank/__tests__/index.login.test.js` | Add 2 failing tests, then verify they pass after fix |

---

### Task 1: Write failing tests

**Files:**
- Modify: `src/services/bank/ZenPlugins/src/plugins/priorbank/__tests__/index.login.test.js`

- [ ] **Step 1: Add missing imports**

Open the test file. The first lines currently are:
```js
import fetchMock from 'fetch-mock'
import { InvalidLoginOrPasswordError } from '../../../errors'
import { installFetchMockDeveloperFriendlyFallback } from '../../../testUtils'
import { makePluginDataApi } from '../../../ZPAPI.pluginData'
import { scrape } from '../index'
import { mockGetSalt, mockLogin, mockMobileToken } from '../mocks'
```

Add two more imports after line 2:
```js
import { BankMessageError } from '../../../errors'
import { calculatePassword2Hash, calculatePasswordHash } from '../prior'
```

- [ ] **Step 2: Add test for maintenance error on Login**

Append after the existing test in the file:

```js
test('throws BankMessageError for unknown errorMessage on Login', async () => {
  const login = 'test(login)'
  const password = 'test(password)'
  const accessToken = 'test(access_token)'
  const tokenType = 'bearer'
  const clientSecret = 'test(client_secret)'
  const loginSalt = 'saltsaltsaltsaltsaltsaltsaltsalt'

  global.ZenMoney = {
    isAccountSkipped: () => false,
    ...makePluginDataApi({}).methods
  }

  mockMobileToken({
    response: {
      access_token: accessToken,
      token_type: tokenType,
      client_secret: clientSecret
    }
  })

  mockGetSalt({
    tokenType,
    accessToken,
    clientSecret,
    login,
    response: {
      success: true,
      errorMessage: '',
      internalErrorCode: 0,
      externalErrorCode: '',
      token: false,
      tokenFields: null,
      result: { salt: loginSalt }
    }
  })

  mockLogin({
    tokenType,
    accessToken,
    clientSecret,
    login,
    hash: calculatePasswordHash({ loginSalt, password }),
    hash2: calculatePassword2Hash({ loginSalt, password }),
    response: {
      status: 200,
      body: {
        success: false,
        errorMessage: 'Подключение к системе в данный момент запрещено. На сайте ведутся технические работы',
        internalErrorCode: 0,
        externalErrorCode: '-20900',
        token: false,
        tokenFields: null,
        result: null
      }
    }
  })

  await expect(
    scrape({
      preferences: { login, password },
      fromDate: new Date('2026-05-21T00:00:00Z'),
      toDate: new Date('2026-05-21T12:00:00Z')
    })
  ).rejects.toBeInstanceOf(BankMessageError)
})
```

- [ ] **Step 3: Add test for missing salt from GetSalt**

Append another test after the one above:

```js
test('throws BankMessageError when GetSalt result has no salt field', async () => {
  const login = 'test(login)'
  const password = 'test(password)'
  const accessToken = 'test(access_token)'
  const tokenType = 'bearer'
  const clientSecret = 'test(client_secret)'

  global.ZenMoney = {
    isAccountSkipped: () => false,
    ...makePluginDataApi({}).methods
  }

  mockMobileToken({
    response: {
      access_token: accessToken,
      token_type: tokenType,
      client_secret: clientSecret
    }
  })

  mockGetSalt({
    tokenType,
    accessToken,
    clientSecret,
    login,
    response: {
      success: true,
      errorMessage: '',
      internalErrorCode: 0,
      externalErrorCode: '',
      token: false,
      tokenFields: null,
      result: {}
    }
  })

  await expect(
    scrape({
      preferences: { login, password },
      fromDate: new Date('2026-05-21T00:00:00Z'),
      toDate: new Date('2026-05-21T12:00:00Z')
    })
  ).rejects.toBeInstanceOf(BankMessageError)
})
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
cd src/services/bank/ZenPlugins
npm test src/plugins/priorbank/__tests__/index.login.test.js 2>&1 | tail -50
```

Expected: existing test still PASSES, both new tests FAIL (one crashes with TypeError, other with "Received undefined").

- [ ] **Step 5: Commit failing tests**

```bash
cd src/services/bank/ZenPlugins
git add src/plugins/priorbank/__tests__/index.login.test.js
git commit -m "test(priorbank): failing tests for unknown error and missing salt"
```

---

### Task 2: Fix assertResponseSuccess catch-all

**Files:**
- Modify: `src/services/bank/ZenPlugins/src/plugins/priorbank/prior.js:10-25`

Current code:
```js
export function assertResponseSuccess (response) {
  if (response.body && response.body.success === false && response.body.errorMessage) {
    const message = response.body.errorMessage
    if (message === 'Неверный логин или пароль') {
      throw new InvalidLoginOrPasswordError()
    }
    if ([
      'Услуга временно заблокирована',
      'Услуга заблокирована до активации',
      'Ошибка на сервере'
    ].some(pattern => message.indexOf(pattern) >= 0)) {
      throw new BankMessageError(message)
    }
  }
  console.assert(isSuccessfulResponse(response), 'non-successful response', response)
}
```

- [ ] **Step 1: Add catch-all throw**

Replace the function with (add one line before the closing `}`):

```js
export function assertResponseSuccess (response) {
  if (response.body && response.body.success === false && response.body.errorMessage) {
    const message = response.body.errorMessage
    if (message === 'Неверный логин или пароль') {
      throw new InvalidLoginOrPasswordError()
    }
    if ([
      'Услуга временно заблокирована',
      'Услуга заблокирована до активации',
      'Ошибка на сервере'
    ].some(pattern => message.indexOf(pattern) >= 0)) {
      throw new BankMessageError(message)
    }
    throw new BankMessageError(message)
  }
  console.assert(isSuccessfulResponse(response), 'non-successful response', response)
}
```

- [ ] **Step 2: Run tests — first new test should now pass**

```bash
cd src/services/bank/ZenPlugins
npm test src/plugins/priorbank/__tests__/index.login.test.js 2>&1 | tail -40
```

Expected: "throws BankMessageError for unknown errorMessage on Login" — PASSES. "throws BankMessageError when GetSalt result has no salt field" — still FAILS.

---

### Task 3: Fix getSalt null guard

**Files:**
- Modify: `src/services/bank/ZenPlugins/src/plugins/priorbank/prior.js:43-58`

Current code (last two lines of function):
```js
  assertResponseSuccess(response)

  return response.body.result.salt
```

- [ ] **Step 1: Replace return with null-safe check**

```js
  assertResponseSuccess(response)

  const salt = response.body.result && response.body.result.salt
  if (!salt) {
    throw new BankMessageError('GetSalt: salt value not returned by server')
  }
  return salt
```

- [ ] **Step 2: Run all priorbank tests**

```bash
cd src/services/bank/ZenPlugins
npm test src/plugins/priorbank 2>&1 | tail -40
```

Expected: ALL 3 tests PASS.

- [ ] **Step 3: Commit both fixes**

```bash
cd src/services/bank/ZenPlugins
git add src/plugins/priorbank/prior.js
git commit -m "fix(priorbank): throw BankMessageError for unknown errors; guard missing salt in getSalt"
```

---

### Task 4: Push to fork

**Files:** none (git operation only)

- [ ] **Step 1: Push to fork master**

```bash
cd src/services/bank/ZenPlugins
git push fork tbc-otp-fix:master
```

Expected: push succeeds to `https://github.com/alex-mextner/ZenPlugins`. Confirm with `git log fork/master -3 --oneline`.

- [ ] **Step 2: Verify sync-service handles BankMessageError**

Read `src/services/bank/sync-service.ts` — check whether `BankMessageError` from ZenPlugins is caught and shown to the user in Telegram. If the error is swallowed silently, add handling so the error message reaches the user (not just increments consecutive_failures).

This step is READ-ONLY diagnosis — do not change sync-service unless the error is clearly unhandled.

---

## Self-review checklist

- [ ] All 3 tests pass after fix
- [ ] `assertResponseSuccess` throws for every `success: false` + `errorMessage` case
- [ ] `getSalt` never returns `undefined` or crashes with TypeError
- [ ] ZenPlugins conventions respected (no trailing semicolons, no bun:test imports)
- [ ] Changes pushed to fork
