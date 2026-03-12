/**
 * Anthropic tool definitions for the expense bot agent
 */
import type Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  // === Read tools ===
  {
    name: 'get_expenses',
    description:
      'Get expenses with optional filters. Returns expenses sorted by date descending. Use this to answer questions about spending.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description:
            'Time period: "current_month", "last_month", "last_3_months", "last_6_months", "all", or specific "YYYY-MM"',
        },
        category: {
          type: 'string',
          description: 'Filter by category name (case-insensitive)',
        },
        limit: {
          type: 'number',
          description: 'Max number of expenses to return (default: 50, max: 500)',
        },
        summary_only: {
          type: 'boolean',
          description:
            'If true, return only aggregated totals by category instead of individual expenses',
        },
      },
    },
  },
  {
    name: 'get_budgets',
    description:
      'Get budget limits and current spending progress for the group. Shows limit, spent amount, remaining, and percentage for each category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        month: {
          type: 'string',
          description: 'Month in "YYYY-MM" format. Default: current month.',
        },
        category: {
          type: 'string',
          description: 'Filter by specific category',
        },
      },
    },
  },
  {
    name: 'get_categories',
    description: 'Get all expense categories for the group.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_group_settings',
    description:
      'Get current group settings: default currency, enabled currencies, spreadsheet status, custom prompt.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_exchange_rates',
    description: 'Get current exchange rates between supported currencies.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // === Calculator tool ===
  {
    name: 'calculate',
    description:
      'CRITICAL: ALWAYS use this tool for ANY arithmetic calculation, currency conversion, or math operation. NEVER calculate mentally or intuitively - ALWAYS call this tool. ' +
      'Supports: basic arithmetic (+, -, *, /), parentheses for grouping, currency amounts (e.g., 100USD, 50EUR), mixed currency operations (converted via EUR), and currency conversion. ' +
      'Examples: "10+20*3", "(10+5)*2", "100USD", "100USD+50EUR", "100USD+5000RUB", "100USD/3". ' +
      'Use target_currency to convert result to a specific currency (e.g., "100USD" with target_currency="EUR" converts 100 USD to EUR).',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description:
            'Expression with numbers and/or currency amounts, operators (+, -, *, /), and parentheses. Examples: "10+20*3", "100USD+50EUR", "(100+50)*2", "100USD". Currency format: <NUMBER><CURRENCY_CODE> (e.g., 100USD, 50EUR, 5000RUB).',
        },
        target_currency: {
          type: 'string',
          description:
            'Optional currency code to convert the result to (e.g., "EUR", "USD", "RUB"). If not specified, result stays in the original currency or EUR for mixed currencies.',
        },
      },
      required: ['expression'],
    },
  },

  // === Write tools ===
  {
    name: 'set_budget',
    description:
      'Set or update budget limit for a category in the current month. Also syncs to Google Sheets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category name',
        },
        amount: {
          type: 'number',
          description: 'Budget limit amount',
        },
        currency: {
          type: 'string',
          description:
            'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency.',
        },
        month: {
          type: 'string',
          description: 'Month in "YYYY-MM" format. Default: current month.',
        },
      },
      required: ['category', 'amount'],
    },
  },
  {
    name: 'delete_budget',
    description: 'Delete budget for a category in a specific month.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category name',
        },
        month: {
          type: 'string',
          description: 'Month in "YYYY-MM" format. Default: current month.',
        },
      },
      required: ['category'],
    },
  },
  {
    name: 'add_expense',
    description:
      'Add a new expense. Use when the user asks to record an expense in natural language. The expense is saved to the database AND synced to Google Sheets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: {
          type: 'number',
          description: 'Expense amount',
        },
        currency: {
          type: 'string',
          description:
            'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency.',
        },
        category: {
          type: 'string',
          description: 'Expense category',
        },
        comment: {
          type: 'string',
          description: 'Optional comment/description',
        },
        date: {
          type: 'string',
          description: 'Date in "YYYY-MM-DD" format. Default: today.',
        },
      },
      required: ['amount', 'category'],
    },
  },
  {
    name: 'delete_expense',
    description:
      'Delete an expense by ID. IMPORTANT: Always call get_expenses first to find the expense ID and show it to the user for confirmation before deleting. Note: this deletes from the local database only -- the user should run /sync afterwards to re-sync with Google Sheets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        expense_id: {
          type: 'number',
          description: 'ID of the expense to delete. Get this from get_expenses results.',
        },
      },
      required: ['expense_id'],
    },
  },

  // === Sync tools ===
  {
    name: 'sync_from_sheets',
    description:
      'Sync expenses from Google Sheets to local database. This replaces all local expenses with data from the sheet. Use when the user says data is out of sync or asks to refresh.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'sync_budgets',
    description:
      'Sync budget data from Google Sheets Budget tab to local database.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // === Settings tools ===
  {
    name: 'set_custom_prompt',
    description:
      'Set or clear the custom AI system prompt for the group. This prompt is appended to the default system prompt.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Custom prompt text. Set to empty string to clear.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'manage_category',
    description: 'Create or delete an expense category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'delete'],
          description: 'Action to perform',
        },
        name: {
          type: 'string',
          description: 'Category name',
        },
      },
      required: ['action', 'name'],
    },
  },
];

/**
 * Human-readable labels for tool execution indicators
 */
export const TOOL_LABELS: Record<string, string> = {
  get_expenses: 'Загружаю расходы',
  get_budgets: 'Проверяю бюджеты',
  get_categories: 'Загружаю категории',
  get_group_settings: 'Читаю настройки',
  get_exchange_rates: 'Загружаю курсы валют',
  calculate: 'Считаю',
  set_budget: 'Устанавливаю бюджет',
  delete_budget: 'Удаляю бюджет',
  add_expense: 'Записываю расход',
  delete_expense: 'Удаляю расход',
  sync_from_sheets: 'Синхронизирую из таблицы',
  sync_budgets: 'Синхронизирую бюджеты',
  set_custom_prompt: 'Обновляю промпт',
  manage_category: 'Управляю категориями',
};
