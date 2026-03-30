// Command guards — reusable wrappers that enforce pre-conditions before handlers run.

import { database } from '../database';
import type { Group } from '../database/types';
import type { Ctx } from './types';

/** Handler that receives a resolved group — no need for manual group lookup. */
export type GroupCommandHandler = (ctx: Ctx['Command'], group: Group) => Promise<void>;

/**
 * Wraps a command handler with group-existence checks.
 * Rejects commands in private chats and groups that haven't run /connect yet.
 */
export function requireGroup(handler: GroupCommandHandler): (ctx: Ctx['Command']) => Promise<void> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    if (!chatId || !isGroup) {
      await ctx.send('❌ Эта команда работает только в группах.');
      return;
    }

    const group = database.groups.findByTelegramGroupId(chatId);
    if (!group) {
      await ctx.send('❌ Группа не настроена. Используй /connect');
      return;
    }

    return handler(ctx, group);
  };
}
