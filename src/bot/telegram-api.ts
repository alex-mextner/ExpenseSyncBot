import { env } from "../config/env";

/**
 * Base URL for Telegram Bot API
 */
const BASE_URL = `https://api.telegram.org/bot${env.BOT_TOKEN}`;

/**
 * Set message reaction
 * Available emojis: 👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍️ 🤗 🫡 🎅 🎄 ☃️ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡
 */
export async function setMessageReaction(
  chatId: number,
  messageId: number,
  emoji: string
): Promise<void> {
  const url = `${BASE_URL}/setMessageReaction`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [
        {
          type: "emoji",
          emoji,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set reaction: ${error}`);
  }
}

/**
 * Delete message
 */
export async function deleteMessage(
  chatId: number,
  messageId: number
): Promise<void> {
  const url = `${BASE_URL}/deleteMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete message: ${error}`);
  }
}
