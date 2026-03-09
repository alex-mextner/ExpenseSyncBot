# Миграция AI: Hugging Face -> Anthropic SDK с tool_use

**Дата:** 2026-03-09
**Статус:** Plan / Research
**Автор:** Alex Ultra + Claude Opus 4.6

---

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

## 3. Conversation Loop (Agent Loop)

### 3.1 Основной цикл

На основе референсной реализации из hyper-canvas (`AIAgent.chat()`), адаптированный под Telegram.

**Важно:** Anthropic SDK TypeScript предоставляет `messages.stream()` который возвращает `MessageStream`. Этот объект поддерживает event-based API (`.on('text', ...)`, `.on('contentBlock', ...)`) и async iteration. Для agent loop удобнее использовать `.on()` + `await stream.finalMessage()`, но для yield-based AsyncGenerator нужен ручной event parsing.

```typescript
class ExpenseBotAgent {
  private anthropic: Anthropic;
  private groupId: number;
  private userId: number;
  private chatId: number;
  private bot: Bot;

  async *chat(
    userMessage: string,
    conversationHistory: ChatMessage[]
  ): AsyncGenerator<AgentEvent> {

    const messages: Anthropic.MessageParam[] = [
      ...this.buildHistoryMessages(conversationHistory),
      { role: 'user', content: userMessage },
    ];

    let continueLoop = true;
    let round = 0;

    while (continueLoop && round < MAX_TOOL_ROUNDS) {
      round++;

      const stream = this.anthropic.messages.stream({
        model: 'claude-sonnet-4-5-20250514',  // баланс цена/качество
        max_tokens: 4096,
        system: this.buildSystemPrompt(),
        messages,
        tools: TOOL_DEFINITIONS,
      });

      // Трекинг текущего tool_use блока
      let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
      const assistantContent: Anthropic.ContentBlock[] = [];
      const toolResults: ToolCallResult[] = [];

      for await (const event of stream) {
        // Текстовый delta — стримим в Telegram
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        }

        // Начало нового content block
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            // Начинаем собирать tool_use
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
            };
          }
        }

        // Input JSON delta для tool_use (приходит частями)
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          if (currentToolUse) {
            currentToolUse.inputJson += event.delta.partial_json;
          }
        }

        // Content block завершен
        if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            // Парсим собранный JSON input
            const input = JSON.parse(currentToolUse.inputJson || '{}');

            // Сохраняем content block для истории
            assistantContent.push({
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input,
            } as Anthropic.ToolUseBlock);

            // Выполняем tool
            yield { type: 'tool_start', name: currentToolUse.name, input };

            const result = await this.executeTool(currentToolUse.name, input);

            yield { type: 'tool_result', name: currentToolUse.name, result };

            toolResults.push({
              id: currentToolUse.id,
              result,
            });

            currentToolUse = null;
          }
        }
      }

      // Собираем финальный message для истории
      // ВАЖНО: используем stream.finalMessage() для получения полного assistant message,
      // но мы уже собрали assistantContent выше для tool_use блоков.
      // Текстовые блоки тоже нужно добавить в assistantContent!
      const finalMessage = await stream.finalMessage();
      const fullAssistantContent = finalMessage.content;

      if (toolResults.length > 0) {
        // Добавляем assistant message + tool results, продолжаем цикл
        messages.push({ role: 'assistant', content: fullAssistantContent });
        messages.push({
          role: 'user',
          content: toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.id,
            content: tr.result.success
              ? tr.result.output || 'Success'
              : `Error: ${tr.result.error}`,
          })),
        });
        continueLoop = true;
      } else {
        continueLoop = false;
      }
    }

    yield { type: 'done' };
  }
}
```

**Ключевые отличия от первоначального варианта:**

1. Добавлен трекинг `currentToolUse` с аккумуляцией `inputJson` из `input_json_delta` событий
2. Обработка `content_block_start` для определения начала tool_use блока
3. Парсинг `partial_json` дельт (JSON приходит частями, нельзя парсить до `content_block_stop`)
4. Использование `stream.finalMessage()` для получения полного content массива (включая текстовые блоки, которые мы не трекали отдельно)

### 3.2 System Prompt (компактный)

Вместо дампа данных — инструкции по использованию tools:

```typescript
private buildSystemPrompt(): string {
  const now = new Date();
  const currentDate = format(now, 'yyyy-MM-dd');
  const currentMonth = format(now, 'yyyy-MM');

  let prompt = `Ты - ассистент для учета и анализа финансов в Telegram-группе.

ТЕКУЩАЯ ДАТА: ${currentDate}
ТЕКУЩИЙ МЕСЯЦ: ${currentMonth}

ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ:
- Username: @${this.userName}
- Полное имя: ${this.userFullName}

ВАЖНЫЕ ПРАВИЛА:
1. Используй tools для получения данных. НЕ выдумывай цифры.
2. Для ответов на вопросы о расходах — вызови get_expenses с нужными фильтрами.
3. Для информации о бюджетах — вызови get_budgets.
4. Для выполнения действий — используй соответствующий tool.
5. Если пользователь просит добавить расход нестандартным способом — используй add_expense.
6. ВАЖНО: Подтверждай действия перед выполнением write/delete операций.

ФОРМАТИРОВАНИЕ: Используй ТОЛЬКО HTML теги:
- <b>жирный</b> для сумм и категорий
- <i>курсив</i> для дополнительной информации
- <code>код</code> для точных чисел
- <blockquote>цитата</blockquote>

НЕ используй Markdown! Экранируй < > & как &lt; &gt; &amp;
НЕ выдумывай ссылки!`;

  if (this.customPrompt) {
    prompt += `\n\n=== КАСТОМНЫЕ ИНСТРУКЦИИ ГРУППЫ ===\n${this.customPrompt}`;
  }

  return prompt;
}
```

**Выигрыш:** System prompt сокращается с ~50K+ токенов (все расходы в тексте) до ~500 токенов. Данные запрашиваются по необходимости через tools.

### 3.3 Ограничение раундов

```typescript
const MAX_TOOL_ROUNDS = 10; // Максимум 10 раундов tool calling
```

Это защита от бесконечных циклов. В реальности для финансового бота 3-5 раундов — максимум типичного запроса.

### 3.4 Conversation History

Текущая модель хранения в `chat_messages` (role + content string) не подходит для tool_use, потому что Anthropic API ожидает structured content (массив ContentBlock) для сообщений с tool_use.

**Решение:** Хранить content как JSON string, парсить при загрузке:

```typescript
// При сохранении:
database.chatMessages.create({
  group_id: groupId,
  user_id: userId,
  role: 'assistant',
  content: JSON.stringify(assistantContentBlocks), // ContentBlock[]
});

// При загрузке:
function parseMessageContent(msg: ChatMessage): Anthropic.MessageParam {
  try {
    const parsed = JSON.parse(msg.content);
    if (Array.isArray(parsed)) {
      return { role: msg.role, content: parsed };
    }
  } catch {}
  return { role: msg.role, content: msg.content };
}
```

**Миграция БД:** Добавить новую миграцию — content поле уже TEXT, парсинг JSON backward-compatible. Старые строковые сообщения продолжат работать.

**ВАЖНО: Целостность tool_use / tool_result пар в истории.**
Anthropic API требует, чтобы каждый `tool_use` блок в assistant message имел соответствующий `tool_result` в следующем user message. Если при pruning истории мы разорвем эту пару (например, оставим assistant с tool_use, но удалим user с tool_result), API вернет ошибку.

**Решения:**

1. **Не хранить промежуточные tool_use раунды** — сохранять в историю только финальный текстовый ответ assistant (без tool_use блоков). Промежуточные tool calls нужны только в рамках одного agent loop, но не для conversation history между запросами. Это самый простой и надежный подход.
2. Если хранить полную историю — pruning должен удалять сообщения парами (assistant+tool_result всегда вместе).

**Рекомендация:** Вариант 1. В историю записываем только `{ role: 'assistant', content: finalTextResponse }` — чистый текст финального ответа. Tool calling — это implementation detail одного запроса, а не часть разговора.

---

## 4. Telegram UI для tool execution

### 4.1 Streaming текста

Сохраняем текущую модель с controlled updates (throttle 5s), но упрощаем — нет `<think>` блоков у Claude:

```typescript
class TelegramStreamWriter {
  private sentMessageId: number | null = null;
  private fullText = '';
  private lastUpdateTime = 0;
  private lastSentText = '';
  private lastErrorTime = 0;
  private pendingUpdate = false;

  async onTextDelta(delta: string): Promise<void> {
    this.fullText += delta;

    const now = Date.now();
    if (now - this.lastUpdateTime < 3000) return;
    if (now - this.lastErrorTime < 10000) return; // cooldown после Telegram 429
    if (this.fullText.length - this.lastSentText.length < 20) return;

    await this.flushUpdate();
  }

  async onToolStart(name: string, input: Record<string, unknown>): Promise<void> {
    const toolLabel = TOOL_LABELS[name] || name;
    this.fullText += `\n⚙️ <i>${toolLabel}...</i>\n`;
    // Не вызываем updateMessage напрямую — ждем throttle.
    // Но помечаем что есть pending update для finalize.
    this.pendingUpdate = true;
    // Один forced update на tool_start допустим — но с проверкой cooldown
    const now = Date.now();
    if (now - this.lastUpdateTime >= 2000 && now - this.lastErrorTime >= 10000) {
      await this.flushUpdate();
    }
  }

  async onToolResult(name: string, result: ToolResult): Promise<void> {
    const status = result.success ? '✅' : '❌';
    const toolLabel = TOOL_LABELS[name] || name;
    this.fullText = this.fullText.replace(
      `⚙️ <i>${toolLabel}...</i>`,
      `${status} <i>${toolLabel}</i>`
    );
    this.pendingUpdate = true;
  }

  async finalize(): Promise<void> {
    if (this.fullText !== this.lastSentText) {
      await this.flushUpdate();
    }
  }

  private async flushUpdate(): Promise<void> {
    try {
      await this.updateMessage(this.fullText);
      this.lastUpdateTime = Date.now();
      this.lastSentText = this.fullText;
      this.pendingUpdate = false;
    } catch (err: any) {
      if (err?.code === 429) {
        this.lastErrorTime = Date.now();
      } else if (!err?.description?.includes('message is not modified')) {
        console.error('[STREAM] Update error:', err);
      }
    }
  }
}
```

**Важно:** `onToolStart` и `onToolResult` не должны безусловно вызывать Telegram API — при быстрых tool вызовах (get_categories -> get_expenses -> get_budgets) можно легко получить 429 от Telegram. Throttle обязателен.

### 4.2 Отображение tool execution

Пользователь должен видеть, что бот делает. Используем inline-индикаторы:

```
Пользователь: @bot установи бюджет на еду 500 евро

Бот (streaming):
Хорошо, установлю бюджет на категорию "Еда".

⚙️ Проверяю текущий бюджет...
✅ Текущий бюджет получен

⚙️ Устанавливаю бюджет €500...
✅ Бюджет установлен

Готово! Бюджет для категории <b>Еда</b> установлен: <b>€500.00</b> на март 2026.

Текущий расход по этой категории: <b>€234.50</b> (47%).
```

### 4.3 Labels для tools

```typescript
const TOOL_LABELS: Record<string, string> = {
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
  set_custom_prompt: 'Обновляю промпт',
  manage_category: 'Управляю категориями',
};
```

### 4.4 Финальное сообщение

После завершения agent loop, tool indicators сворачиваются в компактную форму:

```
✅ Бюджет для категории Еда установлен: €500.00 на март 2026.
Текущий расход: €234.50 (47%).
```

Промежуточные индикаторы `⚙️` / `✅` удаляются из финального сообщения, чтобы не захламлять. Остается только текст от модели.

---

## 5. Миграция с HF на Anthropic

### 5.1 Зависимости

```bash
bun add @anthropic-ai/sdk
# HF Inference остается для фото-обработки (если используется)
```

### 5.2 Environment

Новые переменные:

```env
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4-5-20250514  # или claude-haiku-4-5-20250514 для экономии
AI_PROVIDER=anthropic                 # или huggingface (для плавного перехода)
```

**Важно:** `ANTHROPIC_API_KEY` сделать **опциональным** в `env.ts`. Сейчас `HF_TOKEN` там required — на переходном этапе один из двух должен быть обязательным, оба опциональны. `AI_PROVIDER` определяет какой backend используется.

### 5.3 Файловая структура

```
src/services/ai/
├── agent.ts           # ExpenseBotAgent class
├── tools.ts           # Tool definitions (каталог)
├── tool-executor.ts   # Tool execution routing
├── telegram-stream.ts # Telegram streaming UI
└── types.ts           # AgentEvent, ToolResult types
```

### 5.4 Этапы миграции

**Этап 1: Инфраструктура (1-2 дня)**

- Создать `src/services/ai/` с types, tools definitions
- Реализовать `tool-executor.ts` — маршрутизация и выполнение tools
- Unit-тесты для tool executors

**Этап 2: Agent Loop (1-2 дня)**

- Реализовать `ExpenseBotAgent` с streaming и tool calling loop
- Реализовать `TelegramStreamWriter` для UI
- Интеграция с `handleAskQuestion` — подменить HF client на Agent

**Этап 3: Тестирование (1 день)**

- Ручное тестирование в dev-группе
- Проверить все tools: read, write, action
- Проверить streaming UI, edge cases (rate limits, long responses)
- Проверить conversation history с tool_use

**Этап 4: Переключение (0.5 дня)**

- Feature flag: `AI_PROVIDER=anthropic` (fallback на HF)
- Deploy на production
- Мониторинг стоимости через usage API

**Этап 5: Cleanup (0.5 дня)**

- Удалить HF-specific код из `ask.ts` (processThinkTags и т.д.)
- Обновить `/advice` на Anthropic API (можно без tools, простой вызов)
- Обновить CLAUDE.md

### 5.5 Backward Compatibility

- `/advice` можно пока оставить на HF, мигрировать отдельно
- Chat history: старые строковые сообщения парсятся как есть
- `custom_prompt` работает без изменений

---

## 6. Анализ стоимости

### 6.1 Текущие затраты (Hugging Face / Novita)

DeepSeek R1-0528 через Novita:

- Огромный system prompt (~50K tokens минимум для группы с расходами)
- `<think>` блоки удваивают output tokens
- Примерная стоимость: ~$0.01-0.05 за запрос (зависит от объема данных)

### 6.2 Прогноз затрат Anthropic

#### Модель Claude Sonnet 4.5 ($3 input / $15 output per MTok)

**Типичный запрос "сколько потратили в этом месяце" (2 раунда):**

Раунд 1 (модель вызывает get_expenses):

- System prompt: ~500 tokens
- Tool definitions: ~2,000 tokens (13 tools)
- User message + history: ~500 tokens
- **Input round 1: ~3,000 tokens = $0.009**
- Output: tool_use block ~50 tokens

Раунд 2 (модель получает результат, отвечает):

- Все из раунда 1 + assistant content (~50) + tool_result (~500)
- **Input round 2: ~3,550 tokens = $0.011**
- Output: финальный ответ ~300 tokens

- **Total input: ~6,550 tokens = $0.020**
- **Total output: ~350 tokens = $0.005**
- **Итого: ~$0.025 за запрос** (без кэширования)
- **С кэшированием tools+system:** ~$0.015 за запрос (2,500 tokens cached)

**Запрос с action "установи бюджет 500 евро на еду" (3 раунда):**

- Раунд 1: get_budgets (проверить текущий)
- Раунд 2: set_budget (установить)
- Раунд 3: финальный ответ
- Total input: ~12,000 tokens (нарастает с каждым раундом)
- Total output: ~400 tokens
- **Итого: ~$0.042 за запрос** (без кэширования)

**Сравнение:**

| Метрика | HF/DeepSeek | Anthropic Sonnet 4.5 |
|---------|-------------|----------------------|
| Input tokens (total) | 50,000+ (1 раунд) | 6,000-12,000 (2-3 раунда, нарастает) |
| Output tokens | 2,000-4,000 (с think) | 300-500 |
| Стоимость/запрос | ~$0.01-0.05 | ~$0.015-0.04 (без кэша) |
| С кэшированием | N/A | ~$0.010-0.025 |
| Качество | Хорошее для анализа | Отличное + actions |
| Latency | 10-30 сек | 3-8 сек (но несколько раундов) |

#### Модель Claude Haiku 4.5 ($1 input / $5 output per MTok) — бюджетный вариант

- Тот же запрос: ~$0.005 за запрос
- Качество ниже, но для простых запросов и tool calling вполне достаточно
- Рекомендация: начать с Haiku, переключить на Sonnet если качество не устраивает

### 6.3 Оптимизация стоимости

#### Prompt Caching

Anthropic поддерживает prompt caching — кэширование system prompt + tools:

```typescript
const stream = anthropic.messages.stream({
  model: 'claude-sonnet-4-5-20250514',
  system: [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' }, // Кэшируем system prompt
  }],
  tools: TOOL_DEFINITIONS.map((tool, i) => {
    if (i === TOOL_DEFINITIONS.length - 1) {
      return { ...tool, cache_control: { type: 'ephemeral' } };
    }
    return tool;
  }),
  messages,
  max_tokens: 4096,
});
```

**Экономия от кэширования:**

- Cache write: 1.25x от input price (единоразово при создании)
- Cache read: 0.1x от input price (90% скидка)
- ~2,500 tokens tools + system = кэшируются
- При 2+ запросах за 5 минут — экономия ~90% на этих токенах
- TTL по умолчанию: 5 минут (есть опция 1 час за 2x write price)

**ВАЖНО:** Минимальная длина кэшируемого префикса зависит от модели:

- Sonnet 4.5: 1,024 tokens
- Haiku 4.5: 4,096 tokens
- ~2,500 tokens tools + system — работает для Sonnet, но НЕ для Haiku!
- Для Haiku нужно включать часть conversation history в кэшируемый префикс, или кэширование просто не включится (без ошибки)

#### Token-Efficient Tool Use

Anthropic beta feature для снижения output tokens:

```typescript
// Добавить beta header
const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    'anthropic-beta': 'token-efficient-tools-2025-02-19',
  },
});
```

Снижает output tokens на 14-70% для tool calling.

#### Минимизация tools

13 tools — это ~2,000 input tokens. Можно разделить на группы:

- **Базовый набор** (всегда): `get_expenses`, `get_budgets`, `get_categories`, `get_exchange_rates`
- **Расширенный** (при наличии write-intent): добавлять `set_budget`, `add_expense`, etc.

Но это усложнение. На старте лучше отдать все 13 — это ~$0.006 за вызов (с кэшированием ~$0.0006).

### 6.4 Прогноз месячных затрат

При 50 запросах/день (активная группа):

- **Haiku 4.5:** 50 x $0.008 x 30 = **$12/мес**
- **Sonnet 4.5:** 50 x $0.03 x 30 = **$45/мес**
- **С кэшированием (Sonnet):** ~$25-30/мес

При 10 запросах/день (обычная группа):

- **Haiku 4.5:** **$2.40/мес**
- **Sonnet 4.5:** **$9/мес**
- **С кэшированием (Sonnet):** **$5-6/мес**

---

## 7. Обработка ошибок

### 7.1 Tool Execution Errors

```typescript
async executeTool(name: string, input: any): Promise<ToolResult> {
  try {
    switch (name) {
      case 'set_budget':
        return await this.executeSetBudget(input);
      // ...
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

Модель получит ошибку в `tool_result` и сможет:

1. Попробовать другой подход
2. Сообщить пользователю о проблеме

### 7.2 API Errors

```typescript
try {
  // agent loop
} catch (error) {
  if (error instanceof Anthropic.APIError) {
    if (error.status === 429) {
      await ctx.send('⏳ Слишком много запросов. Подождите минуту.');
    } else if (error.status === 529) {
      await ctx.send('⚡ Сервер перегружен. Попробуйте позже.');
    } else {
      await ctx.send('❌ Ошибка AI. Попробуйте позже.');
    }
  }
}
```

### 7.3 Telegram API Errors

Сохраняем текущую логику из `ask.ts`:

- Rate limit (429): увеличиваем cooldown
- "message is not modified": пропускаем
- Другие ошибки: логируем, продолжаем

### 7.4 Timeout

```typescript
const AGENT_TIMEOUT_MS = 60_000; // 60 секунд на весь agent loop

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

try {
  // Передаем signal в каждый stream call внутри loop:
  const stream = this.anthropic.messages.stream({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 4096,
    system: this.buildSystemPrompt(),
    messages,
    tools: TOOL_DEFINITIONS,
  }, {
    signal: controller.signal, // <-- в options, не в body
  });
  // ... agent loop
} finally {
  clearTimeout(timeout);
}
```

**Важно:** В Anthropic TypeScript SDK `signal` передается вторым аргументом (request options), а не в body запроса. Также при abort нужно поймать `AbortError` и послать пользователю сообщение вроде "Время ожидания истекло".

### 7.5 Защита от опасных действий

Write/delete tools требуют дополнительной осторожности:

- `delete_expense`: модель должна сначала показать расход пользователю и получить подтверждение
- `sync_from_sheets`: предупреждает что все локальные данные будут заменены
- Это обеспечивается system prompt инструкциями, а не кодом

---

## 8. Детальный план имплементации

### Step 1: Создать `src/services/ai/types.ts`

```typescript
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'done' }
  | { type: 'error'; error: string };
```

### Step 2: Создать `src/services/ai/tools.ts`

Все 13 tool definitions как описано в разделе 2.

### Step 3: Создать `src/services/ai/tool-executor.ts`

Маршрутизация tool_name -> handler function.
Каждый handler работает с database repositories напрямую.
Вынести shared logic из `budget.ts`, `sync.ts`, `message.handler.ts` в reusable функции.

### Step 4: Создать `src/services/ai/telegram-stream.ts`

`TelegramStreamWriter` класс для управления Telegram message editing.

### Step 5: Создать `src/services/ai/agent.ts`

`ExpenseBotAgent` с полным conversation loop.

### Step 6: Обновить `src/bot/commands/ask.ts`

Заменить `handleAskQuestion` — вместо HF client использовать `ExpenseBotAgent`.
Оставить `handleAdviceCommand` / `maybeSendDailyAdvice` — мигрировать позже или использовать Anthropic без tools.

### Step 7: Обновить `src/config/env.ts`

Добавить `ANTHROPIC_API_KEY`, `AI_MODEL`.

### Step 8: Обновить `src/database/schema.ts`

Миграция для chat_messages — content хранит JSON string (backward-compatible, не требует изменения схемы, только обработка в коде).

### Step 9: Тесты

```bash
bun test src/services/ai/
```

- Тесты для tool executors (mock database)
- Тесты для TelegramStreamWriter (mock bot API)

### Step 10: Deploy

- Добавить `ANTHROPIC_API_KEY` в production env
- Deploy через GitHub Actions
- Мониторинг через PM2 logs

---

## 9. Открытые вопросы

1. **Выбор модели:** Начать с Haiku 4.5 ($1/$5) или сразу Sonnet 4.5 ($3/$15)? Haiku дешевле в 3 раза, но хуже следует сложным инструкциям. Рекомендация: начать с Sonnet 4.5 — разница в $20/мес для типичного использования не критична, а качество tool calling важнее.

2. **Extended Thinking:** Claude поддерживает extended thinking (аналог `<think>`). Включать ли? Стоит дополнительных output tokens, но улучшает качество для сложных аналитических вопросов. Рекомендация: не включать на старте, добавить позже если нужно.

3. **Advice command:** Мигрировать `/advice` на Anthropic или оставить на HF? Advice не использует tools, это простой chat completion. Можно мигрировать параллельно для единообразия.

4. **Фото-обработка чеков:** Если она использует HF для OCR/analysis — оставить как есть. Claude vision мог бы заменить, но это отдельный проект.

5. **Rate limiting per user:** Сейчас нет лимитов на количество AI запросов. С Anthropic API это становится важнее. Добавить counter в БД? Рекомендация: на старте — soft limit через cooldown (1 запрос в 10 секунд), позже — полноценный rate limiter.

6. **Confirmation flow для write operations:** Модель должна спрашивать подтверждение перед `delete_expense`, `sync_from_sheets`? Через system prompt или через tool с confirmation step? Рекомендация: через system prompt instructions — проще в реализации, Claude хорошо следует таким инструкциям.

7. **Strict tool use:** Anthropic поддерживает `strict: true` в tool definitions для гарантированного соответствия схеме. Стоит ли включать? Рекомендация: да, включить для всех tools — eliminates edge cases с невалидными параметрами.

---

## 10. Review Notes

**Reviewed:** 2026-03-09 by Claude Opus 4.6
**Scope:** Architecture review, Anthropic SDK API correctness, cost analysis, migration safety

### Исправления внесенные по результатам ревью

#### 1. Tool count mismatch (cosmetic)
Заголовок таблицы tools говорил "12 штук", но в таблице перечислено 13. Исправлено на "13 штук".

#### 2. Agent loop: отсутствовал парсинг streaming events (critical)
Исходный код agent loop не обрабатывал `content_block_start` и `input_json_delta` события. В Anthropic streaming API tool_use input приходит частями через `input_json_delta` внутри `content_block_delta` событий. Без аккумуляции `partial_json` и парсинга только по `content_block_stop` — невозможно получить tool input.

**Что было:** Код ссылался на `currentToolUse` который нигде не инициализировался.
**Что стало:** Полная обработка `content_block_start` (init tool tracking) -> `input_json_delta` (accumulate JSON) -> `content_block_stop` (parse + execute). Также добавлен `stream.finalMessage()` для получения полного assistant content.

#### 3. Conversation history: tool_use/tool_result pairing (critical)
Anthropic API **требует** чтобы каждый `tool_use` блок в assistant message имел matching `tool_result` в следующем user message. Если хранить промежуточные tool_use раунды в chat_messages и потом обрезать историю, пары могут разорваться и API вернет 400 error.

**Решение:** Рекомендация не хранить tool_use раунды в истории вообще. Сохранять только финальный текстовый ответ. Tool calling — implementation detail, а не часть conversational context.

#### 4. Prompt caching: минимальная длина (important)
Добавлена информация о минимальной длине кэшируемого префикса:
- Sonnet 4.5: 1,024 tokens (2,500 tokens system+tools пройдет)
- Haiku 4.5: 4,096 tokens (2,500 tokens НЕ пройдет, кэш молча не включится)

Это влияет на выбор модели: если выбрать Haiku, prompt caching не будет работать без дополнительных усилий.

#### 5. Cost analysis: не учитывала multi-round input growth (important)
Исходный расчет считал input tokens один раз. В реальности при tool_use agent loop каждый раунд пересылает **весь** предыдущий контекст + новые tool results. Для 2-раундового запроса реальный total input ~6,500 tokens, не ~3,000.

Пересчитаны все cost estimates: типичный запрос ~$0.025 вместо ~$0.017 (без кэширования).

#### 6. TelegramStreamWriter: rate limit protection (important)
`onToolStart` безусловно вызывал `updateMessage()`, игнорируя throttle. При быстрых последовательных tool calls (get_categories -> get_expenses -> get_budgets) это 3 Telegram API call подряд за <1 секунду, что гарантирует 429 от Telegram.

Добавлен throttle и error cooldown в tool event handlers.

#### 7. Timeout: signal placement в SDK (minor)
`AbortController.signal` передается вторым аргументом (request options), а не в body запроса. Исправлен пример кода.

#### 8. Security: delete_expense group check (important)
`delete_expense` executor должен проверять что расход принадлежит текущей группе. Без этой проверки модель (или злоумышленник через prompt injection) может удалить расходы другой группы, зная ID.

#### 9. add_expense: implicit parameters (minor)
Добавлено пояснение что `group_id`, `user_id`, `eur_amount` не входят в tool schema — они берутся из контекста агента и вычисляются автоматически.

#### 10. get_expenses: case-insensitive search (minor)
Текущий `findByCategory()` в репозитории делает exact match. Tool description обещает "case-insensitive". Нужно добавить `COLLATE NOCASE` в SQL запрос или использовать `LOWER()`.

#### 11. Environment: migration safety (minor)
`ANTHROPIC_API_KEY` должен быть опциональным в env.ts на время миграции. Добавлен `AI_PROVIDER` для явного переключения.

#### 12. Strict tool use (new recommendation)
Добавлен открытый вопрос #7 про `strict: true` — Anthropic structured outputs для гарантии что tool inputs всегда проходят валидацию схемы.

### Не исправлено (оставлено как есть)

- **Missing tools:** Потенциально полезные tools (`get_statistics` для агрегированной аналитики, `convert_currency` для конвертации) не добавлены. 13 tools достаточно для MVP; `get_expenses` с `summary_only` покрывает базовую аналитику, `get_exchange_rates` дает модели данные для конвертации самостоятельно.
- **Confirmation flow через system prompt vs code:** Оставлено на system prompt. Это рабочий подход, но менее надежный чем программная проверка. Можно усилить позже добавив `requires_confirmation: true` flag в tool executor.
- **Extended thinking:** Не рекомендовано на старте — правильно. Tool use и extended thinking имеют ограничения при совместном использовании (extended thinking нельзя использовать со streaming в некоторых конфигурациях).
- **set_custom_prompt через tool:** Потенциально опасно — пользователь может попросить AI изменить свой собственный system prompt через prompt injection. Но custom_prompt аппендится, а не заменяет основной промпт, так что риск ограничен.
