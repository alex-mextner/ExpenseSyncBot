import { Bot } from "gramio";
import { env } from "../config/env";
import { handleStartCommand } from "./commands/start";
import { handleConnectCommand } from "./commands/connect";
import { handleStatsCommand } from "./commands/stats";
import { handleCategoriesCommand } from "./commands/categories";
import {
  handleSettingsCommand,
  handleReconnectCommand,
} from "./commands/settings";
import { handleExpenseMessage } from "./handlers/message.handler";
import { handleCallbackQuery } from "./handlers/callback.handler";

/**
 * Initialize and configure bot
 */
export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Commands
  bot.command("start", handleStartCommand);
  bot.command("connect", handleConnectCommand);
  bot.command("stats", handleStatsCommand);
  bot.command("categories", handleCategoriesCommand);
  bot.command("settings", handleSettingsCommand);
  bot.command("reconnect", handleReconnectCommand);

  // Callback queries (inline keyboard buttons)
  bot.on("callback_query", handleCallbackQuery);

  // Text messages (expense entries)
  bot.on("message", async (ctx) => {
    // Skip if it's a command
    if (ctx.text?.startsWith("/")) {
      return;
    }

    // Skip if no text
    if (!ctx.text) {
      return;
    }

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
