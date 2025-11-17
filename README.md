# ExpenseSyncBot

Telegram bot for tracking expenses and syncing them to Google Sheets.

## Features

- 💰 Track expenses via Telegram messages
- 📊 Automatic sync to Google Sheets
- 💱 Multi-currency support (USD, EUR, RUB, RSD, GBP, CHF, JPY, CNY, INR)
- 🏷️ Automatic category detection with confirmation
- 📈 Statistics and expense analysis
- 🔐 Secure OAuth2 authentication with Google

## Supported Expense Formats

The bot understands various expense formats:

```
190 евро Алекс кулёма
190е Алекс кулёма
190д Алекс кулёма
190$ Алекс кулёма
190 $ Алекс кулёма
$190 Алекс кулёма
$ 190 евро Алекс кулёма
190 euro Алекс кулёма
190 Eur Алекс кулёма
190 EUR Алекс кулёма
1 900 RSD   Алекс транспорт
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

### 4. Configure Environment

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
```

Generate encryption key:

```bash
openssl rand -hex 32
```

### 5. Run the Bot

```bash
bun run index.ts
```

You should see:

```
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

```
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

- `/start` - Welcome message and setup status
- `/connect` - Connect Google account and setup
- `/stats` - View expense statistics
- `/categories` - List all categories
- `/settings` - View current settings
- `/reconnect` - Reconnect Google account

## Architecture

```
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
- **Currency**: [currency.js](https://currency.js.org)

## Development

### Database

SQLite database is stored in `./data/expenses.db` (gitignored).

Migrations run automatically on startup.

### Adding New Currency

Edit [src/config/constants.ts](src/config/constants.ts):

1. Add aliases to `CURRENCY_ALIASES`
2. Add code to `SUPPORTED_CURRENCIES`
3. Add symbol to `CURRENCY_SYMBOLS`
4. Add exchange rate in [src/services/currency/converter.ts](src/services/currency/converter.ts)

### Testing

```bash
# Run type check
bunx tsc --noEmit

# Format code
bunx prettier --write .
```

## Troubleshooting

### OAuth Error: redirect_uri_mismatch

Make sure the redirect URI in `.env` matches exactly what you configured in Google Cloud Console.

### Bot doesn't respond

1. Check bot token is correct
2. Make sure bot is running (`bun run index.ts`)
3. Check logs for errors

### Google Sheets not updating

1. Check OAuth token is valid (`/reconnect`)
2. Verify spreadsheet wasn't deleted
3. Check Google API quotas

## License

MIT

## Credits

Built with Bun, GramIO, and ❤️
