# Part 3: Sections 5-10: HF migration, cost, errors, implementation plan, open questions, review notes

[← Back to index](../2026-03-09-ai-tool-use.md)

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
