import { Bot } from "gramio";
import { env } from "../config/env";
import { handleBudgetCommand } from "./commands/budget";
import { handleCategoriesCommand } from "./commands/categories";
import { handleConnectCommand } from "./commands/connect";
import {
  handleReconnectCommand,
  handleSettingsCommand,
} from "./commands/settings";
import { handleSpreadsheetCommand } from "./commands/spreadsheet";
import { handleStartCommand } from "./commands/start";
import { handleStatsCommand } from "./commands/stats";
import { handleSumCommand } from "./commands/sum";
import { handleSyncCommand } from "./commands/sync";
import { handleCallbackQuery } from "./handlers/callback.handler";
import { handleExpenseMessage } from "./handlers/message.handler";
import { handleAskQuestion } from "./commands/ask";

/**
 * Initialize and configure bot
 */
export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Cache bot username
  let botUsername: string | undefined;

  // Commands
  bot.command("start", handleStartCommand);
  bot.command("connect", handleConnectCommand);
  bot.command("spreadsheet", handleSpreadsheetCommand);
  bot.command("table", handleSpreadsheetCommand);
  bot.command("sheet", handleSpreadsheetCommand);
  bot.command("t", handleSpreadsheetCommand);
  bot.command("stats", handleStatsCommand);
  bot.command("sum", handleSumCommand);
  bot.command("total", handleSumCommand);
  bot.command("sync", handleSyncCommand);
  bot.command("budget", handleBudgetCommand);
  bot.command("categories", handleCategoriesCommand);
  bot.command("settings", handleSettingsCommand);
  bot.command("reconnect", handleReconnectCommand);

  // Callback queries (inline keyboard buttons)
  bot.on("callback_query", (ctx) => handleCallbackQuery(ctx, bot));

  // Text messages (expense entries or questions)
  bot.on("message", async (ctx) => {
    // Skip if it's a command
    if (ctx.text?.startsWith("/")) {
      return;
    }

    // Skip if no text
    if (!ctx.text) {
      return;
    }

    // Get bot username once
    if (!botUsername) {
      const botInfo = await bot.api.getMe();
      botUsername = botInfo.username;
    }

    const text = ctx.text;

    // Check for @botname mention
    if (botUsername) {
      const mentionPattern = new RegExp(`@${botUsername}\\s+(.+)`, "i");
      const match = text.match(mentionPattern);

      if (match?.[1]) {
        // Handle as question
        await handleAskQuestion(ctx, match[1].trim(), bot);
        return;
      }
    }

    // Handle as expense message
    await handleExpenseMessage(ctx);
  });

  return bot;
}

/**
 * Start bot
 */
export async function startBot(): Promise<void> {
  const bot = createBot();

  console.log("🤖 Starting bot...");
  await bot.start();
  console.log("✓ Bot started successfully");
}
