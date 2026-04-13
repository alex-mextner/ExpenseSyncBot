/** OpenAI-format tool definitions for the expense bot agent */
import type OpenAI from 'openai';

/** Shorthand: wraps name+description+parameters into OpenAI tool shape */
function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAI.ChatCompletionTool {
  return { type: 'function', function: { name, description, parameters } };
}

/** Convert legacy Anthropic-format tool defs to OpenAI format (input_schema → parameters) */
function fromAnthropicFormat(
  defs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): OpenAI.ChatCompletionTool[] {
  return defs.map((d) => tool(d.name, d.description, d.input_schema));
}

export const TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = fromAnthropicFormat([
  // === Read tools ===
  {
    name: 'get_expenses',
    description:
      'Get expenses with optional filters. Returns expenses sorted by date descending, paginated (100 per page). Use this to answer questions about spending.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          oneOf: [
            { type: 'string', description: 'Single period' },
            {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of periods for multi-period breakdown',
            },
          ],
          description:
            'Time period: "current_month", "last_month", "last_3_months", "last_6_months", "all", or specific "YYYY-MM". Pass an ARRAY of periods to get per-period breakdown with stats, diff (2 periods), or trend (3+). Example: ["2025-11", "2025-12", "2026-01"]',
        },
        category: {
          oneOf: [
            { type: 'string', description: 'Single category' },
            {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of categories (OR match)',
            },
          ],
          description:
            'Filter by category name(s). Pass an array to filter by multiple categories (OR match). Case-insensitive.',
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
            'If true, return pre-calculated totals by category with stats (count, total, avg, median, min, max). For multi-period arrays, includes per-period breakdown + diff/trend. ALWAYS prefer this for aggregation questions.',
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
          oneOf: [
            { type: 'string', description: 'Single month' },
            {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of months for multi-month comparison',
            },
          ],
          description:
            'Month in "YYYY-MM" format. Pass an array for multi-month comparison. Default: current month.',
        },
        category: {
          oneOf: [
            { type: 'string', description: 'Single category' },
            {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of categories (OR filter)',
            },
          ],
          description:
            'Filter by specific category or categories (array for multi-category filter).',
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
      'Set or update budget limit for a category. Saves to DB and syncs to Google Sheets. Pass an `items` array to set multiple budgets in one call (max 20).',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category name (single mode)',
        },
        amount: {
          type: 'number',
          description: 'Budget limit amount (single mode)',
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
        items: {
          type: 'array',
          description:
            'Batch mode: array of {category, amount, currency?, month?}. When present, top-level category/amount are ignored.',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string' },
              month: { type: 'string' },
            },
            required: ['category', 'amount'],
          },
        },
      },
    },
  },
  {
    name: 'delete_budget',
    description:
      'Delete budget for a category in a specific month. Pass a category array to delete multiple at once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          oneOf: [
            { type: 'string', description: 'Single category' },
            { type: 'array', items: { type: 'string' }, description: 'Array of categories' },
          ],
          description: 'Category name(s). Pass an array to delete multiple budgets at once.',
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
      'Add a new expense. Use when the user asks to record an expense in natural language. The expense is saved to the database AND synced to Google Sheets. Pass an `items` array to add multiple expenses in one call (max 20).',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: {
          type: 'number',
          description: 'Expense amount (single mode)',
        },
        currency: {
          type: 'string',
          description:
            'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency.',
        },
        category: {
          type: 'string',
          description: 'Expense category (single mode)',
        },
        comment: {
          type: 'string',
          description: 'Optional comment/description',
        },
        date: {
          type: 'string',
          description: 'Date in "YYYY-MM-DD" format. Default: today.',
        },
        items: {
          type: 'array',
          description:
            'Batch mode: array of {amount, currency?, category, comment?, date?}. When present, top-level fields are ignored.',
          items: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              currency: { type: 'string' },
              category: { type: 'string' },
              comment: { type: 'string' },
              date: { type: 'string' },
            },
            required: ['amount', 'category'],
          },
        },
      },
    },
  },
  {
    name: 'delete_expense',
    description:
      'Delete expense(s) by ID. IMPORTANT: Always call get_expenses first to find the expense ID and show it to the user for confirmation before deleting. Pass an array to delete multiple at once. Note: this deletes from the local database only -- the user should run /sync afterwards to re-sync with Google Sheets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        expense_id: {
          oneOf: [
            { type: 'number', description: 'Single expense ID' },
            { type: 'array', items: { type: 'number' }, description: 'Array of expense IDs' },
          ],
          description:
            'ID(s) of the expense(s) to delete. Pass an array to delete multiple at once.',
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
      'Evaluate ANY math expression — financial or not. Currency amounts are optional and auto-converted. Use for ALL arithmetic: splitting bills, counting people, areas, ratios, percentages, currency conversion — anything. NEVER calculate manually.\n\nExamples:\n- {"expression": "100 * 3"}\n- {"expression": "100$ - 70 EUR", "target_currency": "USD"}\n- {"expression": "1500 RSD + 50 EUR", "target_currency": "EUR"}\n- {"expression": "500€ - 10%"}\n- {"expression": "1000000 / 6"}\n\nFor currency conversion (e.g. "what is 1 USD in RUB"): {"expression": "1 USD", "target_currency": "RUB"}. NEVER use "in" as an operator — it is not supported. Do NOT call get_exchange_rates first — this tool already uses live rates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description:
            'Math expression to evaluate. May contain currency amounts (e.g. "100$", "70 EUR", "50€"). Operators: +, -, *, /. Supports percentage: "EXPR - N%" or "EXPR + N%". For plain conversion: "1 USD" with target_currency set.',
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
      'Set, append to, or clear the custom AI system prompt for the group. This is the ONLY persistent memory available — use it whenever the user says "remember", "note", "save", or asks to keep any fact, rule, or preference for future conversations. Prefer mode="append" to avoid overwriting existing notes. Examples: user says "remember that Lena has a hidden account" → append "Note: Lena has a hidden account."; user says "always reply in English" → append the rule. Act immediately without asking for confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Text to save. For facts/notes use plain declarative sentences.',
        },
        mode: {
          type: 'string',
          enum: ['set', 'append'],
          description:
            '"set" — replaces the entire prompt (use to rewrite rules from scratch). "append" (preferred) — adds text after the existing prompt, preserving previous notes.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'manage_category',
    description:
      'Create or delete expense categories. Pass a name array to manage multiple at once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'delete'],
          description: 'Action to perform',
        },
        name: {
          oneOf: [
            { type: 'string', description: 'Single category name' },
            { type: 'array', items: { type: 'string' }, description: 'Array of category names' },
          ],
          description: 'Category name(s). Pass an array to create/delete multiple at once.',
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
          oneOf: [
            { type: 'string', description: 'Single period' },
            { type: 'array', items: { type: 'string' }, description: 'Array of periods' },
          ],
          description:
            '"current_month" | "last_month" | "YYYY-MM". Pass an array for multiple periods.',
        },
        bank_name: {
          oneOf: [
            { type: 'string', description: 'Single bank' },
            { type: 'array', items: { type: 'string' }, description: 'Array of bank names' },
          ],
          description:
            'Bank name(s): "all" for all banks, or bank registry key(s). Pass an array for multiple banks.',
        },
        status: {
          oneOf: [
            { type: 'string', description: 'Single status' },
            { type: 'array', items: { type: 'string' }, description: 'Array of statuses' },
          ],
          description:
            '"pending" | "confirmed" | "skipped". Pass an array for multiple statuses. Omit for all.',
        },
      },
      required: ['bank_name'],
    },
  },
  {
    name: 'get_bank_balances',
    description:
      'Get current account balances from connected banks for this group. By default returns only visible accounts. Use show_hidden: true to include hidden/disabled ones.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bank_name: {
          oneOf: [
            { type: 'string', description: 'Single bank name' },
            { type: 'array', items: { type: 'string' }, description: 'Array of bank names' },
          ],
          description:
            'Which bank(s) to show: "all" for all banks, or bank registry key(s) (case-insensitive substring match). Omit to show all banks.',
        },
        show_hidden: {
          type: 'boolean',
          description: 'If true, include hidden/disabled accounts in the response. Default: false.',
        },
      },
    },
  },
  {
    name: 'send_feedback',
    description:
      'Send a feedback message or bug report to the bot admin. Use when a user explicitly asks to report a problem, send feedback, or contact support.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'Feedback or bug report text to send to the admin.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'render_table',
    description: `Renders a Markdown table as a styled image and sends it to the chat.

ALWAYS call this tool when you have tabular data (comparisons, category breakdowns, budgets, schedules, multi-column lists) — never skip it.
Call IN PARALLEL with your text response. In the text, present the same data as a bullet list — never write raw Markdown table syntax there.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Heading shown above the table.',
        },
        markdown: {
          type: 'string',
          description:
            'Markdown table syntax. Example: "| Категория | Сумма |\\n|---|---|\\n| Еда | 5000 ₽ |"',
        },
        caption: {
          type: 'string',
          description: 'Optional note shown below the table.',
        },
      },
      required: ['title', 'markdown'],
    },
  },
  {
    name: 'get_technical_analysis',
    description:
      'Analyze spending trends and predict future expenses. Shows for each category: whether spending is growing/falling/stable, forecast for next month, typical range, unusual spikes, and whether spending hit a record high. Requires ≥3 months of history. Use when asked about trends, forecasts, projections, or anomalies.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description:
            'Optional: filter by specific category. Omit for all categories with enough history.',
        },
      },
    },
  },
  {
    name: 'get_recurring_patterns',
    description:
      'Get all recurring expense patterns for the group (rent, subscriptions, etc.). Returns patterns with their status, expected amounts, and next expected dates.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'manage_recurring_pattern',
    description:
      'Pause, resume, dismiss, or delete recurring expense patterns. Pass a pattern_id array to manage multiple at once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern_id: {
          oneOf: [
            { type: 'number', description: 'Single pattern ID' },
            { type: 'array', items: { type: 'number' }, description: 'Array of pattern IDs' },
          ],
          description: 'ID(s) of the recurring pattern(s) to manage.',
        },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'dismiss', 'delete'],
          description:
            '"pause" — temporarily stop tracking. "resume" — reactivate a paused pattern. "dismiss" — permanently hide (won\'t be re-detected). "delete" — remove entirely.',
        },
      },
      required: ['pattern_id', 'action'],
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
          oneOf: [
            { type: 'string', description: 'Single period' },
            { type: 'array', items: { type: 'string' }, description: 'Array of periods' },
          ],
          description:
            '"current_month" | "last_month" | "YYYY-MM". Pass an array for multi-period search.',
        },
      },
    },
  },
]);

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
  get_technical_analysis: 'Анализирую тренды и прогнозы',
  get_recurring_patterns: 'Загружаю повторяющиеся платежи',
  manage_recurring_pattern: 'Управляю повторяющимся платежом',
  find_missing_expenses: 'Ищу пропущенные расходы',
  render_table: 'Рендерю таблицу',
  send_feedback: 'Отправляю фидбек',
};
