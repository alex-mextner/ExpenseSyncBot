# Telegram Mini App — QR Scanner + Analytics Dashboard

**Date:** 2026-03-30
**Branch:** worktree-feature+miniapp
**Status:** Draft v1

---

## Overview

A Telegram Mini App served at `https://expense-sync-bot-app.invntrm.ru` with two tabs:
1. **QR Scanner** — scans fiscal receipt QR codes via live video stream (client-side), sends to bot for parsing, confirms expenses inside the Mini App
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
│   │   │   ├── Scanner.tsx       # tab 1: QR camera
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
Extracts `user.id` → looks up user → resolves `group_id`.
If a user belongs to multiple groups: use the group from which the Mini App was opened
(passed as a query param `?groupId=<id>` in the Mini App URL, set by the bot when generating the button).

---

## Environment

**`.env` additions:**
```
MINIAPP_URL=https://expense-sync-bot-app.invntrm.ru
```

---

## Tab 1: QR Scanner

### Happy path

1. User opens Mini App → Scanner tab is default
2. Camera permission requested → live video stream fills screen
3. `@zxing/browser` processes video frames client-side (~10 fps via canvas) — no server round-trip
4. QR detected as URL → haptic feedback (`Telegram.WebApp.HapticFeedback.notificationOccurred('success')`) → video stops
5. POST `/api/receipt/scan` with `{ qr: "<url>" }` → bot parses (OFD / Serbian eFiskal / etc.)
6. Bot returns `{ merchant, date, items: [{ name, amount, currency }] }`
7. Mini App shows confirmation card: items grouped by category (user can re-assign, merge, remove)
8. One expense created per unique category (sum of items in that category)
9. POST `/api/receipt/confirm` with `{ expenses: [{ category, amount, currency, comment }] }`
10. Bot creates expenses in DB + syncs to Sheets → Mini App shows success

### Fallback flows

**QR not detected** (library fails to read):
- Option A: "Открой камеру телефона, скопируй ссылку из QR и вставь сюда" + URL input field
- Option B: "Сфотографируй чек целиком" → triggers OCR flow (photo upload → bot extracts items)

**QR detected but not a URL** (plain text, barcode, etc.):
- "В этой стране чеки без электронной версии — сфотографируй чек, считаем позиции"
- → OCR flow

### OCR flow

1. User takes photo (native `<input type="file" accept="image/*" capture="environment">`)
2. POST `/api/receipt/ocr` with image
3. Bot runs OCR → returns items list
4. Same confirmation card as happy path

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
  inputs: Record<string, DataSourceRef>  // named inputs
  period?: '7d' | '30d' | '3m' | '12m'
  position: number                        // order in dashboard
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
| POST | `/api/receipt/scan` | `{ qr: string }` | `{ merchant, date, items[] }` |
| POST | `/api/receipt/ocr` | multipart image | `{ merchant, date, items[] }` |
| POST | `/api/receipt/confirm` | `{ expenses[] }` | `{ created: number }` |
| GET | `/api/analytics` | query: `period`, `groupId` | built-in data source values |
| GET | `/api/dashboard` | — | `{ widgets: WidgetConfig[] }` |
| PUT | `/api/dashboard` | `{ widgets: WidgetConfig[] }` | `{ ok: true }` |

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

One row per group — the full widget array is stored as a JSON blob in `config`.

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
- `MINIAPP_URL` env var used when sending Mini App keyboard button from bot
- New command or inline button: «📊 Открыть дашборд» → opens Mini App on Dashboard tab
- Camera button in confirmation flows → opens Mini App on Scanner tab
- `src/web/miniapp-api.ts` registered in `src/web/oauth-callback.ts` server setup

---

## Out of scope (first version)

- Real-time updates / WebSocket (polling is fine for v1)
- Receipt storage (photos saved to disk)
- Per-user (vs per-group) dashboard configs
- Widget sharing between groups
- Formula autocompletion / variable explorer UI
