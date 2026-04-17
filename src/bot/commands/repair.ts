// /repair command — audit all year spreadsheets and recreate any the bot has lost access to

import { sendMessage } from '../../services/bank/telegram-sender';
import type { AuditEntry, RecreateResult } from '../../services/google/spreadsheet-repair';
import { createLogger } from '../../utils/logger.ts';
import { pluralize } from '../../utils/pluralize';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';
import { auditAndRepairSpreadsheets } from './reconnect';

const logger = createLogger('repair');

/**
 * /repair creates new spreadsheets on Drive — a non-trivial side effect.
 * Limit to once per 5 minutes per group to stop accidental floods
 * (double-tap, bugged client) from filling the user's Drive with empty sheets.
 * In-memory is fine: a restart drops the cooldown, which is the correct
 * behavior (operator intervention = operator trusted).
 */
const REPAIR_COOLDOWN_MS = 5 * 60 * 1000;
const lastRepairByGroup = new Map<number, number>();

/** Test-only: wipe the cooldown map so tests start from a clean state. */
export function _resetRepairCooldownForTests(): void {
  lastRepairByGroup.clear();
}

export async function handleRepairCommand(
  _ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
): Promise<void> {
  const now = Date.now();
  const last = lastRepairByGroup.get(group.id);
  if (last !== undefined && now - last < REPAIR_COOLDOWN_MS) {
    const remainingMs = REPAIR_COOLDOWN_MS - (now - last);
    const remainingMin = Math.ceil(remainingMs / 60_000);
    await sendMessage(
      `⏳ /repair можно запускать не чаще раза в 5 минут. Подожди ~${remainingMin} ${pluralize(remainingMin, 'минуту', 'минуты', 'минут')} и попробуй снова.`,
    );
    return;
  }
  lastRepairByGroup.set(group.id, now);

  await sendMessage('🔍 Проверяю доступ к Google таблицам по всем годам...');

  try {
    const { audit, recreated } = await auditAndRepairSpreadsheets(group);

    if (audit.length === 0) {
      await sendMessage(
        'ℹ️ В базе нет ни одной зарегистрированной таблицы для этой группы. Используй /connect.',
      );
      return;
    }

    await sendMessage(formatRepairReport(audit, recreated));
  } catch (err) {
    logger.error({ err, groupId: group.id }, '[REPAIR] Failed');
    await sendMessage(
      `❌ Не удалось проверить таблицы: ${err instanceof Error ? err.message : 'unknown'}\n\nПопробуй /reconnect для полной переподключения.`,
    );
  }
}

function formatRepairReport(audit: AuditEntry[], recreated: RecreateResult[]): string {
  const lines: string[] = ['🔧 <b>Проверка таблиц</b>\n'];

  // Audit summary by year
  lines.push('Состояние:');
  for (const entry of audit) {
    const icon =
      entry.status === 'ok'
        ? '✅'
        : entry.status === 'not_found'
          ? '❌'
          : entry.status === 'forbidden'
            ? '🔒'
            : entry.status === 'token_expired'
              ? '🔑'
              : entry.status === 'rate_limited'
                ? '⏳'
                : '⚠️';
    const statusText =
      entry.status === 'ok'
        ? 'доступна'
        : entry.status === 'not_found'
          ? 'не найдена'
          : entry.status === 'forbidden'
            ? 'нет прав доступа'
            : entry.status === 'token_expired'
              ? 'токен отозван'
              : entry.status === 'rate_limited'
                ? 'квота Google исчерпана'
                : 'ошибка';
    lines.push(`  ${icon} ${entry.year} — ${statusText}`);
  }

  if (recreated.length === 0) {
    if (audit.every((a) => a.status === 'ok')) {
      lines.push('\n✅ Все таблицы на месте, ничего пересоздавать не нужно.');
    } else if (audit.some((a) => a.status === 'token_expired')) {
      lines.push('\n🔑 Токен Google отозван — используй /reconnect.');
    } else if (audit.some((a) => a.status === 'rate_limited')) {
      lines.push(
        '\n⏳ Квота Google Sheets временно исчерпана. Бот уже ждал и ретраил — не помогло. Повтори /repair через 1–2 минуты.',
      );
    } else {
      lines.push(
        '\n⚠️ Часть таблиц недоступна, но автоматически пересоздать не получилось. Используй /reconnect.',
      );
    }
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Возможные причины проблемы:');
  lines.push('• таблица удалена/в Корзине');
  lines.push('• после смены конфигурации Google новые разрешения не видят старые таблицы');
  lines.push('• бот лишился доступа в настройках Google аккаунта');
  lines.push('');
  lines.push('🆕 Пересоздано:');
  for (const r of recreated) {
    lines.push(
      `  ${r.year}: ${r.newSpreadsheetUrl}\n` +
        `    Залито: ${r.expensesCopied} ${pluralize(r.expensesCopied, 'расход', 'расхода', 'расходов')}, ${r.budgetsCopied} ${pluralize(r.budgetsCopied, 'бюджет', 'бюджета', 'бюджетов')}`,
    );
  }
  lines.push('');
  lines.push('ℹ️ Старые таблицы остались в твоём Google Drive — удали их вручную, если нужно.');

  return lines.join('\n');
}
