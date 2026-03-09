# Calculator/Math Expressions в синтаксисе расходов

**Дата:** 2026-03-09
**Статус:** Research / Plan (reviewed 2026-03-09)

## Цель

Позволить пользователям писать математические выражения вместо фиксированных сумм. Вместо того чтобы считать в голове `10 * 3 = 30`, пользователь просто пишет `10*3$ food pizza` и бот сам посчитает.

---

## 1. Анализ текущего парсера

### Текущий flow в `parser.ts`

Парсер пробует 4 паттерна последовательно:

1. **Pattern 1** — символ валюты перед суммой: `$190`, `€100`, `₽500`

   ```
   /^([\$€£₽¥])\s*([\d\s,\.]+)\s*(.+)?$/
   ```

2. **Pattern 2** — сумма + код/символ валюты + текст: `190€ food`, `1900RSD транспорт`

   ```
   /^([\d\s,\.]+)\s*([а-яА-ЯёЁa-zA-Z\$€£₽¥]+)\s+(.+)$/
   ```

3. **Pattern 3** — только сумма + текст (дефолтная валюта): `100 food lunch`

   ```
   /^([\d\s,\.]+)\s+(.+)$/
   ```

4. **Pattern 4** — сумма + русская буква-алиас: `190е food`, `100д lunch`

   ```
   /^([\d\s,\.]+)([а-яА-ЯёЁ])\s+(.+)$/
   ```

### Ключевые ограничения

- Сумма определяется как `[\d\s,\.]+` — только цифры, пробелы, запятые и точки
- Функция `parseAmount()` чистит пробелы, обрабатывает европейский/американский формат, парсит через `currency.js`
- `parseAmount()` возвращает `null` если результат `<= 0`
- Категория — первое слово после суммы+валюты, комментарий — остальное

### Что нужно менять

Заменить `[\d\s,\.]+` (паттерн суммы) на паттерн, который захватывает math-выражение. Добавить функцию `evaluateMathExpression()` которая считает результат. Вызывать её из `parseAmount()`.

---

## 2. Предлагаемый дизайн

### 2.1. Новый паттерн для суммы

Текущий: `[\d\s,\.]+`

Новый: `[\d\s,\.+*×\/]+`

Но это слишком жадно. Нужно быть аккуратнее — минус создаёт проблемы (см. edge cases).

**Предлагаемый паттерн для math-выражения:**

```
[\d]+(?:[\.,]\d+)?(?:\s*[\+\*×\/]\s*[\d]+(?:[\.,]\d+)?)*
```

Разбор:

- `[\d]+(?:[\.,]\d+)?` — первое число (возможно с десятичной частью)
- `(?:\s*[\+\*×\/]\s*[\d]+(?:[\.,]\d+)?)*` — повторяющийся блок: оператор + число

Это намеренно **НЕ** включает `-` как оператор (см. раздел Edge Cases).

### 2.2. Поддержка скобок

Скобки добавляют сложности, но пользу приносят минимальную. Кто будет писать `(10+5)*3$ food`? Практически никто. Предлагаю **не поддерживать скобки** в первой версии. Если вдруг появятся реальные запросы — добавим.

### 2.3. Поддержка минуса

**Это главная проблема.** Рассмотрим: `100-20 food` — это `80 food` или `100` с чем-то? В текущем парсере `100-20 food` не парсится вообще (нет такого паттерна). Но если добавим минус, то `1900-01-01 food` тоже станет валидным выражением (`1900 - 01 - 01 = 1898`).

**Решение:** поддерживать минус **только** если он следует за другим оператором или числом в контексте явного выражения. Простейший подход — поддерживать минус только если в выражении уже есть другой оператор:

- `10*3-5` — ОК (есть `*`, значит это выражение)
- `100-20` — **НЕ парсить как выражение**, трактовать как `100` (дефолтная валюта, `-20` не парсится)

Ещё вариант: поддерживать минус **только после `*` или `/`**, т.е. `10*3-5` = ОК, но `100-20` = нет.

**Рекомендация:** В первой версии вообще не поддерживать минус. Это убирает целый класс неоднозначностей. Сложение, умножение и деление покрывают 99% use cases.

### 2.4. Архитектура изменений

```
parseExpenseMessage(text, defaultCurrency)
  │
  ├── Pattern 1-4: regex захватывает math-expression вместо просто числа
  │
  └── parseAmount(amountStr)  ← изменить
       │
       ├── Если содержит +*/× → evaluateMathExpression()
       └── Если просто число → текущая логика (currency.js)
```

#### Новая функция: `evaluateMathExpression(expr: string): number | null`

```typescript
/**
 * Evaluate simple math expression (no eval, no Function)
 * Supports: +, *, ×, /
 * Does NOT support: -, parentheses
 *
 * Examples: "10*3" → 30, "100/4" → 25, "10*3+5" → 35
 */
function evaluateMathExpression(expr: string): number | null {
  // Remove spaces
  const cleaned = expr.replace(/\s+/g, '');

  // Safety: reject overly long expressions
  if (cleaned.length > 50) return null;

  // Validate: only digits, dots, commas, and operators +*/×
  if (!/^[\d\.,]+([+\*×\/][\d\.,]+)+$/.test(cleaned)) {
    return null;
  }

  // Tokenize
  const tokens = tokenize(cleaned);
  if (!tokens) return null;

  // Safety: max 10 operators
  const opCount = tokens.filter(t => typeof t === 'string').length;
  if (opCount > 10) return null;

  // Evaluate with operator precedence (* / before +)
  const result = evaluateTokens(tokens);

  // Safety: reject unreasonable amounts
  if (result === null || result >= 10_000_000) return null;

  return result;
}
```

**Безопасная реализация (без eval/Function):**

```typescript
type MathToken = number | '+' | '*' | '/';

function tokenize(expr: string): MathToken[] | null {
  const tokens: MathToken[] = [];
  const regex = /(\d+(?:[.,]\d+)?)|([+\*×\/])/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(expr)) !== null) {
    if (match[1]) {
      // Number — handle comma as decimal separator
      let numStr = match[1];
      if (numStr.includes(',')) {
        numStr = numStr.replace(',', '.');
      }
      const num = parseFloat(numStr);
      if (isNaN(num)) return null;
      tokens.push(num);
    } else if (match[2]) {
      // Normalize × to *
      const op = match[2] === '×' ? '*' : match[2];
      tokens.push(op as MathToken);
    }
  }

  // Validate: must alternate number-operator-number
  // Minimum: num op num = 3 tokens, always odd count
  if (tokens.length < 3 || tokens.length % 2 === 0) return null;

  for (let i = 0; i < tokens.length; i++) {
    const isNumber = i % 2 === 0;
    if (isNumber && typeof tokens[i] !== 'number') return null;
    if (!isNumber && typeof tokens[i] !== 'string') return null;
  }

  return tokens;
}

function evaluateTokens(tokens: MathToken[]): number | null {
  if (!tokens || tokens.length === 0) return null;

  // Phase 1: handle * and / (higher precedence)
  const addQueue: MathToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (i + 2 <= tokens.length) {
      const op = tokens[i + 1];
      if (op === '*' || op === '/') {
        let left = tokens[i] as number;
        // Consume all consecutive * and /
        while (
          i + 2 < tokens.length &&
          (tokens[i + 1] === '*' || tokens[i + 1] === '/')
        ) {
          const operator = tokens[i + 1] as string;
          const right = tokens[i + 2] as number;
          if (operator === '*') {
            left *= right;
          } else {
            if (right === 0) return null; // division by zero
            left = left / right;
          }
          i += 2;
        }
        addQueue.push(left);
        i++;
        continue;
      }
    }
    addQueue.push(tokens[i]!);
    i++;
  }

  // Phase 2: handle + (lower precedence)
  let result = addQueue[0] as number;
  for (let j = 1; j < addQueue.length; j += 2) {
    const op = addQueue[j];
    const right = addQueue[j + 1] as number;
    if (op === '+') result += right;
  }

  return result;
}
```

### 2.5. Изменения в regex-паттернах

Текущий символ суммы во всех паттернах: `[\d\s,\.]+`

Новый: `[\d\s,\.+*×\/]+`

**Но!** Пробелы в числах (для `1 900 RSD`) конфликтуют с пробелами вокруг операторов. Поэтому нужно чётко определить: **пробелы в math-выражениях НЕ допускаются внутри чисел**. Если есть оператор — пробелы только вокруг операторов.

Это значит `1 900*3 RSD` — неоднозначно. Решение: если есть оператор, пробелы в числе не поддерживаются. `1900*3 RSD` — ОК. `1 900*3 RSD` — трактовать как `1` (а дальше `900*3` — мусор).

Реально: regex `[\d\s,\.+*×\/]+` захватит `1 900*3`, `parseAmount` уберёт пробелы → `1900*3` → `5700`. Так что это **работает автоматически** если очистить пробелы перед проверкой.

#### Конкретные regex-изменения

**Pattern 1** (символ перед суммой):

```typescript
// Было:
/^([\$€£₽¥])\s*([\d\s,\.]+)\s*(.+)?$/

// Стало:
/^([\$€£₽¥])\s*([\d\s,\.+*×\/]+)\s*(.+)?$/
```

**Pattern 2** (сумма + валюта + текст):

```typescript
// Было:
/^([\d\s,\.]+)\s*([а-яА-ЯёЁa-zA-Z\$€£₽¥]+)\s+(.+)$/

// Стало:
/^([\d\s,\.+*×\/]+)\s*([а-яА-ЯёЁa-zA-Z\$€£₽¥]+)\s+(.+)$/
```

**Pattern 3** (только сумма + текст):

```typescript
// Было:
/^([\d\s,\.]+)\s+(.+)$/

// Стало:
/^(\d[\d\s,\.+*×\/]*)\s+(.+)$/
```

Важно: `\s` остаётся в character class — иначе `1 900 food` перестанет парситься (регрессия). Regex backtracking корректно разделит `1 900 food` на amount=`1 900` + rest=`food`: regex greedily захватит всё, потом отступит, пока не найдёт `\s+(.+)$`. Первый символ обязательно `\d` — это предотвращает захват строк, начинающихся с оператора.

**Pattern 4** (сумма + русская буква):

```typescript
// Было:
/^([\d\s,\.]+)([а-яА-ЯёЁ])\s+(.+)$/

// Стало:
/^([\d\s,\.+*×\/]+)([а-яА-ЯёЁ])\s+(.+)$/
```

### 2.6. Модификация `parseAmount()`

```typescript
function parseAmount(amountStr: string): number | null {
  try {
    // Remove spaces
    let cleaned = amountStr.replace(/\s+/g, "");

    // Check if this is a math expression (contains operator)
    if (/[+\*×\/]/.test(cleaned)) {
      const result = evaluateMathExpression(cleaned);
      if (result === null || result <= 0) return null;
      // Round to 2 decimal places (evaluator returns raw float, e.g. 100/3 = 33.333...)
      return Math.round(result * 100) / 100;
    }

    // ... existing logic for plain numbers unchanged ...

    // Handle European format (1.234,56 -> 1234.56)
    if (cleaned.match(/\d+\.\d{3},\d{2}$/)) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    }
    // Handle US format with comma thousands separator (1,234.56)
    else if (cleaned.match(/\d+,\d{3}(\.\d+)?$/)) {
      cleaned = cleaned.replace(/,/g, "");
    }
    // Handle just comma as decimal separator (1234,56 -> 1234.56)
    else if (cleaned.match(/^\d+,\d{1,2}$/)) {
      cleaned = cleaned.replace(",", ".");
    }

    const parsed = currency(cleaned, { separator: "", decimal: "." });

    if (parsed.value <= 0) {
      return null;
    }

    return parsed.value;
  } catch (err) {
    return null;
  }
}
```

**Важно:** Результат `evaluateMathExpression` нужно проверять на `<= 0` (иначе `0*5` вернёт 0 вместо null) и округлять до 2 знаков (иначе `100/3` вернёт `33.333333333333336`).

---

## 3. Edge Cases и неоднозначности

### 3.1. `100-20 food` — минус или вычитание?

**Решение:** Не поддерживать минус в первой версии. `100-20 food` не парсится — как и сейчас.

### 3.2. `1 900*3 RSD` — пробел в числе + оператор

**Решение:** Regex захватит `1 900*3`. `parseAmount` уберёт пробелы → `1900*3` → `evaluateMathExpression("1900*3")` → `5700`. Работает автоматически.

### 3.3. `10*3+5$ food` — порядок операций

**Решение:** Стандартный приоритет: `*` и `/` раньше `+`. Результат: `10*3+5 = 35`, не `10*8 = 80`.

### 3.4. `10.5*3 food` — десятичные в выражениях

**Решение:** Поддерживать. `10.5*3 = 31.5`. Tokenizer обработает точку как десятичный разделитель.

### 3.5. `10,5*3 food` — запятая как десятичный разделитель

**Решение:** Поддерживать. `10,5*3 = 31.5`. Tokenizer заменит запятую на точку.

**Ограничение:** Запятая в выражениях трактуется ТОЛЬКО как десятичный разделитель, НЕ как thousands separator. `1,234*5` будет вычислено как `1.234 * 5 = 6.17`, а не `1234 * 5 = 6170`. Это приемлемо: tokenizer regex `(\d+(?:[.,]\d+)?)` всегда трактует запятую как десятичную часть. Thousands separators в выражениях не поддерживаются — и это разумно, потому что выражения подразумевают точные числа, а не форматированные.

### 3.6. `10**3 food` — двойной оператор

**Решение:** `tokenize()` вернёт `null` (нарушение чередования число-оператор-число). Выражение не парсится.

### 3.7. `*10 food` или `10* food` — оператор на краю

**Решение:** `tokenize()` вернёт `null`. Не парсится.

### 3.8. `10/0 food` — деление на ноль

**Решение:** `evaluateTokens()` вернёт `null` при делении на ноль. Расход не сохранится.

### 3.9. `10*3д food` — оператор + русский алиас валюты

**Решение:** Pattern 2 захватит `10*3` как сумму и `д` как валюту (Pattern 2 пробуется раньше Pattern 4). `parseAmount("10*3")` → `evaluateMathExpression("10*3")` → `30`. Работает.

### 3.10. `$10*3 food` — символ перед, оператор после

**Решение:** Pattern 1 захватит `$` как валюту и `10*3` как сумму. Работает.

### 3.11. `10*3 food` — без валюты

**Решение:** Pattern 3 захватит `10*3` как сумму, `food` как остаток. Дефолтная валюта. Работает.

### 3.12. Переполнение / гигантские числа

**Решение:** Добавить в `evaluateMathExpression` проверку результата: `result > 0 && result < 10_000_000`. Текущий парсер проверяет только `> 0`, но с калькулятором `999999*999999` даёт ~1 триллион. Лимит 10M достаточен для любых разумных расходов. Это решение, а не открытый вопрос.

### 3.13. `10×3 food` — Unicode multiplication sign

**Решение:** Поддерживать `×` (U+00D7) наряду с `*`. В tokenizer: `if (op === '×') op = '*'`. Мобильные клавиатуры часто подставляют `×` вместо `*`.

### 3.14. Конфликт `+` с URL/email

Маловероятно в контексте расходов, но стоит помнить. `100+tax food` — regex захватит `100+` в amount (символ `+` в character class), `tax` пойдёт в currency или текст. `parseAmount("100+")` → cleaned содержит `+` → `evaluateMathExpression("100+")` → validation regex fails → returns null. Паттерн не распарсится. Это не fallback на обычный парсер — **это полный отказ парсить**. Если пользователь случайно напишет `100+tax food`, бот скажет "не могу распознать". Это приемлемо — такой формат не имеет смысла.

### 3.15. `100/4 EUR food` — деление с дробным результатом

**Решение:** `100/4 = 25.0` — ОК. `100/3 = 33.333...` — JavaScript float. Math-ветка в `parseAmount` не проходит через `currency.js`, поэтому нужно явно округлять результат до 2 знаков в `parseAmount` (см. раздел 2.6).

### 3.16. Регрессия: `1 900 food` (пробелы в числе, без валюты)

Текущий Pattern 3 `[\d\s,\.]+` захватывает `1 900`. Новый паттерн `[\d][\d\s,\.+*×\/]*` тоже захватит `1 900` (через backtracking — regex greedily захватит всё включая `food`, потом отступит до `1 900`). `parseAmount` уберёт пробелы → `1900`. Нет регрессии.

### 3.17. `10 * 3 food` — пробелы вокруг оператора

**Решение:** Pattern 3 regex `[\d][\d\s,\.+*×\/]*` включает `\s`, поэтому greedily захватит `10 * 3`, backtracking отдаст `food`. `parseAmount("10 * 3")` уберёт пробелы → `10*3` → 30. Работает.

**Внимание — изменение поведения:** Сейчас `10 * 3 food` парсится как amount=10, category="*" (текущий `[\d\s,\.]+` не включает `*`). После изменения это станет amount=30, category="Food". Это желаемое поведение, но стоит зафиксировать как осознанное изменение.

### 3.18. `10.5+2,5 food` — смешанные десятичные разделители

**Решение:** Tokenizer обработает `10.5` как 10.5 (точка = десятичный), `2,5` → заменит запятую на точку → 2.5. Результат: 13. Работает корректно.

### 3.19. `100/3 food` — бесконечная десятичная дробь

**Решение:** `evaluateMathExpression("100/3")` вернёт `33.333333333333336`. `parseAmount` округлит до 2 знаков → `33.33`. Приемлемо.

### 3.20. `1,234*5 food` — thousands separator + оператор

**Решение:** Tokenizer regex `(\d+(?:[.,]\d+)?)` захватит `1,234` как одно число. Запятая заменится на точку → `1.234`. Результат: `1.234 * 5 = 6.17`. Пользователь ожидал `6170`. **Это ограничение:** thousands separators не работают в выражениях. Документировать в help-тексте: "В выражениях используйте числа без разделителей тысяч: `1234*5`, не `1,234*5`".

---

## 4. Безопасность

### 4.1. Категорический запрет `eval()`

Никакого `eval()`, `new Function()`, `vm.runInNewContext()`. Только ручной tokenizer + evaluator. Это не обсуждается.

### 4.2. ReDoS (Regular Expression Denial of Service)

Regex `[\d\s,\.+*×\/]+` не содержит вложенных квантификаторов — не подвержен ReDoS.

Tokenizer regex `/(\d+(?:[.,]\d+)?)|([+\*×\/])/g` тоже безопасен — линейный проход.

### 4.3. Ограничение длины выражения

Добавить проверку: если выражение длиннее 50 символов — отбросить. Никому не нужно считать `1+2+3+4+5+...+100`.

### 4.4. Ограничение количества операций

Максимум 10 операторов в одном выражении. Этого хватит за глаза.

---

## 5. Тест-кейсы

### 5.1. Новые тесты для `evaluateMathExpression`

```typescript
describe("evaluateMathExpression", () => {
  // Базовые операции
  test("10*3 → 30", () => expect(evaluateMathExpression("10*3")).toBe(30));
  test("100/4 → 25", () => expect(evaluateMathExpression("100/4")).toBe(25));
  test("10+5 → 15", () => expect(evaluateMathExpression("10+5")).toBe(15));
  test("10×3 → 30", () => expect(evaluateMathExpression("10×3")).toBe(30));

  // Комбинированные (приоритет операций)
  test("10*3+5 → 35", () => expect(evaluateMathExpression("10*3+5")).toBe(35));
  test("5+10*3 → 35", () => expect(evaluateMathExpression("5+10*3")).toBe(35));
  test("100/4+10 → 35", () => expect(evaluateMathExpression("100/4+10")).toBe(35));
  test("10*2*3 → 60", () => expect(evaluateMathExpression("10*2*3")).toBe(60));
  test("2+3+5 → 10", () => expect(evaluateMathExpression("2+3+5")).toBe(10));

  // Десятичные
  test("10.5*2 → 21", () => expect(evaluateMathExpression("10.5*2")).toBe(21));
  test("10,5*2 → 21", () => expect(evaluateMathExpression("10,5*2")).toBe(21));

  // Ошибки
  test("10/0 → null", () => expect(evaluateMathExpression("10/0")).toBeNull());
  test("10**3 → null", () => expect(evaluateMathExpression("10**3")).toBeNull());
  test("*10 → null", () => expect(evaluateMathExpression("*10")).toBeNull());
  test("10* → null", () => expect(evaluateMathExpression("10*")).toBeNull());
  test("abc → null", () => expect(evaluateMathExpression("abc")).toBeNull());
  test("empty string → null", () => expect(evaluateMathExpression("")).toBeNull());

  // Обычное число — не выражение, должен вернуть null
  test("100 → null (not an expression)", () =>
    expect(evaluateMathExpression("100")).toBeNull());

  // Overflow
  test("999999*999999 → null (too large)", () =>
    expect(evaluateMathExpression("999999*999999")).toBeNull());

  // Division precision
  test("100/3 → 33.33...", () => {
    const result = evaluateMathExpression("100/3");
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(33.333, 2);
  });

  // Mixed decimal separators
  test("10.5+2,5 → 13", () =>
    expect(evaluateMathExpression("10.5+2,5")).toBe(13));

  // Trailing operator
  test("10+ → null", () =>
    expect(evaluateMathExpression("10+")).toBeNull());

  // Spaces (evaluateMathExpression strips spaces)
  test("10 * 3 → 30 (spaces stripped)", () =>
    expect(evaluateMathExpression("10 * 3")).toBe(30));
});
```

### 5.2. Интеграционные тесты для `parseExpenseMessage`

```typescript
describe("math expressions in expenses", () => {
  // Умножение
  test("10*3$ food pizza → $30", () => {
    const r = parseExpenseMessage("10*3$ food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("USD");
    expect(r?.category).toBe("Food");
  });

  test("$10*3 food pizza → $30", () => {
    const r = parseExpenseMessage("$10*3 food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("USD");
  });

  test("10*3 food pizza → 30 (default currency)", () => {
    const r = parseExpenseMessage("10*3 food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  test("10*3д food pizza → $30", () => {
    const r = parseExpenseMessage("10*3д food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("USD");
  });

  test("10*3е food pizza → €30", () => {
    const r = parseExpenseMessage("10*3е food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  test("10*3 EUR food pizza → €30", () => {
    const r = parseExpenseMessage("10*3 EUR food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  // Деление
  test("100/4€ food → €25", () => {
    const r = parseExpenseMessage("100/4€ food", "USD");
    expect(r?.amount).toBe(25);
    expect(r?.currency).toBe("EUR");
  });

  // Сложение
  test("10+5$ food → $15", () => {
    const r = parseExpenseMessage("10+5$ food", "EUR");
    expect(r?.amount).toBe(15);
    expect(r?.currency).toBe("USD");
  });

  // Комбо
  test("10*3+5 food → 35 (default)", () => {
    const r = parseExpenseMessage("10*3+5 food", "EUR");
    expect(r?.amount).toBe(35);
    expect(r?.currency).toBe("EUR");
  });

  // Десятичные в выражении
  test("10.5*2$ food → $21", () => {
    const r = parseExpenseMessage("10.5*2$ food", "EUR");
    expect(r?.amount).toBe(21);
    expect(r?.currency).toBe("USD");
  });

  // Unicode multiplication
  test("10×3 food → 30 (default)", () => {
    const r = parseExpenseMessage("10×3 food", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  // --- Regression tests (existing functionality must not break) ---

  test("100$ food → $100 (no regression)", () => {
    const r = parseExpenseMessage("100$ food", "EUR");
    expect(r?.amount).toBe(100);
    expect(r?.currency).toBe("USD");
  });

  test("1 900 RSD транспорт → 1900 RSD (no regression)", () => {
    const r = parseExpenseMessage("1 900 RSD транспорт", "EUR");
    expect(r?.amount).toBe(1900);
    expect(r?.currency).toBe("RSD");
  });

  test("190е Алекс кулёма → €190 (no regression)", () => {
    const r = parseExpenseMessage("190е Алекс кулёма", "USD");
    expect(r?.amount).toBe(190);
    expect(r?.currency).toBe("EUR");
  });

  test("$100 food lunch → $100 (no regression)", () => {
    const r = parseExpenseMessage("$100 food lunch", "EUR");
    expect(r?.amount).toBe(100);
    expect(r?.currency).toBe("USD");
  });

  test("100 food lunch → 100 default (no regression)", () => {
    const r = parseExpenseMessage("100 food lunch", "EUR");
    expect(r?.amount).toBe(100);
    expect(r?.currency).toBe("EUR");
  });

  // Результат <= 0 → null
  test("0*5 food → null", () => {
    const r = parseExpenseMessage("0*5 food", "EUR");
    expect(r).toBeNull();
  });

  // Overflow → null
  test("999999*999999 food → null (too large)", () => {
    const r = parseExpenseMessage("999999*999999 food", "EUR");
    expect(r).toBeNull();
  });

  // Division precision
  test("100/3 EUR food → 33.33", () => {
    const r = parseExpenseMessage("100/3 EUR food", "EUR");
    expect(r?.amount).toBe(33.33);
    expect(r?.currency).toBe("EUR");
  });

  // Spaces around operator
  test("10 * 3 food → null or 30 (behavior change)", () => {
    const r = parseExpenseMessage("10 * 3 food", "EUR");
    // With new regex: amount captures "10 * 3", parseAmount strips spaces → "10*3" → 30
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  // 1 900 food — regression with spaces in number
  test("1 900 food → 1900 (no regression, spaces in number)", () => {
    const r = parseExpenseMessage("1 900 food", "EUR");
    expect(r?.amount).toBe(1900);
    expect(r?.currency).toBe("EUR");
  });

  // Invalid expression should fail completely
  test("100+tax food → null (invalid expression)", () => {
    const r = parseExpenseMessage("100+tax food", "EUR");
    expect(r).toBeNull();
  });

  // 1 900*3 RSD — spaces + operator
  test("1 900*3 RSD food → 5700 RSD", () => {
    const r = parseExpenseMessage("1 900*3 RSD food", "EUR");
    expect(r?.amount).toBe(5700);
    expect(r?.currency).toBe("RSD");
  });
});
```

---

## 6. План имплементации

### Шаг 1: Функция `evaluateMathExpression()` (отдельная, тестируемая)

Добавить в `parser.ts`:

- `type MathToken`
- `tokenize(expr: string): MathToken[] | null`
- `evaluateTokens(tokens: MathToken[]): number | null`
- `evaluateMathExpression(expr: string): number | null`

Экспортировать `evaluateMathExpression` для тестов.

### Шаг 2: Модификация `parseAmount()`

В начале `parseAmount()` после очистки пробелов добавить проверку: если строка содержит `+`, `*`, `×` или `/` — вызвать `evaluateMathExpression()`. Если вернулось число — проверить `> 0`, округлить до 2 знаков (`Math.round(result * 100) / 100`), вернуть. Если `null` или `<= 0` — вернуть `null`.

### Шаг 3: Модификация regex в паттернах 1-4

Расширить символьные классы суммы, добавив `+*×/`. Это минимальные изменения в 4 строках.

### Шаг 4: Тесты

Добавить все тест-кейсы из раздела 5. Убедиться что существующие тесты проходят (регрессия). Запустить `bun test`.

### Шаг 5: Обновить help-тексты

В `MESSAGES.invalidFormat` и `MESSAGES.setupComplete` в `constants.ts` добавить примеры с выражениями:

```
'• 10*3$ еда пицца за троих\n'
```

### Оценка сложности

| Что | Строк кода |
|-----|-----------|
| `evaluateMathExpression` + tokenizer + evaluator | ~65 |
| Изменения regex (4 паттерна) | ~10 |
| Изменения `parseAmount` | ~8 |
| Тесты | ~120 |
| Help-тексты | ~5 |
| **Итого** | **~208** |

Время: 2-3 часа.

---

## 7. Что НЕ делаем (и почему)

| Фича | Почему нет |
|-------|-----------|
| Скобки `(10+5)*3` | Практически никто не будет использовать. Усложняет парсер непропорционально. |
| Минус `100-20` | Неоднозначность с отрицательными числами, датами, ID. Почти нет use case. |
| Степень `10^2` | Кому это нужно при записи расходов? |
| Проценты `100+10%` | Интересно но сложно и редко нужно. Может быть в v2. |
| `eval()` / `Function()` | Инъекция кода. Даже не обсуждается. |

---

## 8. Открытые вопросы

1. **Нужно ли показывать пользователю формулу?** Сейчас бот ставит реакцию и молчит. Стоит ли при обнаружении выражения отправить "10*3 = 30"? Или это шум? Можно показывать только если было выражение, в формате reply.

2. **Записывать ли формулу в comment?** Можно сохранять оригинальное выражение (`10*3`) в комментарий расхода для audit trail. Или в отдельное поле `raw_expression` в таблице expenses.

3. ~~**Нужна ли валидация максимальной суммы?**~~ **Решено:** Да. Лимит 10 000 000 добавлен в `evaluateMathExpression`. См. раздел 3.12.

---

## Review Notes

Ревью проведено 2026-03-09. Верифицирован исходный код `parser.ts`, `parser.test.ts`, `constants.ts`. Все 30 существующих тестов проходят. Ниже список найденных проблем и внесённых исправлений.

### Баги в коде

1. **parseAmount не проверял `<= 0` для math-выражений.** В оригинальном плане `evaluateMathExpression` возвращала результат напрямую, минуя проверку `parsed.value <= 0`. `0*5 food` вернул бы amount=0 вместо null. Тест `0*5 food -> null` падал бы. **Исправлено:** добавлена проверка `result <= 0` в math-ветке `parseAmount` (раздел 2.6).

2. **parseAmount не округлял результат деления.** `100/3` возвращал бы `33.333333333333336` (raw JavaScript float). Раздел 3.15 утверждал что `currency.js` округлит, но math-ветка обходит `currency.js` стороной. **Исправлено:** добавлен `Math.round(result * 100) / 100` в math-ветке (раздел 2.6).

3. **evaluateMathExpression не проверяла верхнюю границу.** `999999*999999` вернёт ~1 триллион. **Исправлено:** добавлена проверка `result >= 10_000_000` в `evaluateMathExpression` (раздел 2.4). Открытый вопрос 3 закрыт.

### Неточности в описании

1. **Edge case 3.9:** план писал "Pattern 2 или Pattern 4". На самом деле всегда Pattern 2, потому что паттерны пробуются последовательно и Pattern 2 идёт раньше. **Исправлено.**

2. **Edge case 3.14 (100+tax food):** план утверждал что будет "fallback на обычный парсер". На самом деле `+` в character class заставит regex захватить `100+` как amount, `parseAmount` обнаружит оператор, `evaluateMathExpression` отвергнет невалидное выражение, и весь паттерн вернёт null. Fallback-а на обычный парсер нет — это полный отказ. **Исправлено.**

3. **Edge case 3.15:** утверждение что `currency.js` округлит дробь было неверным для math-ветки. **Исправлено.**

4. **Раздел 2.5, Pattern 3:** запутанное повествование "сначала убрали пробелы, потом вернули". Переписано как одно чистое решение с объяснением почему `\s` нужен (backtracking корректно разделяет `1 900 food`).

### Добавленные edge cases

1. **3.17: `10 * 3 food`** — пробелы вокруг оператора. Работает через backtracking, но это осознанное изменение поведения: раньше это парсилось как amount=10, category="*".

2. **3.18: `10.5+2,5 food`** — смешанные десятичные разделители (точка и запятая в одном выражении).

3. **3.19: `100/3 food`** — бесконечная десятичная дробь и необходимость округления.

4. **3.20: `1,234*5 food`** — thousands separator в выражении трактуется как десятичный → `1.234*5 = 6.17` вместо ожидаемых `6170`. Это ограничение, которое нужно документировать.

### Добавленные тесты

1. В раздел 5.1 добавлены тесты: overflow (`999999*999999`), division precision (`100/3`), mixed decimals (`10.5+2,5`), trailing operator (`10+`), spaces (`10 * 3`).

2. В раздел 5.2 добавлены интеграционные тесты: overflow, division precision, spaces around operator, `1 900 food` regression, invalid expression (`100+tax food`), spaces + operator + currency (`1 900*3 RSD food`).

### Алгоритм evaluateTokens — верифицирован

Алгоритм двухфазного вычисления (Phase 1: `*` и `/`, Phase 2: `+`) проверен на примерах:

- `5+10*3` → tokens [5, '+', 10, '*', 3] → addQueue [5, '+', 30] → result 35
- `10*2*3` → tokens [10, '*', 2, '*', 3] → addQueue [60] → result 60
- `10*3+5` → tokens [10, '*', 3, '+', 5] → addQueue [30, '+', 5] → result 35

Граничное условие `i + 2 <= tokens.length` на строке 186 корректно: проверяет наличие потенциального оператора на позиции `i+1`. Алгоритм работает правильно.
