/**
 * Anthropic tool definitions for the expense bot agent
 */
import type Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  // === Read tools ===
  {
    name: 'get_expenses',
    description:
      'Get expenses with optional filters. Returns expenses sorted by date descending, paginated (100 per page). Use this to answer questions about spending.',
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
        page: {
          type: 'number',
          description:
            'Page number (default: 1). Use to fetch subsequent pages when total_pages > 1.',
        },
        page_size: {
          type: 'number',
          description:
            'Items per page (default: 100, max: 500). Only change if you need fewer results.',
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
    description: 'Sync budget data from Google Sheets Budget tab to local database.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // === Calculator tool ===
  {
    name: 'calculate',
    description:
      'Evaluate ANY math expression — financial or not. Currency amounts are optional and auto-converted. Use for ALL arithmetic the user asks for: splitting bills, counting people, areas, ratios, percentages — anything. NEVER calculate manually. Examples: "100 * 3", "1000000 / 6", "100$ - 70EUR" in USD, "1500 RSD + 50 EUR" in EUR, "500€ - 10%", "300$ / 3".',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description:
            'Math expression to evaluate. May contain currency amounts (e.g. "100$", "70 EUR", "50€"). Operators: +, -, *, /. Supports percentage: "EXPR - N%" or "EXPR + N%".',
        },
        target_currency: {
          type: 'string',
          description:
            'Currency code to convert all amounts to before evaluating (e.g. "USD", "EUR", "RSD"). Default: group default currency.',
        },
      },
      required: ['expression'],
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

  // === Bank tools ===
  {
    name: 'get_bank_transactions',
    description:
      'Get bank transactions for a period. All results are scoped to this group only. Use to answer questions about bank spending or reconciliation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description: '"current_month" | "last_month" | "YYYY-MM"',
        },
        bank_name: {
          type: 'string',
          description: 'Filter by bank registry key (e.g. "tbc"). Omit for all banks.',
        },
        status: {
          type: 'string',
          description: '"pending" | "confirmed" | "skipped" — omit for all statuses.',
        },
      },
    },
  },
  {
    name: 'get_bank_balances',
    description: 'Get current account balances from all connected banks for this group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bank_name: {
          type: 'string',
          description: 'Optional: filter to specific bank registry key.',
        },
      },
    },
  },
  {
    name: 'find_missing_expenses',
    description:
      'Compare bank transactions vs recorded expenses. Returns unmatched bank debit transactions that may be missing from the expense log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description: '"current_month" | "last_month" | "YYYY-MM"',
        },
      },
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
  set_budget: 'Устанавливаю бюджет',
  delete_budget: 'Удаляю бюджет',
  add_expense: 'Записываю расход',
  delete_expense: 'Удаляю расход',
  sync_from_sheets: 'Синхронизирую из таблицы',
  sync_budgets: 'Синхронизирую бюджеты',
  calculate: 'Считаю',
  set_custom_prompt: 'Обновляю промпт',
  manage_category: 'Управляю категориями',
  get_bank_transactions: 'Загружаю банковские транзакции',
  get_bank_balances: 'Проверяю балансы счетов',
  find_missing_expenses: 'Ищу пропущенные расходы',
};
