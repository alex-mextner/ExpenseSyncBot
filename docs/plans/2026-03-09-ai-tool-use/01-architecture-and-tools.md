# Part 1: Sections 1-2: architecture, tool definitions

[← Back to index](../2026-03-09-ai-tool-use.md)

## 1. Обзор архитектуры

### Текущее состояние

Сейчас AI в боте — это stateless чат через Hugging Face Inference API (DeepSeek-R1-0528). Модель получает огромный system prompt с дампом всех расходов, бюджетов и категорий, и на основе этого отвечает на вопросы. Никаких действий модель выполнять не может — она read-only.

**Проблемы текущего подхода:**

- Весь контекст расходов (до 100K записей) вставляется в system prompt — это дорого и медленно
- AI не может выполнять действия: менять бюджеты, добавлять расходы, запускать sync
- DeepSeek R1 тратит огромное количество токенов на `<think>` блоки
- Нет структурированного доступа к данным — модель парсит текстовый дамп

### Целевая архитектура

```
Telegram (@bot вопрос)
    │
    ▼
handleAskQuestion()
    │
    ▼
AnthropicAgent (новый класс)
    ├── system prompt (компактный, без дампов данных)
    ├── tools[] (каталог инструментов)
    └── conversation loop:
        │
        ├── stream text → edit Telegram message
        ├── tool_use → execute tool → tool_result → continue
        └── end_turn → save history, done
```

Ключевое изменение: вместо дампа всех данных в промпт, модель будет **запрашивать нужные данные через tools** и **выполнять действия** через tools.

### Компоненты

| Компонент | Файл | Описание |
|-----------|------|----------|
| `AnthropicAgent` | `src/services/ai/agent.ts` | Agent loop, streaming, tool execution |
| Tool definitions | `src/services/ai/tools.ts` | Каталог всех tool definitions |
| Tool executors | `src/services/ai/tool-executor.ts` | Маршрутизация и выполнение tools |
| Telegram UI | `src/services/ai/telegram-stream.ts` | Streaming + tool feedback в Telegram |
| Ask handler | `src/bot/commands/ask.ts` | Точка входа (рефакторинг) |

---

## 2. Каталог инструментов (Tool Definitions)

### 2.1 Чтение данных

#### `get_expenses`

Получить расходы с фильтрами. Замена дампа всех расходов в промпт.

```typescript
const GET_EXPENSES: ToolDefinition = {
  name: 'get_expenses',
  description: 'Get expenses with optional filters. Returns expenses sorted by date descending. Use this to answer questions about spending.',
  input_schema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        description: 'Time period: "current_month", "last_month", "last_3_months", "last_6_months", "all", or specific "YYYY-MM"',
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
        description: 'If true, return only aggregated totals by category instead of individual expenses',
      },
    },
  },
};
```

**Executor:** Обращается к `database.expenses.findByGroupId()` / `findByDateRange()` / `findByCategory()`, форматирует результат. **Важно:** результат должен включать `id` расхода — он нужен для `delete_expense`. Фильтрация по категории в текущем репозитории делает exact match (`WHERE category = ?`), нужно добавить `COLLATE NOCASE` или `LOWER()` для case-insensitive поиска.

#### `get_budgets`

Получить бюджеты с текущим прогрессом.

```typescript
const GET_BUDGETS: ToolDefinition = {
  name: 'get_budgets',
  description: 'Get budget limits and current spending progress for the group. Shows limit, spent amount, remaining, and percentage for each category.',
  input_schema: {
    type: 'object',
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
};
```

**Executor:** Вызывает `database.budgets.getAllBudgetsForMonth()`, считает потраченное через `database.expenses`, возвращает прогресс.

#### `get_categories`

Список всех категорий.

```typescript
const GET_CATEGORIES: ToolDefinition = {
  name: 'get_categories',
  description: 'Get all expense categories for the group.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
```

**Executor:** `database.categories.findByGroupId()`.

#### `get_group_settings`

Получить настройки группы.

```typescript
const GET_GROUP_SETTINGS: ToolDefinition = {
  name: 'get_group_settings',
  description: 'Get current group settings: default currency, enabled currencies, spreadsheet status, custom prompt.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
```

**Executor:** `database.groups.findById()`.

#### `get_exchange_rates`

Получить текущие курсы валют.

```typescript
const GET_EXCHANGE_RATES: ToolDefinition = {
  name: 'get_exchange_rates',
  description: 'Get current exchange rates between supported currencies.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
```

**Executor:** `formatExchangeRatesForAI()` из `converter.ts`.

### 2.2 Действия с бюджетами

#### `set_budget`

Установить/обновить бюджет для категории.

```typescript
const SET_BUDGET: ToolDefinition = {
  name: 'set_budget',
  description: 'Set or update budget limit for a category in the current month. Also syncs to Google Sheets.',
  input_schema: {
    type: 'object',
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
        description: 'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency.',
      },
      month: {
        type: 'string',
        description: 'Month in "YYYY-MM" format. Default: current month.',
      },
    },
    required: ['category', 'amount'],
  },
};
```

**Executor:** Реюзает логику из `handleBudgetAction` в `callback.handler.ts` — `database.budgets.setBudget()` + `writeBudgetRow()`.

#### `delete_budget`

Удалить бюджет категории.

```typescript
const DELETE_BUDGET: ToolDefinition = {
  name: 'delete_budget',
  description: 'Delete budget for a category in a specific month.',
  input_schema: {
    type: 'object',
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
};
```

**Executor:** `database.budgets.deleteByGroupCategoryMonth()`.

### 2.3 Действия с расходами

#### `add_expense`

Добавить расход (через AI — для нестандартных форматов).

```typescript
const ADD_EXPENSE: ToolDefinition = {
  name: 'add_expense',
  description: 'Add a new expense. Use when the user asks to record an expense in natural language that cannot be parsed by the standard parser. The expense is saved to the database AND synced to Google Sheets.',
  input_schema: {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        description: 'Expense amount',
      },
      currency: {
        type: 'string',
        description: 'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency.',
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
};
```

**Executor:** Создает расход в БД через `database.expenses.create()` + `appendExpenseRow()` в Google Sheets. Создает категорию если не существует. `group_id` и `user_id` берутся из контекста агента (не из tool input) — модель их не знает и не должна знать. `eur_amount` вычисляется автоматически через `convertToEUR()`.

#### `delete_expense`

Удалить расход по ID.

```typescript
const DELETE_EXPENSE: ToolDefinition = {
  name: 'delete_expense',
  description: 'Delete an expense by ID. Use when the user asks to remove a specific expense. IMPORTANT: Always call get_expenses first to find the expense ID and show it to the user for confirmation before deleting. Note: this deletes from the local database only — the user should run /sync afterwards to re-sync with Google Sheets, or the record will remain in the sheet.',
  input_schema: {
    type: 'object',
    properties: {
      expense_id: {
        type: 'number',
        description: 'ID of the expense to delete. Get this from get_expenses results.',
      },
    },
    required: ['expense_id'],
  },
};
```

**Executor:** `database.expenses.delete()`. Проверить что расход принадлежит текущей группе (security check!) перед удалением.

### 2.4 Команды синхронизации

#### `sync_from_sheets`

Синхронизация из Google Sheets в БД.

```typescript
const SYNC_FROM_SHEETS: ToolDefinition = {
  name: 'sync_from_sheets',
  description: 'Sync expenses from Google Sheets to local database. This replaces all local expenses with data from the sheet. Use when the user says data is out of sync or asks to refresh.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
```

**Executor:** Реюзает логику из `handleSyncCommand()`.

#### `sync_budgets`

Синхронизация бюджетов из Google Sheets.

```typescript
const SYNC_BUDGETS: ToolDefinition = {
  name: 'sync_budgets',
  description: 'Sync budget data from Google Sheets Budget tab to local database.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
```

**Executor:** Реюзает `silentSyncBudgets()`.

### 2.5 Настройки

#### `set_custom_prompt`

Установить кастомный промпт группы.

```typescript
const SET_CUSTOM_PROMPT: ToolDefinition = {
  name: 'set_custom_prompt',
  description: 'Set or clear the custom AI system prompt for the group. This prompt is appended to the default system prompt.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Custom prompt text. Set to empty string to clear.',
      },
    },
    required: ['prompt'],
  },
};
```

**Executor:** `database.groups.update()` с `custom_prompt`.

#### `manage_category`

Создать или удалить категорию.

```typescript
const MANAGE_CATEGORY: ToolDefinition = {
  name: 'manage_category',
  description: 'Create or delete an expense category.',
  input_schema: {
    type: 'object',
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
};
```

**Executor:** `database.categories.create()` / `database.categories.delete()`.

### Полный список tools (13 штук)

| # | Tool | Тип | Описание |
|---|------|-----|----------|
| 1 | `get_expenses` | Read | Расходы с фильтрами |
| 2 | `get_budgets` | Read | Бюджеты и прогресс |
| 3 | `get_categories` | Read | Список категорий |
| 4 | `get_group_settings` | Read | Настройки группы |
| 5 | `get_exchange_rates` | Read | Курсы валют |
| 6 | `set_budget` | Write | Установить бюджет |
| 7 | `delete_budget` | Write | Удалить бюджет |
| 8 | `add_expense` | Write | Добавить расход |
| 9 | `delete_expense` | Write | Удалить расход |
| 10 | `sync_from_sheets` | Action | Синхронизация расходов |
| 11 | `sync_budgets` | Action | Синхронизация бюджетов |
| 12 | `set_custom_prompt` | Write | Установить промпт |
| 13 | `manage_category` | Write | Управление категориями |

---

