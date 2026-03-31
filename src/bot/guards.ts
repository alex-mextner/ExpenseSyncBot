// Command guards — reusable wrappers that enforce pre-conditions before handlers run.

import { database } from '../database';
import type { Group } from '../database/types';
import { sendToChat } from './send';
import type { Ctx } from './types';

/** Handler that receives a resolved group — no need for manual group lookup. */
export type GroupCommandHandler = (ctx: Ctx['Command'], group: Group) => Promise<void>;

/** Group with Google Sheets fully connected — both token and spreadsheet are present. */
export type GoogleConnectedGroup = Group & {
  google_refresh_token: string;
  spreadsheet_id: string;
};

/** Handler that receives a group guaranteed to have Google Sheets connected. */
export type GoogleCommandHandler = (
  ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
) => Promise<void>;

/**
 * Wraps a command handler with group-existence checks.
 * Rejects commands in private chats and groups that haven't run /connect yet.
 */
export function requireGroup(handler: GroupCommandHandler): (ctx: Ctx['Command']) => Promise<void> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    if (!chatId || !isGroup) {
      await sendToChat('❌ Эта команда работает только в группах.');
      return;
    }

    const group = database.groups.findByTelegramGroupId(chatId);
    if (!group) {
      await sendToChat('❌ Группа не настроена. Используй /connect');
      return;
    }

    return handler(ctx, group);
  };
}

/**
 * Composes on top of requireGroup — additionally checks that Google Sheets is connected.
 * Narrows the group type to GoogleConnectedGroup so downstream handlers
 * can safely access google_refresh_token and spreadsheet_id as strings.
 */
export function requireGoogle(handler: GoogleCommandHandler): GroupCommandHandler {
  return async (ctx, group) => {
    if (!group.spreadsheet_id || !group.google_refresh_token) {
      await sendToChat('❌ Google таблица не подключена. Используй /connect');
      return;
    }

    return handler(ctx, group as GoogleConnectedGroup);
  };
}
