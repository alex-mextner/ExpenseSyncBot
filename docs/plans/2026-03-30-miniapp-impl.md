# Mini App Implementation Plan

**Spec:** [docs/specs/2026-03-30-miniapp-design.md](../specs/2026-03-30-miniapp-design.md)
**Branch:** worktree-feature+miniapp
**Date:** 2026-03-30

---

## Phases

### Phase 1: Foundation

- [ ] **1.0** Verify current highest migration number in `src/database/schema.ts` before assigning 037/038 — adjust if main has added migrations since branch cut
- [ ] **1.1** DB migration 037 — `dashboard_widgets` table:
  ```sql
  CREATE TABLE dashboard_widgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    config   TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_dashboard_widgets_user_group ON dashboard_widgets(group_id, user_id);
  ```
- [ ] **1.2** DB migration 038 — `ALTER TABLE expenses ADD COLUMN receipt_file_id TEXT`
- [ ] **1.3** `src/config/env.ts` — add `MINIAPP_URL` (optional string; absence must not throw at startup — all features using it must be no-ops when absent)
- [ ] **1.4** `src/web/miniapp-api.ts` — skeleton with HMAC initData validation + `handleMiniAppRequest(req, res): Promise<boolean>`:
  - Validates HMAC-SHA256 signature per Telegram spec, rejects if `auth_date` > 5 min old
  - Extracts `user.id` from initData → looks up `users` row
  - `groupId` in all requests is `telegram_group_id` (the Telegram integer from the URL/body/query). Membership check: `SELECT g.id FROM groups g WHERE g.telegram_group_id = :groupId AND EXISTS (SELECT 1 FROM users u WHERE u.telegram_id = :userId AND u.group_id = g.id)` — return 403 FORBIDDEN_GROUP if no match
  - Returns `false` for any path that does not start with `/api/`
- [ ] **1.5** `src/web/oauth-callback.ts` — call `handleMiniAppRequest` at the top of the request handler (before OAuth routing); return early if it returns `true`
- [ ] **1.6** `biome.jsonc` — add `miniapp/` to the ignore list so Biome doesn't lint frontend code with bot rules (Biome v2+ syntax: `!miniapp`)

### Phase 2: Receipt API

- [ ] **2.1** `POST /api/receipt/scan` — body: `{ qr: string, groupId: number }` (groupId is `telegram_group_id`); verify group membership (from shared auth helper in 1.4); call existing QR parser; return `{ merchant, date, items[] }`
- [ ] **2.2** `POST /api/receipt/ocr` — multipart form: `image` file field + `groupId` text field (both required); verify group membership; JPEG only (server-side MIME check); max 2 MB after client compression; parse image into in-memory buffer — no `fs.writeFile`, no temp dir, no streaming to disk ever; call existing OCR logic; `sendDocument` to Telegram → store `file_id` in `expenses.receipt_file_id`; return `{ merchant, date, items[] }`; try/finally to nullify buffer regardless of outcome
- [ ] **2.3** `POST /api/receipt/confirm` — body: `{ groupId: number, expenses[] }`; verify group membership; create expenses in DB (with `receipt_file_id` if available from session) + sync to Sheets; emit SSE `expense_added` event for the group (see task 3.5); return `{ created: number }`

### Phase 3: Analytics & Dashboard API

- [ ] **3.1** `GET /api/analytics?period=&groupId=` — verify membership; return all built-in DataSource values: income, expenses, balance, savings, `expenses.<category>`, `income.<source>`, per-period aggregates
- [ ] **3.2** `GET /api/dashboard?groupId=` — verify membership; `user_id` resolved from initData (never from request body); return `{ widgets: WidgetConfig[], updatedAt: string }` for the `user_id × group_id` row
- [ ] **3.3** `PUT /api/dashboard` — body: `{ groupId: number, widgets: WidgetConfig[], updatedAt: string }`; verify membership; `user_id` from initData; compare incoming `updatedAt` with stored value — return 409 CONFLICT if mismatch; update config + refresh `updated_at`; return `{ ok: true }`
- [ ] **3.4** `GET /api/dashboard/events?groupId=&initData=` — SSE endpoint; `initData` as query param (EventSource does not support headers); same HMAC validation + membership check; emit `expense_added`, `budget_updated`, `ping` every 30s; keep SSE connection registry per group for task 3.5
- [ ] **3.5** SSE emitter module — in-process event bus keyed by `groups.id` (internal DB id, not telegram_group_id); `emitForGroup(groupId, eventType)` function; called by 2.3 on expense creation and by any future budget update path; clients on 3.4 subscribe/unsubscribe via connection lifecycle

### Phase 4: Bot-side changes

- [ ] **4.1** All four tasks below (4.2–4.4) must guard against `env.MINIAPP_URL` being undefined — if absent, skip button/menu setup silently (no throw, no log spam)
- [ ] **4.2** `/connect` flow — after successful OAuth setup, call `setChatMenuButton` with persistent "Расходы" web_app button: `{ url: \`${env.MINIAPP_URL}?groupId=${group.telegram_group_id}\` }`
- [ ] **4.3** `/stats`, `/budget`, `/sum` — add secondary inline button «📊 Дашборд» opening `?groupId=...&tab=dashboard`
- [ ] **4.4** `/scan` command + expense confirmation flows — add «📷 Сканировать чек» button opening `?groupId=...&tab=scanner`
- [ ] **4.5** BotFather prerequisite (manual, one-time) — register Mini App via `/newapp` in BotFather; document in deploy checklist. This must be done before any bot-side Mini App buttons work.

### Phase 5: Mini App Frontend

- [ ] **5.1** Project scaffold: `miniapp/package.json` (React 18, Vite, TypeScript, @telegram-apps/sdk, @zxing/browser, expr-eval, recharts or d3), `miniapp/vite.config.ts`, `miniapp/tsconfig.json`, `miniapp/index.html`
- [ ] **5.2** `miniapp/src/api/client.ts` — fetch wrapper that injects `X-Telegram-Init-Data` header on every request; reads `initData` from `window.Telegram.WebApp`
- [ ] **5.3** `miniapp/src/api/receipt.ts` — `scanQR()`, `uploadOCR()` (client-side JPEG compression before upload), `confirmExpenses()`
- [ ] **5.4** `miniapp/src/api/analytics.ts` — `getAnalytics()`, `getDashboard()`, `putDashboard()`, `subscribeDashboardEvents()`
- [ ] **5.5** `miniapp/src/main.tsx` — app entry point: reads `?tab=` + `?groupId=` query params; renders Scanner or Dashboard tab; shows static "Открой эту кнопку из группы с ботом" screen if groupId absent (no onboarding)
- [ ] **5.6** `miniapp/src/tabs/Scanner.tsx` — full scanner tab:
  - Live video via `@zxing/browser` at ~10 fps (canvas loop)
  - Viewfinder overlay with targeting frame + animated scan line
  - Torch button (`ImageCapture.setOptions({ torch: true })`) + flip camera button
  - Country hint strip above viewfinder (based on group currencies; compact, collapsible; "Все страны →" modal with full list)
  - On QR detect: haptic feedback (`Telegram.WebApp.HapticFeedback.notificationOccurred('success')`), stop video, POST `/api/receipt/scan`
  - Fallback A: URL input field ("вставь ссылку из QR")
  - Fallback B / non-URL QR / manual: OCR flow with `<input type="file" accept="image/*" capture="environment">`
  - Client-side JPEG compression (canvas, long side ≤ 1800px, 0.85 quality; skip resize if already ≤ 1800px but still re-encode; hard cap 2 MB after compression → abort + error; if `canvas.toBlob` unavailable → send original but block if > 2 MB)
  - Confirmation card: items grouped by category (re-assign, merge, remove); POST `/api/receipt/confirm`
- [ ] **5.7** `miniapp/src/datasources/types.ts` — `DataSource` interface, `BuiltinKey` type, `DataSourceRef` union
- [ ] **5.8** `miniapp/src/datasources/builtin.ts` — resolves `BuiltinKey` → value from `/api/analytics` response
- [ ] **5.9** `miniapp/src/datasources/formula.ts` — `expr-eval` evaluator with built-in variable injection
- [ ] **5.10** `miniapp/src/widgets/registry.ts` — `WidgetType` enum + `WidgetConfig` interface + registry map; define `Ticker` input schema here (not specified in spec — use `{ value, series }` matching StatCard pattern)
- [ ] **5.11** Widget components (Tufte principles: no grid, direct labels, max data-ink ratio):
  - `StatCard.tsx` — large number + optional sparkline background + delta; inputs: `value`, `target?`, `comparison?`
  - `KPIBand.tsx` — row of StatCards; inputs: `items[]`
  - `Ticker.tsx` — compact number + mini sparkline inline; inputs: `value`, `series?`
  - `Sparkline.tsx` — trend line, minimal axes; inputs: `series` (array of `{ date, value }`)
  - `BarChart.tsx` — horizontal bars by category or time, no grid; inputs: `series` (array of `{ label, value }`)
  - `BalanceLine.tsx` — balance over time + forecast line + cashflow gap markers; inputs: `balance`, `forecast?`
  - `Heatmap.tsx` — calendar heatmap (GitHub-style daily spending intensity); inputs: `series` (array of `{ date, value }`)
  - `SmallMultiples.tsx` — grid of sparklines, one per category; inputs: `categories[]`
- [ ] **5.12** `miniapp/src/tabs/Dashboard.tsx` — renders widget list; drag-to-reorder (float-based `position`; insert between A and B → `(A+B)/2`, renormalize when gap < 0.001); tap "+" → widget catalog; tap widget → edit/remove; SSE real-time updates with 60s polling fallback if EventSource unavailable
- [ ] **5.13** Dashboard editor — widget catalog modal; input config form per widget type; formula input with live autocomplete (variable explorer: grouped BuiltinKey list + current values as hints from `/api/analytics`; fuzzy match; real-time expr-eval validation with red border + error message on invalid formula)

### Phase 6: Build & Deploy

- [ ] **6.1** `.github/workflows/deploy.yml` (or existing workflow) — add `miniapp` build step after `git pull`: `cd /var/www/ExpenseSyncBot/miniapp && bun install --frozen-lockfile && bun run build`
- [ ] **6.2** `Caddyfile` — add `expense-sync-bot-app.invntrm.ru` block: `root * /var/www/ExpenseSyncBot/miniapp/dist`, `file_server`, `try_files {path} /index.html`
- [ ] **6.3** `.env.example` — add `MINIAPP_URL=https://expense-sync-bot-app.invntrm.ru`

---

## Key constraints (from spec)

- **Auth on every API call:** HMAC-SHA256 initData validation, reject if `auth_date` older than 5 min
- **`groupId` is always `telegram_group_id`** (Telegram integer) — membership check joins through `groups.telegram_group_id`; return 403 FORBIDDEN_GROUP on mismatch
- **`user_id` always from initData** — never from request body
- **OCR photos:** never write to disk — in-memory buffer only; try/finally to free buffer
- **SSE auth:** initData as query param (EventSource doesn't support headers)
- **Optimistic lock:** PUT /api/dashboard rejects 409 if updatedAt mismatch
- **CORS:** `/api/*` adds `Access-Control-Allow-Origin: https://expense-sync-bot-app.invntrm.ru`
- **No new process:** API runs on existing port 3000 HTTP server
- **MINIAPP_URL absent:** all bot-side Mini App features must be no-ops, not throw

---

## Out of scope (v1)

- Widget sharing between groups
- Expense history tab
- AI visual analysis using receipt file_id
