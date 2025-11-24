# ExpenseSyncBot Project Guide

## Project Overview

ExpenseSyncBot is a Telegram bot for tracking expenses and syncing them to Google Sheets. It supports multi-currency expenses, AI-powered expense analysis, category detection, and budget management.

**Tech Stack:** Bun runtime, GramIO (Telegram), SQLite (bun:sqlite), googleapis, Hugging Face inference API

## Common Commands

### Development

```bash
# Run in development mode (with auto-reload)
bun run dev

# Run in production mode
bun run start

# Type checking
bun run type-check
# or directly:
bunx tsc --noEmit
```

### Deployment

The bot is deployed on Digital Ocean using PM2. See [DEPLOY.md](DEPLOY.md) for full deployment guide.

```bash
# PM2 commands (on server)
/var/www/.bun/bin/pm2 list
/var/www/.bun/bin/pm2 restart expensesyncbot
/var/www/.bun/bin/pm2 logs expensesyncbot
/var/www/.bun/bin/pm2 reload expensesyncbot  # zero-downtime restart
```

### Database

Database is SQLite at `./data/expenses.db`. Migrations run automatically on startup via [src/database/schema.ts](src/database/schema.ts).

```bash
# Access database directly
sqlite3 ./data/expenses.db
# Inside sqlite3: .tables, .schema users, SELECT * FROM users;
```

## Architecture

### Application Flow

```plain
index.ts (entry point)
├── src/database/ (initializes on import)
├── src/web/oauth-callback.ts (OAuth server on port 3000)
└── src/bot/ (Telegram bot)
```

### Key Architectural Patterns

#### 1. Repository Pattern for Data Access

All database operations go through repositories in `src/database/repositories/`:

- `group.repository.ts` - Group (chat) management
- `user.repository.ts` - User accounts and auth tokens
- `expense.repository.ts` - Expense records
- `category.repository.ts` - Expense categories
- `pending-expense.repository.ts` - Expenses awaiting confirmation
- `budget.repository.ts` - Budget tracking
- `chat-message.repository.ts` - AI conversation history

Access via singleton: `database.users`, `database.expenses`, etc.

#### 2. Google OAuth Flow

1. User sends `/connect` in Telegram
2. Bot generates OAuth URL and sends to user
3. User authorizes in browser
4. Google redirects to `http://localhost:3000/callback` (or production URL)
5. OAuth server exchanges code for tokens
6. Refresh token is encrypted and stored in database
7. Bot creates Google Sheet with formulas

**Key files:**

- [src/services/google/oauth.ts](src/services/google/oauth.ts) - OAuth client, token encryption/decryption
- [src/services/google/sheets.ts](src/services/google/sheets.ts) - Google Sheets API operations
- [src/web/oauth-callback.ts](src/web/oauth-callback.ts) - HTTP server for OAuth callback

#### 3. Expense Parsing & Multi-Currency Support

The bot parses expense messages in multiple formats (see README.md for examples).

**Currency detection:** `src/services/currency/parser.ts` handles:

- Currency symbol before/after amount: `$100`, `100€`, `₽500`
- Currency codes: `100 EUR`, `1900 RSD`
- Single letter aliases: `100е` (EUR), `100д` (USD) - Russian keyboard shortcuts
- Space-separated amounts: `1 900 RSD`

**Exchange rates:** `src/services/currency/converter.ts` - hardcoded exchange rates (updated manually)

**Category extraction:** First word after amount+currency is category, rest is comment.

#### 4. AI Integration (Hugging Face)

Bot can answer questions about expenses when mentioned in groups: `@botname question`

**Implementation:** [src/bot/commands/ask.ts](src/bot/commands/ask.ts)

- Uses Hugging Face Inference API (Qwen/QwQ-32B-Preview or meta-llama)
- Stores conversation history per group in `chat_messages` table
- Context includes: recent chat history, all expenses, all budgets, categories
- Uses custom system prompt defined per-group in `/prompt` command
- Daily advice feature (`/advice`) with scheduling

**AI Guidelines:** [src/bot/commands/ask.ts](src/bot/commands/ask.ts) contains thinking guidelines that enforce:

- No fictitious links/sources
- HTML formatting only (no markdown)
- Expense analysis based on actual data
- Budget awareness and recommendations

#### 5. State Management for User Flows

Bot uses callback queries (inline keyboards) and message handlers to manage multi-step flows:

- **OAuth setup:** currency selection → additional currencies → spreadsheet creation
- **New category confirmation:** detect new category → ask user to confirm/skip → save
- **Budget management:** create/view/edit budgets via inline keyboards

**Key files:**

- [src/bot/keyboards.ts](src/bot/keyboards.ts) - Inline keyboard builders
- [src/bot/handlers/callback.handler.ts](src/bot/handlers/callback.handler.ts) - Button click handlers
- [src/bot/handlers/message.handler.ts](src/bot/handlers/message.handler.ts) - Text message handlers

## Key Implementation Details

### Adding New Currency

1. Add aliases to `CURRENCY_ALIASES` in [src/config/constants.ts](src/config/constants.ts)
2. Add code to `SUPPORTED_CURRENCIES` array
3. Add symbol to `CURRENCY_SYMBOLS` map
4. Add exchange rate in [src/services/currency/converter.ts](src/services/currency/converter.ts)

### Google Sheets Structure

Created in [src/services/google/sheets.ts](src/services/google/sheets.ts):createSpreadsheet()

**Columns:**

- Date
- Category
- Comment
- Dynamic currency columns (based on user's enabled_currencies)
- EUR (calc) - calculated column with exchange rate formulas

**Important:** When adding expenses, find correct column by matching currency code in headers (row 1).

### Token Security

Google refresh tokens are encrypted using `ENCRYPTION_KEY` from env:

- Encryption: [src/services/google/oauth.ts](src/services/google/oauth.ts):encryptToken()
- Decryption: [src/services/google/oauth.ts](src/services/google/oauth.ts):decryptToken()
- Algorithm: AES-256-GCM

### Database Migrations

Migrations in [src/database/schema.ts](src/database/schema.ts) run on startup:

- Tracks applied migrations in `migrations` table
- Each migration has `name` and `up()` function
- **Never modify deployed migrations** - always add new ones
- Groups support was added in migration 007, users were migrated to groups

### Bot Commands

Defined in [src/bot/index.ts](src/bot/index.ts):

- `/start` - Welcome & setup status
- `/connect` - OAuth & initial setup
- `/spreadsheet` (aliases: `/table`, `/sheet`, `/t`) - View spreadsheet URL
- `/stats` - Expense statistics
- `/sum` (alias: `/total`) - Sum expenses by filters
- `/sync` - Manual sync to sheets
- `/budget` - Manage budgets
- `/categories` - List categories
- `/settings` - View settings
- `/reconnect` - Refresh OAuth
- `/advice` - Get AI daily advice (groups only)
- `/prompt` - Manage AI system prompt (groups only)

### Group vs Personal Mode

Bot supports both personal chats and groups:

- **Personal:** Each user has own spreadsheet, categories, expenses
- **Groups:** Shared spreadsheet/budget, multiple users contribute
- Group mode was added later (migration 007) - users table has group_id

Check chat type: `ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'`

## Important Patterns & Conventions

### Error Handling

- Display user-friendly errors in Telegram
- Log detailed errors to console
- Use try-catch in all async command handlers
- OAuth errors should prompt `/reconnect`

### Date Formatting

Uses `date-fns` library. Spreadsheet dates are in `DD.MM.YYYY` format (European).

### Currency Formatting

Uses `currency.js` library. Display format matches currency (e.g., `$100.50`, `€50,00`, `1 900 RSD`).

### Testing

Currently minimal tests. Test file example: [src/services/currency/parser.test.ts](src/services/currency/parser.test.ts)

```bash
bun test
```

## Environment Variables

Required in `.env` (see [.env.example](.env.example)):

- `BOT_TOKEN` - from @BotFather
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - from Google Cloud Console
- `GOOGLE_REDIRECT_URI` - OAuth callback URL
- `OAUTH_SERVER_PORT` - default 3000
- `DATABASE_PATH` - SQLite database path
- `ENCRYPTION_KEY` - 32-byte hex (generate: `openssl rand -hex 32`)
- `NODE_ENV` - development/production
- `HF_TOKEN` - Hugging Face API token (for AI features)

## Production Deployment

- **Server:** Digital Ocean (www-data user)
- **Process Manager:** PM2
- **Reverse Proxy:** Caddy (for HTTPS OAuth callback)
- **Auto-deploy:** GitHub Actions on push to main
- **Logs:** PM2 logs at `/var/www/ExpenseSyncBot/logs/`

See [DEPLOY.md](DEPLOY.md) for complete deployment guide.

## Common Gotchas

1. **Bun auto-loads .env** - don't use dotenv package
2. **SQLite foreign keys** - enabled via PRAGMA, ensure referential integrity
3. **Google Sheets column indexing** - 1-based, not 0-based
4. **Currency symbols** - use constants from config, don't hardcode
5. **Telegram message IDs** - unique per chat, not global
6. **OAuth tokens** - always encrypted in database, never log plaintext
7. **Group migration** - old users have group_id=NULL, handle gracefully
8. **AI context size** - limit expense history to recent (e.g., 100000 items) to avoid token limits
9. **PM2 on server** - use full path `/var/www/.bun/bin/pm2`, not just `pm2`

## When Modifying Code

- **Adding commands:** Register in [src/bot/index.ts](src/bot/index.ts), create handler in `src/bot/commands/`
- **Database changes:** Add migration in [src/database/schema.ts](src/database/schema.ts), never modify existing migrations
- **New repositories:** Add to [src/database/index.ts](src/database/index.ts) and create in `src/database/repositories/`
- **Google Sheets changes:** Test locally first, ensure backward compatibility with existing sheets
- **AI prompt changes:** Update in [src/bot/commands/ask.ts](src/bot/commands/ask.ts), consider existing user prompts in database

---

## Default to using Bun instead of Node.js

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing with bun

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend with bun

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
