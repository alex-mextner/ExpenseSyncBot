# Telegram Mini App — Receipt Scanner + Analytics Dashboard

**Date:** 2026-03-30
**Branch:** worktree-feature+miniapp
**Status:** Draft v1

---

## Overview

A Telegram Mini App served at `https://expense-sync-bot-app.invntrm.ru` with two tabs:

1. **Receipt Scanner** — scans fiscal receipt QR codes via live video stream or processes receipt photos via OCR; sends to bot for parsing, confirms expenses inside the Mini App
2. **Dashboard** — configurable analytics dashboard with a widget registry, data sources including custom formulas, Tufte-inspired design

---

## Architecture

### Repo structure

```
repo/
├── src/                          # bot (unchanged)
├── miniapp/
│   ├── src/
│   │   ├── tabs/
│   │   │   ├── Scanner.tsx       # tab 1: receipt scanner (QR + OCR)
│   │   │   └── Dashboard.tsx     # tab 2: analytics
│   │   ├── widgets/              # widget registry
│   │   │   ├── registry.ts       # all widget type definitions
│   │   │   ├── StatCard.tsx
│   │   │   ├── Sparkline.tsx
│   │   │   ├── BarChart.tsx
│   │   │   ├── Heatmap.tsx
│   │   │   ├── BalanceLine.tsx
│   │   │   ├── KPIBand.tsx
│   │   │   ├── SmallMultiples.tsx
│   │   │   └── Ticker.tsx
│   │   ├── datasources/
│   │   │   ├── types.ts          # DataSource interface
│   │   │   ├── builtin.ts        # expenses, income, balance, categories
│   │   │   └── formula.ts        # expr-eval formula evaluator
│   │   ├── api/
│   │   │   ├── client.ts         # fetch wrapper with initData auth
│   │   │   ├── receipt.ts        # scan + confirm endpoints
│   │   │   └── analytics.ts      # analytics + dashboard config endpoints
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
└── src/web/
    ├── oauth-callback.ts         # unchanged
    └── miniapp-api.ts            # NEW: REST API for Mini App
```

### Hosting

- **Static files:** Caddy serves `miniapp/dist/` directly from disk on `expense-sync-bot-app.invntrm.ru`
- **API:** existing HTTP server (port 3000) gains `/api/*` routes — no new process
- **HTTPS:** Caddy handles TLS for both domains

**Integration pattern:** `src/web/miniapp-api.ts` exports a single `handleMiniAppRequest(req, res): Promise<boolean>` function (returns `true` if the path matched `/api/*`). `oauth-callback.ts` calls it at the top of the request handler before its own routing. This keeps both files independent without introducing a router framework.

**Caddyfile addition:**

```
expense-sync-bot-app.invntrm.ru {
  root * /var/www/ExpenseSyncBot/miniapp/dist
  file_server
  try_files {path} /index.html
}
```

**CORS:** `/api/*` adds `Access-Control-Allow-Origin: https://expense-sync-bot-app.invntrm.ru`

### Authentication

Every Mini App → API request carries `X-Telegram-Init-Data: <raw initData string>` header.
Server validates HMAC-SHA256 signature per Telegram spec using `BOT_TOKEN`.
Reject initData where `auth_date` is older than 5 minutes.
Extracts `user.id` → looks up user → resolves `group_id`.
If a user belongs to multiple groups: use the group from which the Mini App was opened
(passed as a query param `?groupId=<id>` in the Mini App URL, set by the bot when generating the button).

**groupId security:** server must verify that the user from initData is an actual member of the requested group (`users.telegram_id` → `groups.id` join). Requests with a forged groupId return 403.

---

## Environment

**`.env` additions:**

```
MINIAPP_URL=https://expense-sync-bot-app.invntrm.ru
```

---

## Tab 1: Receipt Scanner

### Happy path

> **QR receipt parsing is already implemented in the bot.** `/api/receipt/scan` just calls the existing parser. Adjust/fix as needed during integration.

1. User opens Mini App → Scanner tab is default
2. Camera permission requested → live video stream fills screen
3. `@zxing/browser` processes video frames client-side (~10 fps via canvas) — no server round-trip
4. QR detected as URL → haptic feedback (`Telegram.WebApp.HapticFeedback.notificationOccurred('success')`) → video stops
5. POST `/api/receipt/scan` with `{ qr: "<url>" }` → bot parses (OFD / Serbian eFiskal / etc.)
6. Bot returns `{ merchant, date, items: [{ name, amount, currency }] }`
7. Mini App shows confirmation card: items grouped by category (user can re-assign, merge, remove)
8. One expense created per unique category (sum of items in that category)
9. POST `/api/receipt/confirm` with `{ expenses: [{ category, amount, currency, comment }] }`
   — `comment` = item names joined by ", " for that category (e.g. "Milk, Bread, Yogurt")
10. Bot creates expenses in DB + syncs to Sheets → Mini App shows success

### Fallback flows

**QR not detected** (library fails to read):

- Option A: "Открой камеру телефона, скопируй ссылку из QR и вставь сюда" + URL input field
- Option B: "Сфотографируй чек целиком" → triggers OCR flow (photo upload → bot extracts items)

**QR detected but not a URL** (plain text, barcode, etc.):

- "В этой стране чеки без электронной версии — сфотографируй чек, считаем позиции"
- → OCR flow

### OCR flow

> **OCR is already implemented in the bot.** The task is to wire the existing logic to the `/api/receipt/ocr` endpoint. Adjust/fix as needed during integration.

1. User takes photo (native `<input type="file" accept="image/*" capture="environment">`)
2. **Client-side compression** before upload:
   - Draw image onto `<canvas>`, scale down so the long side ≤ 1800 px (preserving aspect ratio)
   - Export via `canvas.toBlob('image/jpeg', 0.85)`
   - Skip resize if image is already ≤ 1800 px on both sides, but still re-encode to JPEG
   - Target: ≤ 500 KB in practice; hard cap — abort if still > 2 MB after compression and show error
   - **Fallback** if `canvas.toBlob` is unavailable: send original file as-is, but block upload and show error if `file.size > 2 MB`
3. POST `/api/receipt/ocr` with compressed image (always JPEG regardless of input format)
4. Bot runs OCR → returns items list
5. Same confirmation card as happy path

### Country hint (visible by default, not behind `?`)

Shown above the viewfinder. Based on the group's active currencies — relevant countries shown inline. "Все страны →" opens a modal with the full list.

**Countries with QR codes on fiscal receipts (electronic system):**

| Country | System | API |
|---------|--------|-----|
| 🇷🇺 Russia | ОФД | `proverkacheka.com`, ФНС |
| 🇷🇸 Serbia | eFiskal | `suf.purs.gov.rs` |
| 🇧🇾 Belarus | ЭСЧФ / ЭКА | `vat.gov.by` |
| 🇰🇿 Kazakhstan | КФД | `cabinet.salyk.kz` |
| 🇬🇪 Georgia | RS GE | `rs.ge` |
| 🇦🇲 Armenia | ArmSoft | e-receipt portal |
| 🇦🇿 Azerbaijan | DGK | `e-qebz.gov.az` |
| 🇺🇿 Uzbekistan | SOLIQ | `soliq.uz` |
| 🇭🇷 Croatia | Fiscalizacija | `porezna-uprava.gov.hr` |
| 🇮🇹 Italy | Agenzia delle Entrate | `scontrino.agenziaentrate.gov.it` |
| 🇵🇹 Portugal | AT | `faturas.portaldasfinancas.gov.pt` |
| 🇲🇪 Montenegro | eFiskal | same system as Serbia |
| 🇹🇷 Turkey | e-Arşiv Fatura | `earsivportal.efatura.gov.tr` |

*Note: list to be refined with research results — see background agent output.*

**Countries where OCR is the only option:**
Germany, France, Spain, UK, Netherlands, USA, Canada, Sweden, Norway, and most of Western Europe.

### UI details

- Viewfinder with targeting frame + animated scan line
- Torch button (flashlight): `ImageCapture.setOptions({ torch: true })`
- Flip camera button (front/back)
- Country hint strip above viewfinder (compact, collapsible)

---

## Tab 2: Dashboard

### Architecture: two independent layers

```
Data Sources
├── Built-in variables: income, expenses, savings, balance,
│   expenses.<category>, income.<source>, per-period aggregates
└── Formula: user-defined expression evaluated by expr-eval
    e.g. "expenses.food / income * 100"
              ↓
         Any data source connects to any widget input

Widgets (visualizations)
├── StatCard      — large number + optional sparkline background + delta
├── KPIBand       — row of StatCards (income / expenses / balance)
├── Ticker        — compact number + mini sparkline inline
├── Sparkline     — trend line, minimal axes
├── BarChart      — horizontal bars by category or time, no grid
├── BalanceLine   — balance over time + forecast line + cashflow gap markers
├── Heatmap       — calendar heatmap (GitHub-style, daily spending intensity)
└── SmallMultiples — grid of sparklines, one per category
```

### Widget config schema

```typescript
interface WidgetConfig {
  id: string
  type: WidgetType
  label: string
  inputs: Record<string, DataSourceRef | DataSourceRef[]>  // scalar or array inputs
  period?: '7d' | '30d' | '3m' | '12m'
  position: number  // float-based order; insert between A and B → (A+B)/2, renormalize when gap < 0.001
}

type DataSourceRef =
  | { builtin: BuiltinKey }              // e.g. { builtin: 'expenses.food' }
  | { formula: string }                  // e.g. { formula: 'savings / income * 100' }
  | { const: number }                    // e.g. { const: 15 }
```

### Widget inputs by type

| Widget | Inputs |
|--------|--------|
| StatCard | `value`, `target?`, `comparison?` (prev period) |
| KPIBand | `items[]` (array of value + label) |
| Sparkline | `series` (array of { date, value }) |
| BarChart | `series` (array of { label, value }) |
| BalanceLine | `balance` (timeseries), `forecast?` |
| Heatmap | `series` (array of { date, value }) |
| SmallMultiples | `categories[]` |

### Tufte principles in implementation

- No grid lines by default — axis marks only where they add information
- No legend if data is labeled directly
- Color as data only: green/red for delta, single hue for neutral series
- Sparklines everywhere possible instead of full-size charts
- Numbers rendered directly on chart elements, not in tooltips
- Maximum data-ink ratio: chart chrome (borders, backgrounds) is transparent

### Dashboard editor

- Tap "+" to open widget catalog → pick type → configure inputs → save
- Drag to reorder widgets
- Tap widget → edit / remove
- Config persisted to server (SQLite) per `group_id`

---

## API Endpoints

All routes in `src/web/miniapp-api.ts`. Auth: HMAC `initData` validation on every request.

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/api/receipt/scan` | `{ qr: string, groupId: number }` | `{ merchant, date, items[] }` |
| POST | `/api/receipt/ocr` | multipart image + `groupId` field | `{ merchant, date, items[] }` |
| POST | `/api/receipt/confirm` | `{ groupId: number, expenses[] }` | `{ created: number }` |
| GET | `/api/analytics` | query: `period`, `groupId` | built-in data source values |
| GET | `/api/dashboard` | query: `groupId` | `{ widgets: WidgetConfig[], updatedAt: string }` |
| PUT | `/api/dashboard` | `{ groupId: number, widgets: WidgetConfig[], updatedAt: string }` | `{ ok: true }` |
| GET | `/api/dashboard/events` | query: `groupId`, `initData` | `text/event-stream` (see Dashboard real-time updates) |

**OCR upload:** max 2 MB (client always compresses before upload — see OCR flow). Server-side MIME check: `image/jpeg` only (client always re-encodes to JPEG).

**Error response** (all endpoints):
```json
{ "error": "description", "code": "INVALID_GROUP" }
```
Codes: `INVALID_INIT_DATA`, `INIT_DATA_EXPIRED`, `FORBIDDEN_GROUP`, `NO_GROUP` (user not in any group — open from group), `NOT_FOUND`, `CONFLICT` (optimistic lock mismatch), `INTERNAL`.

**Optimistic lock (`PUT /api/dashboard`):** server compares incoming `updatedAt` with stored value. If mismatch → `409 CONFLICT`.

---

## Database

**New migration** in `src/database/schema.ts`:

```sql
CREATE TABLE dashboard_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  config TEXT NOT NULL,   -- JSON: WidgetConfig[]
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_dashboard_widgets_group ON dashboard_widgets(group_id);
```

One row per **user × group** — each user has their own dashboard layout scoped to a group. Config is a JSON blob.
`updated_at` is refreshed on every write and used as optimistic lock: `PUT /api/dashboard` rejects with 409 if the client's `updatedAt` doesn't match the stored value.

**Migration (updated):**

```sql
CREATE TABLE dashboard_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  config   TEXT NOT NULL,   -- JSON: WidgetConfig[]
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_dashboard_widgets_user_group ON dashboard_widgets(group_id, user_id);
```

`user_id` is resolved from `initData.user.id` on every request — no client input needed.

**New column on `expenses` table:**

```sql
ALTER TABLE expenses ADD COLUMN receipt_file_id TEXT;  -- Telegram file_id, nullable
```

---

## Receipt photo storage

Photos are **never saved to disk**. The multipart body is parsed into an in-memory buffer only.

Processing order — **temp buffer must be cleaned up regardless of outcome:**

```
parse multipart → buffer in memory
  → OCR
  → sendDocument to Telegram → file_id
  → store file_id in DB
  → [success or error]
  → free buffer  ← mandatory, even on exception
```

In practice: wrap the handler in try/finally, nullify the buffer reference in `finally`. If `sendDocument` fails, still free the buffer and return an error — do not retry with the buffer held.

**Hard rule: no `fs.writeFile`, no temp directory, no streaming to disk at any point in the OCR pipeline.**

**Why Telegram storage:** Telegram keeps files indefinitely for bots that uploaded them; `getFile` retrieves a download URL on demand. Zero storage cost, zero maintenance.

**Future use:**
- AI agent: pass `file_id` → `getFile` → download URL → include image in LLM context for visual expense analysis
- Mini App: show receipt thumbnail inline in expense history (future tab)

---

## Formula autocompletion / variable explorer

Formula inputs in the dashboard editor show live autocomplete for built-in variables.

**Variable explorer panel** (shown when formula input is focused):
- Lists all available `BuiltinKey` values grouped by category: `expenses.*`, `income.*`, `balance`, `savings`
- `expenses.<category>` keys are populated dynamically from `/api/analytics` response (actual group categories)
- Each variable shows its current value for the selected period as a hint

**Autocomplete behavior:**
- Trigger: user types `expenses.` → dropdown shows matching category keys
- Trigger: user types any letter → fuzzy-match against all known keys
- Selecting a variable inserts it at cursor position
- Formula validated in real time via `expr-eval`; invalid formula shows red border + error message

**No new API endpoint needed** — variable list is derived client-side from the `BuiltinKey` type + category list already returned by `GET /api/analytics`.

---

## Build & Deploy

**Build step** added to GitHub Actions after `git pull`:

```bash
cd /var/www/ExpenseSyncBot/miniapp
bun install --frozen-lockfile
bun run build
```

**Caddy config** (addition):

```
expense-sync-bot-app.invntrm.ru {
  root * /var/www/ExpenseSyncBot/miniapp/dist
  file_server
  try_files {path} /index.html
}
```

---

## Bot-side changes

- Register Mini App button via BotFather (`/newapp`)
- `MINIAPP_URL` env var used when generating Mini App buttons

### How the Mini App is opened from the group

The Mini App URL always includes `?groupId=<telegram_group_id>` so the server can resolve context without asking the user.

**Entry points:**

1. **Persistent menu button** — set once during `/connect` setup via `setChatMenuButton`:
   ```ts
   bot.api.setChatMenuButton({
     chat_id: group.telegram_group_id,
     menu_button: {
       type: 'web_app',
       text: 'Расходы',
       web_app: { url: `${env.MINIAPP_URL}?groupId=${group.telegram_group_id}` },
     },
   })
   ```
   This puts a persistent "Расходы" button in the text input bar — always visible, no command needed.

2. **Inline buttons in existing commands** — `/stats`, `/budget`, `/sum` each get a secondary button «📊 Дашборд» that opens the Dashboard tab:
   ```
   ${env.MINIAPP_URL}?groupId=${group.telegram_group_id}&tab=dashboard
   ```

3. **Scanner entry point** — expense confirmation flows and `/scan` command include «📷 Сканировать чек»:
   ```
   ${env.MINIAPP_URL}?groupId=${group.telegram_group_id}&tab=scanner
   ```

**`tab` query param** is read by `main.tsx` on load to set the initial active tab (`scanner` | `dashboard`, default `scanner`).

**No-group error:** if user opens the Mini App URL without a valid `groupId` (direct link, wrong id), show a static screen: "Открой эту кнопку из группы с ботом" — no onboarding, that's the bot's responsibility.

- `src/web/miniapp-api.ts` registered in `src/web/oauth-callback.ts` server setup

---

## Dashboard real-time updates

Dashboard uses **SSE** (Server-Sent Events) — not WebSocket. Dashboard is read-only: server pushes, client only listens. WS is bidirectional and adds unnecessary handshake complexity.

**SSE endpoint:**

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/api/dashboard/events` | query: `groupId`, `initData` (URL-encoded) | `text/event-stream` |

`initData` is passed as query param because `EventSource` does not support custom headers.

**Event types:**
```
event: expense_added
data: {"groupId": 42}

event: budget_updated
data: {"groupId": 42}

event: ping
data: {}
```

Client re-fetches `/api/dashboard` and `/api/analytics` on any event. Server sends `ping` every 30 seconds to keep the connection alive through proxies.

**Reconnect:** `EventSource` reconnects automatically. On reconnect the client re-fetches immediately (missed events are not replayed — a full fetch is cheaper than event sourcing).

**Fallback:** if `EventSource` is unavailable (blocked proxy, etc.), fall back to 60-second polling via `setInterval`.

---

## Out of scope (first version)

- Widget sharing between groups
