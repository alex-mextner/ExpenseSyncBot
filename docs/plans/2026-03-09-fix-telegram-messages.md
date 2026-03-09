# Fix Telegram Message Failures During AI Streaming

**Дата:** 2026-03-09
**Файл:** `src/bot/commands/ask.ts`
**Проблема:** При стриминге ответов DeepSeek сообщения часто не отправляются в Telegram — накапливается слишком много символов, проскакивают запрещённые HTML-символы, финальное сообщение не доходит.

---

## 1. Root Cause Analysis — Все точки отказа

### 1.1. КРИТИЧНО: `escapeHtml` вызывается ТОЛЬКО внутри `<think>` блоков

**Строки:** 369-383

```typescript
function processThinkTags(text: string): string {
  // Completed think blocks -> expandable blockquote
  text = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, content) => {
    const escaped = escapeHtml(content);  // ← экранируется ТОЛЬКО контент think
    return `<blockquote expandable>🤔 <b>Размышления</b>\n${escaped}</blockquote>\n`;
  });

  // Unclosed <think> (streaming)
  text = text.replace(/<think>([\s\S]*)$/, (_, content) => {
    const escaped = escapeHtml(content);  // ← экранируется ТОЛЬКО контент think
    return `🤔 <i>Бот думает...</i>\n${escaped}`;
  });

  return text;  // ← ВЕСЬ ОСТАЛЬНОЙ ТЕКСТ ВНЕ think — НЕ ЭКРАНИРОВАН
}
```

**Суть проблемы:** Весь текст ответа AI *за пределами* `<think>...</think>` блоков отправляется в Telegram AS-IS. Если DeepSeek напишет `a < b` или `AT&T` или `<div>` или любой другой невалидный HTML — Telegram вернёт `400 Bad Request: can't parse entities`, и сообщение просто не отправится.

DeepSeek, несмотря на инструкции, регулярно генерирует:

- Символ `<` в сравнениях: `расходы < бюджета`
- Символ `&` в названиях: `H&M`, `AT&T`, `Johnson & Johnson`
- Символ `>` в стрелках: `бюджет -> превышен`
- Неподдерживаемые HTML-теги: `<br>`, `<p>`, `<div>`, `<li>`, `<ul>`, `<h1>`-`<h6>`, `<strong>`, `<em>`, `<span>`, `<table>`, `<tr>`, `<td>`
- Незакрытые теги: `<b>текст` без `</b>`
- Markdown-синтаксис, который выглядит как битый HTML: `**текст**`, `### заголовок`

### 1.2. КРИТИЧНО: Неверное обращение к свойствам ошибки GramIO

**Строки:** 259, 267-268, 315

```typescript
// Строка 259:
if (err?.code === 429) {
// ↑ РАБОТАЕТ — TelegramError.code существует

// Строка 267:
} else if (err?.description?.includes("message is not modified")) {
// ↑ НЕ РАБОТАЕТ — у TelegramError НЕТ свойства description!
// TelegramError наследует Error: super(error.description)
// Значит описание лежит в err.message, а не err.description!

// Строка 315:
if (err?.description?.includes("message is not modified")) {
// ↑ Аналогично — никогда не сработает
```

**Доказательство из исходников GramIO** (`node_modules/gramio/dist/utils-CJfJNxc_.js`, строка 4-22):

```javascript
class TelegramError extends Error {
  method;
  params;
  code;
  payload;
  constructor(error, method, params) {
    super(error.description);  // ← description уходит в Error.message
    this.name = method;
    this.method = method;
    this.params = params;
    this.code = error.error_code;
    if (error.parameters) this.payload = error.parameters;
    // НЕТ this.description = error.description !
  }
}
```

**Последствие:** Проверка `err?.description?.includes(...)` — всегда `undefined?.includes(...)` → `undefined` → false. Код никогда не перехватывает ошибку "message is not modified", что приводит к лишним повторным попыткам и неконтролируемым ошибкам.

### 1.3. ВЫСОКИЙ ПРИОРИТЕТ: `splitIntoChunks` ломает HTML-теги при разбиении

**Строки:** 455-513

Функция разбивает текст по `\n\n`, предложениям, словам — но не учитывает HTML-теги вообще. Если тег `<b>важный текст</b>` окажется на границе чанка:

```
Чанк 1: "... <b>важный "     ← незакрытый <b>
Чанк 2: "текст</b> ..."      ← закрывающий тег без открывающего
```

Оба чанка — невалидный HTML → Telegram вернёт `400 Bad Request: can't parse entities` для обоих.

В отличие от `safelyTruncateHTML` (которая закрывает незакрытые теги), `splitIntoChunks` не делает НИЧЕГО для обеспечения валидности HTML в каждом чанке.

### 1.4. ВЫСОКИЙ ПРИОРИТЕТ: Нет fallback при ошибке отправки финального сообщения

**Строки:** 295-333

```typescript
// Строка 299: Нет try-catch!
await ctx.send(chunk, { parse_mode: "HTML" });

// Строка 321: try-catch есть, но fallback тоже с parse_mode: "HTML"
await ctx.send(chunks[0], { parse_mode: "HTML" });
// ↑ Если первый send упал из-за невалидного HTML,
// fallback отправит тот же невалидный HTML → упадёт снова

// Строка 330: Нет try-catch!
await ctx.send(chunk, { parse_mode: "HTML" });
```

Если HTML невалидный, ни один fallback не поможет — нужно либо очистить HTML, либо отправить без `parse_mode`.

### 1.5. СРЕДНИЙ ПРИОРИТЕТ: `processThinkTagsForAdvice` не экранирует контент вне think

**Строки:** 388-394

```typescript
function processThinkTagsForAdvice(text: string): string {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "<i>Бот думает...</i>\n\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
  // ← Текст после think блоков не экранируется
}
```

Используется в `sendDailyAdvice` (строка 826), который отправляет с `parse_mode: "HTML"` (строка 831). Отправка находится внутри try-catch (строки 718-835), но при ошибке HTML-парсинга нет fallback на plain text — ошибка просто логируется и проглатывается.

### 1.6. НИЗКИЙ ПРИОРИТЕТ: Лимит Telegram 4096 символов vs лимит в коде 4000

**Строки:** 230, 297, 303

Код использует `4000` как лимит — это правильный запас. `safelyTruncateHTML` добавляет закрывающие теги И "..." в конце (строка 449), что может превысить 4000 символов в HTML-исходнике. Однако Telegram считает лимит по длине **отрендеренного** текста (после парсинга HTML), а закрывающие теги не добавляют видимых символов. Реальная проблема только с "..." (+3 символа). Приоритет понижен до LOW.

### 1.7. НИЗКИЙ ПРИОРИТЕТ: Rate limiting в группах

**Строки:** 208-209

Telegram ограничивает ботов до ~20 сообщений в минуту в группе. При стриминге с интервалом 5 секунд — это 12 edit-запросов в минуту, что укладывается. Но при ошибках и ретраях может легко превысить лимит.

### 1.8. НИЗКИЙ ПРИОРИТЕТ: `blockquote expandable` — нестандартный атрибут

**Строка:** 372

```typescript
return `<blockquote expandable>🤔 <b>Размышления</b>\n${escaped}</blockquote>\n`;
```

Telegram поддерживает `<blockquote expandable>` (это задокументировано как `expandable_blockquote` entity), но если контент внутри пустой или слишком короткий, Telegram может не принять его.

---

## 2. Правила Telegram HTML Parse Mode

### 2.1. Поддерживаемые теги (полный список)

| Тег | Описание | Пример |
|-----|----------|--------|
| `<b>`, `<strong>` | Жирный | `<b>bold</b>` |
| `<i>`, `<em>` | Курсив | `<i>italic</i>` |
| `<u>`, `<ins>` | Подчёркнутый | `<u>underline</u>` |
| `<s>`, `<strike>`, `<del>` | Зачёркнутый | `<s>strike</s>` |
| `<span class="tg-spoiler">` | Спойлер | `<span class="tg-spoiler">hidden</span>` |
| `<tg-spoiler>` | Спойлер (альт.) | `<tg-spoiler>hidden</tg-spoiler>` |
| `<a href="url">` | Ссылка | `<a href="https://t.me">link</a>` |
| `<tg-emoji emoji-id="id">` | Кастомный эмодзи | `<tg-emoji emoji-id="123">😀</tg-emoji>` |
| `<code>` | Моноширинный (inline) | `<code>code</code>` |
| `<pre>` | Моноширинный блок | `<pre>block</pre>` |
| `<pre><code class="lang">` | Блок кода с языком | `<pre><code class="python">print()</code></pre>` |
| `<blockquote>` | Цитата | `<blockquote>quote</blockquote>` |
| `<blockquote expandable>` | Сворачиваемая цитата | `<blockquote expandable>long text</blockquote>` |

### 2.2. Символы, ОБЯЗАТЕЛЬНЫЕ к экранированию

| Символ | Замена | Когда экранировать |
|--------|--------|-------------------|
| `<` | `&lt;` | ВСЕГДА, кроме как часть разрешённого тега |
| `>` | `&gt;` | ВСЕГДА, кроме как часть разрешённого тега |
| `&` | `&amp;` | ВСЕГДА, кроме как часть HTML-entity (`&lt;`, `&gt;`, `&amp;`, `&quot;`) |

### 2.3. Что происходит при нарушении правил

- **Неподдерживаемый тег** (`<div>`, `<br>`, `<p>`, `<span>` без `tg-spoiler`, `<h1>`-`<h6>`, `<table>` и т.д.): → `400 Bad Request: can't parse entities`
- **Незакрытый тег**: → `400 Bad Request: can't parse entities`
- **Неэкранированный `<`**: → Telegram пытается парсить как тег → `400 Bad Request: can't parse entities`
- **Неэкранированный `&`**: → Telegram пытается парсить как entity → может упасть или проглотить текст
- **Текст длиннее 4096 символов**: → `400 Bad Request: message is too long`
- **Вложенные теги одного типа** (`<b><b>text</b></b>`): → работает, но семантически бессмысленно
- **Невалидные атрибуты**: → `400 Bad Request: can't parse entities`

### 2.4. Ключевые ограничения

- Максимум **100 entities** (форматирующих элементов) на сообщение
- Максимум **4096 символов** текста (считается длина отрендеренного текста ПОСЛЕ парсинга HTML — сами HTML-теги НЕ входят в этот лимит)
- `editMessageText` вернёт ошибку, если новый текст идентичен старому

---

## 3. Конкретные места в коде, требующие исправления

### Файл: `src/bot/commands/ask.ts`

| # | Строка(и) | Проблема | Тип |
|---|-----------|----------|-----|
| 1 | 369-383 | `processThinkTags` не экранирует текст вне `<think>` блоков | CRITICAL |
| 2 | 267, 315 | `err?.description` → должно быть `err?.message` | CRITICAL |
| 3 | 455-513 | `splitIntoChunks` не обеспечивает валидный HTML в каждом чанке | HIGH |
| 4 | 295-299 | Отправка чанков без try-catch и без fallback | HIGH |
| 5 | 327-332 | Отправка remaining чанков без try-catch | HIGH |
| 6 | 321 | Fallback отправка с тем же невалидным HTML | HIGH |
| 7 | 388-394 | `processThinkTagsForAdvice` не экранирует контент | MEDIUM |
| 8 | 831 | `sendDailyAdvice` — ошибка HTML-парсинга проглатывается без fallback на plain text | MEDIUM |
| 9 | 449 | `safelyTruncateHTML` добавляет "..." после лимита (закрывающие теги не считаются Telegram, но "..." +3 символа) | LOW |
| 10 | 231, 249 | Промежуточные стриминг-обновления (`editMessageText`) отправляют текст через `processThinkTags` без санитизации | HIGH |

---

## 4. Proposed Solutions

### 4.1. [P0] Добавить полноценную санитизацию HTML ответа AI

Нужна функция, которая:

1. Экранирует `<`, `>`, `&` во всём тексте
2. Затем "восстанавливает" только разрешённые теги из белого списка

```typescript
const ALLOWED_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'tg-emoji',
  'span' // только с class="tg-spoiler"
];

function sanitizeHtmlForTelegram(text: string): string {
  // Шаг 1: Убираем <think> блоки (обрабатываются отдельно)
  // processThinkTags уже вызван к этому моменту

  // Шаг 2: Экранируем ВСЁ
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Шаг 3: Восстанавливаем разрешённые теги
  // Открывающие теги с атрибутами:
  // <b>, <i>, <code>, <pre>, <blockquote>, <blockquote expandable>, <a href="...">, etc.
  for (const tag of ALLOWED_TAGS) {
    // Открывающие теги (с опциональными атрибутами)
    // ВАЖНО: используем [^>]* (после unescape) или [\s\S]*? (до &gt;) —
    // нельзя использовать [^&], т.к. атрибуты содержат &amp; после экранирования
    const openRegex = new RegExp(
      `&lt;(${tag})((?:\\s|&).*?)?&gt;`, 'gi'
    );
    result = result.replace(openRegex, (_, tagName, attrs) => {
      // Для <a> — восстановить href, для <blockquote> — expandable
      const safeAttrs = restoreAllowedAttributes(tagName, attrs || '');
      return `<${tagName}${safeAttrs}>`;
    });

    // Закрывающие теги
    const closeRegex = new RegExp(`&lt;/${tag}&gt;`, 'gi');
    result = result.replace(closeRegex, `</${tag}>`);
  }

  // Шаг 4: Закрыть незакрытые теги
  result = closeUnmatchedTags(result);

  return result;
}

function restoreAllowedAttributes(tag: string, escapedAttrs: string): string {
  if (!escapedAttrs) return '';

  // Восстановить & обратно для парсинга атрибутов
  const attrs = escapedAttrs
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  if (tag.toLowerCase() === 'a') {
    const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
    if (hrefMatch) return ` href="${escapeAttrValue(hrefMatch[1])}"`;
    return '';
  }
  if (tag.toLowerCase() === 'blockquote') {
    if (attrs.includes('expandable')) return ' expandable';
    return '';
  }
  if (tag.toLowerCase() === 'pre' || tag.toLowerCase() === 'code') {
    const classMatch = attrs.match(/class=["']([^"']*)["']/i);
    if (classMatch) return ` class="${escapeAttrValue(classMatch[1])}"`;
    return '';
  }
  if (tag.toLowerCase() === 'span') {
    if (attrs.includes('tg-spoiler')) return ' class="tg-spoiler"';
    return '';
  }
  if (tag.toLowerCase() === 'tg-emoji') {
    const idMatch = attrs.match(/emoji-id=["']([^"']*)["']/i);
    if (idMatch) return ` emoji-id="${escapeAttrValue(idMatch[1])}"`;
    return '';
  }
  return '';
}
```

### 4.2. [P0] Исправить обращение к свойствам ошибки GramIO

```typescript
// БЫЛО (строки 267, 315):
err?.description?.includes("message is not modified")

// НАДО:
err?.message?.includes("message is not modified")
```

Аналогично добавить обработку `can't parse entities`:

```typescript
} else if (err?.message?.includes("can't parse entities")) {
  console.error("[ASK] HTML parse error, sending as plain text:", err.message);
  // Отправить без форматирования как fallback
  try {
    await bot.api.editMessageText({
      chat_id: chatId,
      message_id: sentMessageId,
      text: stripAllHtml(textToSend),
      // БЕЗ parse_mode
    });
  } catch (innerErr) {
    console.error("[ASK] Failed even plain text:", innerErr);
  }
}
```

### 4.3. [P0] Санитизировать промежуточные стриминг-обновления

Текущий код (строка 231) вызывает `processThinkTags(fullResponse)` и отправляет результат через `editMessageText` с `parse_mode: "HTML"` (строка 253), но НЕ вызывает `sanitizeHtmlForTelegram`. Предложенная санитизация в 4.1 покрывает только `splitIntoChunks` (финальная отправка) и advice. Промежуточные обновления остаются уязвимыми.

```typescript
// Строка 231 — БЫЛО:
let textToSend = processThinkTags(fullResponse);

// НАДО:
let textToSend = sanitizeHtmlForTelegram(processThinkTags(fullResponse));
```

### 4.4. [P1] Исправить `splitIntoChunks` — обеспечить валидный HTML в каждом чанке

```typescript
function splitIntoChunks(text: string, maxLength: number): string[] {
  text = processThinkTags(text);
  text = sanitizeHtmlForTelegram(text); // ← НОВОЕ: санитизация ДО разбиения

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  // ... существующая логика разбиения ...

  // НОВОЕ: после разбиения — закрыть незакрытые теги в каждом чанке
  return chunks.map(chunk => closeUnmatchedTags(chunk));
}
```

### 4.5. [P1] Добавить try-catch + plain text fallback ко ВСЕМ отправкам

```typescript
async function safeSend(
  ctx: Ctx["Message"],
  text: string,
  options?: { parse_mode?: string }
): Promise<any> {
  try {
    return await ctx.send(text, options);
  } catch (err: any) {
    if (err?.message?.includes("can't parse entities")) {
      console.error("[ASK] HTML error, falling back to plain text");
      return await ctx.send(stripAllHtml(text));
    }
    if (err?.message?.includes("message is too long")) {
      console.error("[ASK] Message too long, truncating");
      // ВАЖНО: сначала stripAllHtml, потом truncate — иначе можно обрезать
      // посередине HTML-entity (например "&amp;" → "&am") что даст мусор
      const plainText = stripAllHtml(text);
      const truncated = plainText.substring(0, 4000) + "...";
      return await ctx.send(truncated);
    }
    throw err;
  }
}

function stripAllHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}
```

### 4.6. [P1] Исправить fallback на строке 321

```typescript
// БЫЛО:
await ctx.send(chunks[0], { parse_mode: "HTML" });

// НАДО:
await safeSend(ctx, chunks[0], { parse_mode: "HTML" });
// Или ещё лучше — отправить как plain text, раз HTML уже не прошёл:
await ctx.send(stripAllHtml(chunks[0]));
```

### 4.7. [P2] Санитизировать advice перед отправкой

```typescript
// Строка 829-831
const cleanAdvice = processThinkTagsForAdvice(advice);
const sanitizedAdvice = sanitizeHtmlForTelegram(cleanAdvice);  // ← НОВОЕ
const message = `\n\n💡 <b>Совет дня</b>\n\n${sanitizedAdvice}`;

try {
  await ctx.send(message, { parse_mode: "HTML" });
} catch (err: any) {
  // Fallback без HTML
  await ctx.send(`💡 Совет дня\n\n${stripAllHtml(cleanAdvice)}`);
}
```

### 4.8. [P2] Лимитировать длину после закрытия тегов в `safelyTruncateHTML`

```typescript
function safelyTruncateHTML(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  // Оставляем запас для закрывающих тегов и "..."
  const SAFETY_MARGIN = 200;
  let truncated = text.substring(0, maxLength - SAFETY_MARGIN);

  // ... логика закрытия тегов ...

  // Финальная проверка длины
  if (truncated.length > maxLength) {
    // Если даже с запасом не влезает — strip HTML и обрезать
    return stripAllHtml(text).substring(0, maxLength - 3) + "...";
  }

  return truncated;
}
```

---

## 5. Порядок приоритета реализации

| # | Задача | Приоритет | Влияние |
|---|--------|-----------|---------|
| 1 | Создать `sanitizeHtmlForTelegram()` и применить к КАЖДОМУ тексту перед отправкой | P0 | Устраняет основную причину — невалидный HTML |
| 2 | Исправить `err?.description` → `err?.message` | P0 | Починит обработку ошибок — сейчас ни одна проверка не работает |
| 3 | Санитизировать промежуточные стриминг-обновления (строка 231) | P0 | Без этого fix #1 не покрывает стриминг — только финальную отправку |
| 4 | Добавить `safeSend()` / `safeEditMessage()` с fallback на plain text | P1 | Гарантирует доставку сообщения даже при ошибках HTML |
| 5 | Исправить `splitIntoChunks` — закрывать теги в каждом чанке | P1 | Исправляет баг с разбиением длинных ответов |
| 6 | Обернуть ВСЕ `ctx.send` и `bot.api.editMessageText` в try-catch | P1 | Предотвращает необработанные исключения |
| 7 | Санитизировать advice | P2 | Advice — менее частый сценарий, но та же проблема |
| 8 | Добавить запас в `safelyTruncateHTML` для закрывающих тегов | P2 | Edge case, менее критично чем казалось (см. Review Notes) |

---

## 6. Дополнительные наблюдения

### 6.1. Потенциальная утечка памяти при стриминге

`fullResponse` накапливает весь ответ в памяти. При `max_tokens: 4000` это не проблема, но стоит иметь в виду.

### 6.2. Отсутствие timeout для стриминга

Если DeepSeek зависнет и перестанет слать чанки — `for await` повиснет навсегда. Нужен AbortController с таймаутом.

### 6.3. Множественные `processThinkTags` вызовы

`processThinkTags` вызывается на каждом промежуточном обновлении (строка 231), а потом ещё раз в `splitIntoChunks` (строка 457). Двойная обработка одного текста — потенциально двойное оборачивание в `<blockquote>`.

**Ситуация:**

1. Промежуточное обновление: `processThinkTags(fullResponse)` → think уже обработан, обёрнут в `<blockquote>`
2. Финальная отправка: `splitIntoChunks(fullResponse)` вызывает `processThinkTags` снова → оригинальный `fullResponse` всё ещё содержит `<think>`, так что это ОК.

Но `lastMessageText` хранит уже обработанный текст, а сравнивается с результатом новой обработки — это тоже ОК, потому что `processThinkTags` детерминирован.

### 6.4. `message_thread_id` не передаётся в `bot.api.editMessageText()`

При работе в топике форума (строка 44) `messageThreadId` извлекается, но НЕ передаётся в прямые вызовы `bot.api.editMessageText()` (строки 249, 308).

**`ctx.send()` — НЕ проблема:** GramIO автоматически добавляет `message_thread_id` в `ctx.send()` через `SendMixin` (файл `@gramio/contexts/dist/index.js`, строки 14197-14198):

```javascript
if (this.threadId && this.isTopicMessage?.() && !params.message_thread_id)
  params.message_thread_id = this.threadId;
```

**`bot.api.editMessageText()` — потенциальная проблема:** Прямые вызовы API (строки 249, 308) НЕ проходят через `SendMixin` и НЕ получают автоматическую подстановку `message_thread_id`. Однако `editMessageText` не требует `message_thread_id` — сообщение идентифицируется по `chat_id` + `message_id`, которые уникальны. Так что это НЕ баг.

---

## Review Notes

**Дата ревью:** 2026-03-09
**Ревьюер:** claude-opus-4-6 с проверкой по исходному коду

### Что было проверено

- Все номера строк в `src/bot/commands/ask.ts` (837 строк) — совпадают с заявленными в плане
- Исходный код GramIO `TelegramError` в `node_modules/gramio/dist/utils-CJfJNxc_.js` — подтверждает отсутствие `description`
- Исходный код GramIO `SendMixin` в `node_modules/@gramio/contexts/dist/index.js` — автоматическая подстановка `message_thread_id`
- Типы `TelegramError` в `node_modules/gramio/dist/index.d.ts` — свойства: `method`, `params`, `code`, `payload`

### Исправления, внесённые в план

1. **Секция 1.2:** Дополнен код `TelegramError` полной версией из исходников (было опущено `this.name`, `this.method`, `this.params`, `this.payload`). Суть была верной, но урезанный пример мог ввести в заблуждение.

2. **Секция 2.4:** Исправлена ошибка про лимит 4096 символов. Было: "включая HTML-теги". Telegram считает лимит по длине **отрендеренного** текста после парсинга HTML. HTML-теги не входят в лимит. Источник: Telegram Bot API docs — "1-4096 characters after entities parsing".

3. **Секция 1.6:** Понижен приоритет с СРЕДНИЙ до НИЗКИЙ. Поскольку Telegram считает лимит по отрендеренному тексту, добавление закрывающих тегов в `safelyTruncateHTML` не увеличивает количество видимых символов. Только "..." (+3 символа) потенциально может превысить лимит.

4. **Секция 1.5:** Уточнено, что `sendDailyAdvice` уже имеет try-catch (строки 718-835), но он просто проглатывает ошибку без fallback на plain text. Было написано "не обрабатывает ошибку отправки", что неточно.

5. **Секция 4.1:** Исправлен баг в regex для восстановления тегов. Было: `[^&]*?` — это ломается на атрибутах, содержащих `&amp;` (например, URL с `&` в `<a href>`). Заменено на `(?:\\s|&).*?` для корректного захвата экранированных атрибутов.

6. **Секция 4.5 (бывшая 4.4):** Исправлен порядок операций в `safeSend` при "message is too long". Было: `stripAllHtml(text.substring(0, 4000))` — обрезка HTML-исходника может разорвать entity (например `&amp;` -> `&am`). Надо: сначала `stripAllHtml`, потом `substring`.

7. **Секция 6.4:** Полностью переписана. Старая версия говорила "GramIO может обрабатывать автоматически, но стоит проверить". Проверено по исходникам: `ctx.send()` автоматически добавляет `message_thread_id` через `SendMixin`. `bot.api.editMessageText()` не получает автоподстановку, но ему она и не нужна — `editMessageText` идентифицирует сообщение по `chat_id` + `message_id`.

8. **Добавлена секция 4.3 [P0]:** Пропущенная проблема — промежуточные стриминг-обновления (строка 231) вызывают `processThinkTags`, но не `sanitizeHtmlForTelegram`. Без этого исправления санитизация в `splitIntoChunks` покрывает только финальную отправку, а все промежуточные `editMessageText` остаются уязвимыми к невалидному HTML.

9. **Добавлен Issue #10 в таблицу секции 3:** Промежуточные стриминг-обновления не санитизируются (строки 231, 249).

10. **Перенумерованы секции 4.3-4.8** для устранения коллизии номеров после добавления новой секции.

11. **Обновлена таблица приоритетов (секция 5):** Добавлена задача #3 (санитизация стриминга) с приоритетом P0, перенумерованы остальные.

# Дополнительный анализ лога ошибок

Анализ и план исправления ошибок отправки сообщений в Telegram

**Дата:** 2026-03-09

## 1. Анализ проблемы

На основании предоставленного лога ошибок (`~/Downloads/ExpenseSyncBot-error.log`) и документа с анализом (`docs/plans/2026-03-09-fix-telegram-messages.md`) были подтверждены две критические проблемы, приводящие к сбоям при отправке и редактировании сообщений бота.

### 1.1. Подтверждение из логов

Лог ошибок содержит многочисленные записи, полностью подтверждающие выводы из аналитического документа:

- **`Bad Request: can't parse entities`**: Эта ошибка встречается массово с различными причинами:
  - `Unsupported start tag "br"`
  - `Unsupported start tag "p"`
  - `Can't find end tag corresponding to start tag "blockquote"`
  - `Unclosed start tag`
  - Это прямое следствие отправки "сырого" текста ответа AI в Telegram без должной обработки. Код не экранирует спецсимволы (`<`, `>`), не удаляет неподдерживаемые теги и ломает разметку при разбивке на части.

- **`Bad Request: message is not modified`**: Эта ошибка также часто встречается. Она подтверждает, что код неправильно обрабатывает исключения от API Telegram (используется `err.description` вместо `err.message`), что приводит к бесполезным повторным запросам.

### 1.2. Ключевые причины сбоев в коде (`src/bot/commands/ask.ts`)

1. **Отсутствие HTML-экранирования (санитизации)**: Текст ответа AI отправляется в Telegram "как есть". Любой символ `<`, `>` или неподдерживаемый тег (`<p>`, `<div>`) приводит к ошибке. Экранируется только содержимое тегов `<think>`, а остальной текст — нет.
2. **Некорректная обработка ошибок `grammY`**: Код проверяет `err.description`, тогда как текст ошибки находится в `err.message`. В результате проверки всегда ложны, и код не может правильно отреагировать на ошибку `message is not modified`.
3. **Разбивка текста на части (`splitIntoChunks`) ломает HTML**: Функция не учитывает целостность HTML-тегов и может разорвать тег `<b>...</b>` на две части, делая оба сообщения невалидными.
4. **Отсутствие запасного варианта (Fallback)**: Многие вызовы `ctx.send` и `bot.api.editMessageText` не обёрнуты в `try-catch`. Если отправка с `parse_mode: "HTML"` проваливается, бот не пытается отправить сообщение в виде обычного текста, и пользователь ничего не получает.

## 2. План исправления

План полностью основан на предложениях из документа `docs/plans/2026-03-09-fix-telegram-messages.md`. Задачи отсортированы по приоритету.

### Шаг 1: [P0 - Критично] Создать и внедрить универсальный HTML-санитайзер

**Задача:** Написать функцию `sanitizeHtmlForTelegram(text: string)`, которая будет "чистить" весь текст перед отправкой.

**Логика функции:**

1. Экранировать во всем тексте символы `&` -> `&amp;`, `<` -> `&lt;`, `>` -> `&gt;`.
2. После экранирования "восстановить" только разрешённые Telegram теги (`<b>`, `<i>`, `<code>`, `<pre>`, `<blockquote>` и др.) из белого списка.
3. Удалить все остальные (неподдерживаемые) теги.
4. Обеспечить, чтобы все открытые теги были закрыты.

**Где применять:** Эту функцию нужно вызывать для **каждого** сообщения, отправляемого с `parse_mode: "HTML"`, особенно в `ask.ts`:

- При каждом промежуточном обновлении сообщения в стриме.
- Перед разбивкой финального ответа на части (`splitIntoChunks`).
- Перед отправкой "Совета дня" (`sendDailyAdvice`).

### Шаг 2: [P0 - Критично] Исправить обработку ошибок

**Задача:** Заменить все проверки `err?.description?.includes(...)` на `err?.message?.includes(...)`.

**Пример:**

```typescript
// БЫЛО
} else if (err?.description?.includes("message is not modified")) {

// НАДО
} else if (err?.message?.includes("message is not modified")) {
```

Это немедленно починит логику обработки уже отправленных сообщений.

### Шаг 3: [P1 - Важно] Реализовать Fallback на обычный текст

**Задача:** Обернуть все вызовы `ctx.send` и `bot.api.editMessageText` (или создать `safeSend` / `safeEdit` хелперы) в `try-catch`.

**Логика `catch` блока:**

1. Если ошибка содержит `"can't parse entities"`, повторно отправить/отредактировать сообщение, но уже **без** `parse_mode: "HTML"` и с текстом, очищенным от всех тегов.
2. Логировать ошибку для дальнейшего анализа.

Это гарантирует, что пользователь получит ответ в любом случае, даже если форматирование сломалось.

### Шаг 4: [P1 - Важно] Сделать разбивку на части (`splitIntoChunks`) безопасной для HTML

**Задача:** Модифицировать функцию `splitIntoChunks`.

**Логика:**

1. Сначала применить санитайзер `sanitizeHtmlForTelegram` ко всему тексту.
2. Разбить текст на части, как и раньше.
3. **После разбивки** пройтись по каждому чанку и добавить закрывающие теги для тех, что были разорваны. (Например, если чанк заканчивается на `<b>текст`, он должен стать `<b>текст</b>`).

### Шаг 5: [P2 - Желательно] Проверить все остальные отправки сообщений

**Задача:** Проверить другие команды, где бот отправляет форматированный текст, и убедиться, что там тоже применяется санитизация и есть `try-catch` с fallback. Например, `sendDailyAdvice`.

---

Выполнение этих шагов, начиная с P0, должно полностью устранить текущие проблемы с надёжностью доставки сообщений.
