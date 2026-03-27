// Bot command descriptions — used in AI system prompt and /help auto-generation

/**
 * All user-facing bot commands with descriptions.
 * Source of truth for setMyCommands, system prompt, and /help.
 */
export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Статус настройки' },
  { command: 'help', description: 'Справка по возможностям' },
  { command: 'connect', description: 'Подключить Google таблицу' },
  { command: 'spreadsheet', description: 'Ссылка на Google-таблицу' },
  { command: 'stats', description: 'Статистика расходов' },
  { command: 'sum', description: 'Сумма расходов с фильтрами (алиас: /total)' },
  { command: 'sync', description: 'Загрузить расходы из таблицы в бота' },
  { command: 'push', description: 'Выгрузить расходы из бота в таблицу' },
  { command: 'budget', description: 'Управление бюджетами (подкоманда: /budget sync)' },
  { command: 'categories', description: 'Список категорий' },
  { command: 'settings', description: 'Настройки группы' },
  { command: 'reconnect', description: 'Переподключить Google аккаунт' },
  { command: 'advice', description: 'AI-анализ расходов с советами' },
  { command: 'prompt', description: 'Настроить AI-промпт группы' },
  { command: 'topic', description: 'Привязать бота к топику форума' },
  { command: 'bank', description: 'Импорт транзакций из банка' },
];

/**
 * Format commands for AI system prompt — compact one-liner per command
 */
export function formatCommandsForPrompt(): string {
  return BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join('\n');
}
