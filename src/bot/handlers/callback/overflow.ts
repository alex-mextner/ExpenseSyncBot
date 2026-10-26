/**
 * "sync_more" / "bsync_more" callbacks — send the part of a /sync or budget-sync report
 * that did not fit into the original notification (everything after the first 10 rows).
 */
import { sendMessage } from '../../../services/bank/telegram-sender';
import { createLogger } from '../../../utils/logger.ts';
import { formatReceiptCommentForTelegram } from '../../../utils/receipt-display';
import type { CallbackCtx } from './shared';

const logger = createLogger('callback.handler');

/** Rows already shown in the original notification */
const SHOWN_ROWS = 10;
const TELEGRAM_TEXT_LIMIT = 4096;

interface SyncOverflowItem {
  date: string;
  amount: number;
  currency: string;
  category: string;
  comment: string;
  field?: string;
}

interface BudgetOverflowItem {
  category: string;
  limit: number;
  currency: string;
  oldLimit?: number;
}

interface OverflowSections<T> {
  added: T[];
  deleted: T[];
  updated: T[];
}

/** Rows beyond the first 10 of the section named by the callback ("a" / "d" / anything else = updated). */
function overflowSection<T>(
  result: OverflowSections<T>,
  section: string,
): { items: T[]; label: string } {
  if (section === 'a') return { items: result.added.slice(SHOWN_ROWS), label: 'Добавлено' };
  if (section === 'd') return { items: result.deleted.slice(SHOWN_ROWS), label: 'Удалено' };
  return { items: result.updated.slice(SHOWN_ROWS), label: 'Обновлено' };
}

/** Answer the callback and send the lines, truncated to Telegram's message limit. */
async function sendOverflowLines(
  ctx: CallbackCtx,
  lines: string[],
  failureLog: string,
): Promise<void> {
  let text = lines.join('\n');
  if (text.length > TELEGRAM_TEXT_LIMIT) text = `${text.slice(0, TELEGRAM_TEXT_LIMIT - 6)}\n...`;

  await ctx.answerCallbackQuery();
  await sendMessage(text).catch((err: unknown) => logger.error({ err }, failureLog));
}

/** Parse "<cacheKey>:<section>"; answers "stale" and returns null when incomplete. */
async function parseOverflowParams(
  ctx: CallbackCtx,
  params: string[],
): Promise<{ cacheKey: string; section: string } | null> {
  const [cacheKey, section] = params;
  const chatId = ctx.message?.chat?.id;

  if (!cacheKey || !section || !chatId) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели' });
    return null;
  }
  return { cacheKey, section };
}

export async function handleSyncMoreCallback(ctx: CallbackCtx, params: string[]): Promise<void> {
  const parsed = await parseOverflowParams(ctx, params);
  if (!parsed) return;

  const { getSyncCachedResult } = await import('../../commands/sync');
  const result = getSyncCachedResult(parsed.cacheKey);
  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели. Выполни /sync заново.' });
    return;
  }

  const { items, label } = overflowSection<SyncOverflowItem>(result, parsed.section);

  const lines = [`📋 ${label} (ещё ${items.length}):`];
  for (const e of items) {
    const field = e.field ? ` (${e.field})` : '';
    const displayComment = e.comment ? ` ${formatReceiptCommentForTelegram(e.comment)}` : '';
    lines.push(`  ${e.date} ${e.amount} ${e.currency} ${e.category}${displayComment}${field}`);
  }

  await sendOverflowLines(ctx, lines, '[CALLBACK] sync_more send failed');
}

export async function handleBudgetSyncMoreCallback(
  ctx: CallbackCtx,
  params: string[],
): Promise<void> {
  const parsed = await parseOverflowParams(ctx, params);
  if (!parsed) return;

  const { getBudgetSyncCachedResult } = await import('../../services/budget-sync');
  const result = getBudgetSyncCachedResult(parsed.cacheKey);
  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели. Перезапусти бота.' });
    return;
  }

  const { items, label } = overflowSection<BudgetOverflowItem>(result, parsed.section);

  const lines = [`📋 Бюджеты — ${label} (ещё ${items.length}):`];
  for (const e of items) {
    const change = e.oldLimit !== undefined ? ` (было ${e.oldLimit})` : '';
    lines.push(`  ${e.category}: ${e.limit} ${e.currency}${change}`);
  }

  await sendOverflowLines(ctx, lines, '[CALLBACK] bsync_more send failed');
}
