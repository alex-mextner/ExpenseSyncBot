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

const STATUS_ICON: Record<AuditEntry['status'], string> = {
  ok: '✅',
  not_found: '❌',
  forbidden: '🔒',
  token_expired: '🔑',
  rate_limited: '⏳',
  unknown_error: '⚠️',
};

const STATUS_TEXT: Record<AuditEntry['status'], string> = {
  ok: 'доступна',
  not_found: 'не найдена',
  forbidden: 'нет прав доступа',
  token_expired: 'токен отозван',
  rate_limited: 'квота Google исчерпана',
  unknown_error: 'ошибка',
};

/** Closing line when nothing was recreated; picks the most actionable reason first. */
function formatNothingRecreatedVerdict(audit: AuditEntry[]): string {
  if (audit.every((a) => a.status === 'ok')) {
    return '\n✅ Все таблицы на месте, ничего пересоздавать не нужно.';
  }
  if (audit.some((a) => a.status === 'token_expired')) {
    return '\n🔑 Токен Google отозван — используй /reconnect.';
  }
  if (audit.some((a) => a.status === 'rate_limited')) {
    return '\n⏳ Квота Google Sheets временно исчерпана. Бот уже ждал и ретраил — не помогло. Повтори /repair через 1–2 минуты.';
  }
  return '\n⚠️ Часть таблиц недоступна, но автоматически пересоздать не получилось. Используй /reconnect.';
}

function formatRecreatedSection(recreated: RecreateResult[]): string[] {
  const lines: string[] = [
    '',
    'Возможные причины проблемы:',
    '• таблица удалена/в Корзине',
    '• после смены конфигурации Google новые разрешения не видят старые таблицы',
    '• бот лишился доступа в настройках Google аккаунта',
    '',
    '🆕 Пересоздано:',
  ];
  for (const r of recreated) {
    lines.push(
      `  ${r.year}: ${r.newSpreadsheetUrl}\n` +
        `    Залито: ${r.expensesCopied} ${pluralize(r.expensesCopied, 'расход', 'расхода', 'расходов')}, ${r.budgetsCopied} ${pluralize(r.budgetsCopied, 'бюджет', 'бюджета', 'бюджетов')}`,
    );
  }
  lines.push('');
  lines.push('ℹ️ Старые таблицы остались в твоём Google Drive — удали их вручную, если нужно.');
  return lines;
}

function formatRepairReport(audit: AuditEntry[], recreated: RecreateResult[]): string {
  const lines: string[] = ['🔧 <b>Проверка таблиц</b>\n'];

  // Audit summary by year
  lines.push('Состояние:');
  for (const entry of audit) {
    lines.push(`  ${STATUS_ICON[entry.status]} ${entry.year} — ${STATUS_TEXT[entry.status]}`);
  }

  if (recreated.length === 0) {
    lines.push(formatNothingRecreatedVerdict(audit));
  } else {
    lines.push(...formatRecreatedSection(recreated));
  }
  return lines.join('\n');
}
