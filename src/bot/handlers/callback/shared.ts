/**
 * Helpers shared by the callback-query handlers: the route-call shape, group/user
 * resolution, and the "delete the prompt message" / "answer with a fixed text" idioms.
 */
import { database } from '../../../database';
import type { Group, User } from '../../../database/types';
import type { BotInstance, Ctx } from '../../types';
import { trackMembership } from '../message.handler';

export type CallbackCtx = Ctx['CallbackQuery'];

/** Everything the dispatcher knows about one callback query. */
export interface RouteCall {
  ctx: CallbackCtx;
  /** `callback_data` segments after the action name, split on ":" */
  params: string[];
  bot: BotInstance;
  chatId: number | undefined;
  telegramId: number;
}

export type RouteHandler = (call: RouteCall) => Promise<void>;

export interface UserGroup {
  user: User;
  group: Group;
}

/**
 * Ensure user exists and is linked to group from chat
 * Creates user if not exists, updates group_id if changed
 */
export function ensureUserInGroup(
  telegramId: number,
  chatId: number | undefined,
): UserGroup | null {
  if (!chatId) return null;

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return null;

  let user = database.users.findByTelegramId(telegramId);

  if (!user) {
    user = database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  } else if (user.group_id !== group.id) {
    database.users.update(telegramId, { group_id: group.id });
    user = database.users.findByTelegramId(telegramId);
  }

  // Track membership for private chat group buttons
  trackMembership(telegramId, group.id);

  return user ? { user, group } : null;
}

/** Resolve the caller's user + group, answering "group not configured" when impossible. */
export async function resolveUserGroup(
  ctx: CallbackCtx,
  telegramId: number,
): Promise<UserGroup | null> {
  const result = ensureUserInGroup(telegramId, ctx.message?.chat?.id);
  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return null;
  }
  return result;
}

/** Delete the message carrying the pressed button; errors propagate to the dispatcher. */
export async function deletePromptMessage(ctx: CallbackCtx, bot: BotInstance): Promise<void> {
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;
  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }
}

/** Delete the prompt message, ignoring failure (it may already be gone or too old). */
export async function deletePromptMessageQuietly(
  ctx: CallbackCtx,
  bot: BotInstance,
): Promise<void> {
  try {
    await deletePromptMessage(ctx, bot);
  } catch {
    // Expected: message may already be deleted
  }
}

/** Parse a decimal integer segment; null for a missing/empty/non-numeric segment. */
export function parseIntSegment(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

/** Create the category for the group unless it already exists. */
export function ensureCategory(groupId: number, name: string): void {
  if (!database.categories.exists(groupId, name)) {
    database.categories.create({ group_id: groupId, name });
  }
}
