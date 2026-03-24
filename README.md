# ExpenseSyncBot

Telegram bot for tracking expenses and syncing them to Google Sheets.

## Features

- 💰 Track expenses via Telegram messages
- 📊 Automatic sync to Google Sheets
- 💱 Multi-currency support (USD, EUR, RUB, RSD, GBP, CHF, JPY, CNY, INR)
- 🏷️ Automatic category detection with confirmation
- 📈 Statistics and expense analysis
- 🔐 Secure OAuth2 authentication with Google
- 🤖 AI-powered expense analysis and advice (Hugging Face)
- 💼 Budget management and tracking
- 👥 Group chat support with shared expenses
- 🗓️ Daily AI financial advice (scheduled)

## Supported Expense Formats

The bot understands various expense formats:

```plain
190 евро Alex hobby
190е Alex hobby
190д Alex hobby
190$ Alex hobby
190 $ Alex hobby
$190 Alex hobby
$ 190 евро Alex hobby
190 euro Alex hobby
190 Eur Alex hobby
190 EUR Alex hobby
1 900 RSD    Lena hobby theater
```

Format: `[amount] [currency?] [category] [comment]`

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Create Telegram Bot

1. Open [@BotFather](https://t.me/botfather) in Telegram
2. Send `/newbot` and follow instructions
3. Copy the bot token

### 3. Setup Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google Sheets API and Google Drive API:
   - APIs & Services → Library
   - Search for "Google Sheets API" and enable
   - Search for "Google Drive API" and enable
4. Create OAuth 2.0 credentials:
   - APIs & Services → Credentials
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: "Web application"
   - Authorized redirect URIs: `http://localhost:3000/callback`
   - Copy Client ID and Client Secret

### 4. Setup Hugging Face (Optional, for AI features)

1. Go to [Hugging Face](https://huggingface.co/)
2. Create account or sign in
3. Go to Settings → Access Tokens
4. Create new token with "Read" access
5. Copy the token (starts with `hf_...`)

### 5. Configure Environment

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Telegram Bot (from @BotFather)
BOT_TOKEN=your_telegram_bot_token

# Google OAuth (from Google Cloud Console)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/callback

# OAuth Server
OAUTH_SERVER_PORT=3000

# Database
DATABASE_PATH=./data/expenses.db

# Encryption (generate with: openssl rand -hex 32)
ENCRYPTION_KEY=your_32_byte_hex_encryption_key

# Environment
NODE_ENV=development

# Hugging Face (optional, for AI features)
HF_TOKEN=your_hugging_face_api_token
```

Generate encryption key:

```bash
openssl rand -hex 32
```

### 6. Run the Bot

Development mode (with auto-reload):

```bash
bun run dev
```

Production mode:

```bash
bun run start
```

You should see:

```plain
🚀 Starting ExpenseSyncBot...

📦 Initializing database...
✓ Database ready

🌐 Starting OAuth server...
✓ OAuth server running on http://localhost:3000

🤖 Starting Telegram bot...
✓ Bot started successfully

✅ ExpenseSyncBot is running!

Press Ctrl+C to stop
```

## Usage

### Initial Setup

1. Start a chat with your bot in Telegram
2. Send `/start`
3. Send `/connect` to begin Google authorization
4. Click the authorization link
5. Grant permissions in Google
6. Select default currency
7. Select additional currencies
8. Bot will create a Google Sheet and you're ready!

### Adding Expenses

Simply send a message in any supported format:

```plain
100 еда обед в ресторане
50$ транспорт такси
1900 RSD развлечения кино
```

The bot will:

1. Parse the expense
2. Show you the parsed data
3. Ask for confirmation if it's a new category
4. Save to Google Sheets
5. Confirm the save

### Commands

**Basic Commands:**

- `/start` - Welcome message and setup status
- `/connect` - Connect Google account and setup
- `/reconnect` - Reconnect Google account

**Expense Management:**

- `/stats` - View expense statistics
- `/sum` (or `/total`) - Sum expenses by filters (category, currency, date range)
- `/sync` - Manual sync to Google Sheets
- `/categories` - List all categories

**Budget & Planning:**

- `/budget` - Create and manage budgets

**Spreadsheet:**

- `/spreadsheet` - Get link to your Google Sheet

**AI Features (Groups):**

- `@botname <question>` - Ask AI about your expenses (mention bot in groups)
- `/advice` - Get daily AI financial advice
- `/prompt` - Manage custom AI system prompt for your group

**Settings:**

- `/settings` - View current settings

### AI Features

The bot includes AI-powered expense analysis using Hugging Face models:

- **Ask Questions:** Mention the bot in group chats with your question (e.g., `@botname how much did I spend on food this month?`)
- **Daily Advice:** Set up scheduled financial advice using `/advice` command
- **Custom Prompts:** Configure AI behavior per-group using `/prompt` command
- **Context-Aware:** AI has access to all expenses, budgets, and categories

AI features require `HF_TOKEN` in `.env` file.

### Group Support

The bot works in both personal chats and group chats:

- **Personal:** Each user has their own spreadsheet, categories, and expenses
- **Groups:** Shared spreadsheet and budgets, multiple users can contribute expenses
- AI features are available in groups (mention bot to ask questions)

## Architecture

```plain
src/
├── bot/
│   ├── commands/        # Bot commands (/start, /connect, etc.)
│   ├── handlers/        # Message and callback handlers
│   └── keyboards.ts     # Inline keyboard builders
├── database/
│   ├── repositories/    # Data access layer
│   ├── schema.ts        # Database migrations
│   └── types.ts         # TypeScript types
├── services/
│   ├── google/
│   │   ├── oauth.ts     # OAuth2 flow
│   │   └── sheets.ts    # Google Sheets API
│   └── currency/
│       ├── parser.ts    # Expense message parser
│       └── converter.ts # Currency conversion
├── web/
│   └── oauth-callback.ts # OAuth callback server
└── config/
    ├── constants.ts     # App constants
    └── env.ts          # Environment config
```

## Technology Stack

- **Runtime**: [Bun](https://bun.sh)
- **Telegram**: [GramIO](https://gramio.dev)
- **Database**: SQLite (bun:sqlite)
- **Google API**: [googleapis](https://github.com/googleapis/google-api-nodejs-client)
- **AI**: [Hugging Face Inference API](https://huggingface.co/docs/api-inference)
- **Currency**: [currency.js](https://currency.js.org)
- **Date Utils**: [date-fns](https://date-fns.org)

## Development

### Commands

```bash
# Development mode with auto-reload
bun run dev

# Production mode
bun run start

# Type checking
bun run type-check
# or directly:
bunx tsc --noEmit
```

### Database

SQLite database is stored in `./data/expenses.db` (gitignored).

Migrations run automatically on startup. See [src/database/schema.ts](src/database/schema.ts) for migration logic.

**Important:** Never modify deployed migrations - always add new ones.

### Adding New Currency

Edit [src/config/constants.ts](src/config/constants.ts):

1. Add aliases to `CURRENCY_ALIASES`
2. Add code to `SUPPORTED_CURRENCIES`
3. Add symbol to `CURRENCY_SYMBOLS`
4. Add exchange rate in [src/services/currency/converter.ts](src/services/currency/converter.ts)

### Adding New Bot Commands

1. Create handler in `src/bot/commands/`
2. Register in [src/bot/index.ts](src/bot/index.ts)
3. Add to README commands list

## Production Deployment

The bot is deployed on Digital Ocean using PM2 process manager. See [DEPLOY.md](DEPLOY.md) for complete deployment guide.

**Key features:**

- PM2 for process management and auto-restart
- Caddy reverse proxy for HTTPS OAuth callbacks
- GitHub Actions for auto-deployment
- SQLite database persisted in `./data/`

## Troubleshooting

### OAuth Error: redirect_uri_mismatch

Make sure the redirect URI in `.env` matches exactly what you configured in Google Cloud Console.

### Bot doesn't respond

1. Check bot token is correct
2. Make sure bot is running (`bun run dev` or `bun run start`)
3. Check logs for errors

### Google Sheets not updating

1. Check OAuth token is valid (`/reconnect`)
2. Verify spreadsheet wasn't deleted
3. Check Google API quotas

### AI features not working

1. Verify `HF_TOKEN` is set in `.env`
2. Check Hugging Face API status
3. Make sure you're using the bot in a group (for AI questions)
4. Check logs for API errors

## License

MIT

## Credits

Built with Bun, GramIO, Claude code, and ❤️
