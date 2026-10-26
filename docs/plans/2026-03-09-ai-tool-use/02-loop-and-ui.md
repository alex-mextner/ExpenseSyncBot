# Part 2: Sections 3-4: agent loop, Telegram UI

[← Back to index](../2026-03-09-ai-tool-use.md)

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

