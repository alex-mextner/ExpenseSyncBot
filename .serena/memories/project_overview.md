# ExpenseSyncBot - Project Overview

## Purpose
Telegram bot for tracking expenses and syncing them to Google Sheets, with AI-powered analysis and budget management.

## Tech Stack
- **Runtime**: Bun (Node.js compatible)
- **Language**: TypeScript
- **APIs**: Google Sheets, Telegram (via gramio), Anthropic Claude, HuggingFace, Octokit
- **Key Libraries**: date-fns, big.js, currency.js, playwright, pino (logging)
- **Testing**: Bun test framework
- **Linting/Formatting**: Biome
- **Database**: Custom database abstraction (appears to be file/JSON-based)

## Key Commands
- `bun run dev` - Development mode with watch
- `bun run index.ts` - Start production
- `bun run lint` & `bun run lint:fix` - Linting
- `bun run test` - Run tests via custom test runner
- `bun run type-check` - TypeScript type checking

## Code Structure
- `src/` - Main source code
- `index.ts` - Entry point
- `bank-sync.ts` - Bank synchronization logic
- Test files throughout codebase

## Development Notes
- Uses Biome for code style (checking and formatting)
- TypeScript strict mode expected
- Distributed as Telegram bot with scheduled tasks
