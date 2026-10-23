/** /ai_stats [days] — admin-only AI usage report (per provider: calls, errors, latency, tokens) from ai_usage_events */
import { database } from '../../database';
import { AI_USAGE_RETENTION_DAYS } from '../../database/repositories/ai-usage-events.repository';
import { aggregateUsage, formatUsageTelegram } from '../../services/ai/usage-report';
import { sendDirect } from '../../services/bank/telegram-sender';
import { createLogger } from '../../utils/logger.ts';
import type { Ctx } from '../types';

const logger = createLogger('ai-stats');

const DEFAULT_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * /ai_stats [days] — the report goes to the admin's own chat (never into the group the command was
 * typed in). Only reachable through requireAdmin.
 */
export async function handleAiStatsCommand(
  ctx: Ctx['Command'],
  adminChatId: number,
): Promise<void> {
  const arg = (ctx.text ?? '').replace(/^\/ai_stats(?:@\S+)?/, '').trim();
  const days = arg === '' ? DEFAULT_DAYS : /^\d+$/.test(arg) ? Number(arg) : Number.NaN;
  if (!(days >= 1 && days <= AI_USAGE_RETENTION_DAYS)) {
    await sendDirect(
      adminChatId,
      `Использование: <code>/ai_stats [дней]</code> — число от 1 до ${AI_USAGE_RETENTION_DAYS} (по умолчанию ${DEFAULT_DAYS}).`,
    );
    return;
  }

  let messages: string[];
  try {
    const now = Date.now();
    const events = database.aiUsageEvents.listSince(now - days * DAY_MS);
    messages = formatUsageTelegram(aggregateUsage(events, { now, days }));
  } catch (err) {
    logger.error({ err }, '[AI_STATS] Failed to build the usage report');
    await sendDirect(adminChatId, '❌ Не удалось прочитать статистику AI. Подробности в логах.');
    return;
  }

  for (const text of messages) {
    if (!(await sendDirect(adminChatId, text))) {
      logger.warn('[AI_STATS] Telegram did not accept the usage report');
      return;
    }
  }
}
