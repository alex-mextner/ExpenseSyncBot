# Smart Advice System: Research Plan

> Дата: 2026-03-09
> Статус: Research / Design

---

## 1. Анализ текущего состояния

### Что есть сейчас

Advice-система живёт в `src/bot/commands/ask.ts` и состоит из трёх функций:

- **`maybeSendDailyAdvice(ctx, groupId)`** — срабатывает после каждого `@ask` с вероятностью 20% (`Math.random() > 0.2` — т.е. 80% шанс return, 20% шанс совета). Никакой логики "стоит ли сейчас давать совет" нет — чистая рулетка.

- **`sendDailyAdvice(ctx, groupId)`** — собирает базовую статистику текущего месяца (сумма трат, top-10 категорий, последние 10 операций) и отправляет в LLM с промптом "дай философский совет дня в 1-2 предложения".

- **`handleAdviceCommand(ctx)`** — команда `/advice`, вызывает `sendDailyAdvice` без проверки вероятности.

### Проблемы текущей реализации

1. **Рандомный триггер** — 20% после каждого @ask. Если группа активно пользуется ботом, советы сыплются каждые 5 минут. Если редко — можно месяц не увидеть ни одного.

2. **Примитивный контекст** — бот видит только текущий месяц. Нет сравнения с прошлым месяцем, нет трендов, нет прогнозов. Информации для по-настоящему полезного совета недостаточно.

3. **"Философский совет"** — промпт просит "мудрый философский совет дня". Результат — банальщина уровня "деньги любят счёт". Никакой привязки к реальным числам, паттернам, аномалиям.

4. **Нет дедупликации** — может дать один и тот же совет три раза подряд. Нет памяти о прошлых советах.

5. **`max_tokens: 300`** — жёстко ограничивает глубину анализа. Для quick tip это ок, для deep analysis — мало.

6. **`temperature: 0.9`** — слишком высокая для финансового анализа, провоцирует галлюцинации с числами.

7. **Нет tiered advice** — один формат на все случаи. Нет разницы между "у тебя всё хорошо" и "ты пробил бюджет на 200%".

---

## 2. Метрики финансового анализа

Ниже — метрики, которые нужно вычислять и включать в контекст для LLM. Каждая метрика — это конкретный data point, который превращает абстрактный совет в конкретный инсайт.

### 2.1 Budget Burn Rate (скорость сжигания бюджета)

Самая ценная метрика. Показывает, хватит ли бюджета до конца месяца при текущем темпе.

```typescript
interface BudgetBurnRate {
  category: string;
  budget_limit: number;
  spent: number;
  currency: string;
  days_elapsed: number;        // сколько дней прошло с начала месяца
  days_remaining: number;      // сколько осталось
  daily_burn_rate: number;     // spent / days_elapsed
  projected_total: number;     // daily_burn_rate * days_in_month
  projected_overshoot: number; // projected_total - budget_limit (отриц. = экономия)
  runway_days: number;         // (budget_limit - spent) / daily_burn_rate
  status: 'on_track' | 'warning' | 'critical' | 'exceeded';
}
```

**SQL:**
```sql
-- Траты по категории за текущий месяц (для burn rate)
SELECT category, SUM(eur_amount) as total_spent, COUNT(*) as tx_count
FROM expenses
WHERE group_id = ? AND date >= ? AND date <= ?
GROUP BY category;
```

**Пороги (проверяются сверху вниз — первое совпадение побеждает):**
- `exceeded`: spent >= budget_limit (уже фактически превышен, не прогноз)
- `critical`: projected_total > budget_limit * 1.0 (прогноз: превысит бюджет)
- `warning`: projected_total > budget_limit * 0.85 (прогноз: приближается к лимиту)
- `on_track`: всё остальное

> Важно: `exceeded` проверяется первым, т.к. это факт, а не прогноз. Если spent уже >= limit, нет смысла считать projected.

### 2.2 Week-over-Week / Month-over-Month Trends

Сравнение текущего периода с предыдущим. Показывает направление — тратите больше или меньше.

```typescript
interface SpendingTrend {
  period: 'week' | 'month';
  current_total: number;
  previous_total: number;
  change_percent: number;       // ((current - previous) / previous) * 100
  direction: 'up' | 'down' | 'stable';  // stable = +-5%
  // Детализация по категориям
  category_changes: Array<{
    category: string;
    current: number;
    previous: number;
    change_percent: number;
  }>;
}
```

**SQL:**
```sql
-- Текущая неделя (7 дней включая сегодня) vs прошлая неделя
-- NB: date('now') в SQLite — UTC. Для точности лучше передавать дату из JS.
SELECT
  CASE
    WHEN date >= date(?, '-6 days') THEN 'current_week'
    WHEN date >= date(?, '-13 days') AND date < date(?, '-6 days') THEN 'previous_week'
  END as period,
  category,
  SUM(eur_amount) as total
FROM expenses
WHERE group_id = ? AND date >= date(?, '-13 days')
GROUP BY period, category
HAVING period IS NOT NULL;
-- HAVING period IS NOT NULL фильтрует записи, не попавшие ни в один CASE

-- Текущий месяц (до текущего дня) vs прошлый месяц (до того же дня)
-- Важно: сравнивать пропорционально, т.е. первые N дней текущего месяца
-- с первыми N днями прошлого.
-- Параметры: ?, ? = current_month_start, today; ?, ? = prev_month_start, prev_month_same_day
SELECT
  category,
  SUM(CASE WHEN date >= ? AND date <= ? THEN eur_amount ELSE 0 END) as current_month,
  SUM(CASE WHEN date >= ? AND date <= ? THEN eur_amount ELSE 0 END) as previous_month
FROM expenses
WHERE group_id = ? AND date >= ? AND date <= ?
GROUP BY category;
```

### 2.3 Category Anomaly Detection

Выявление аномально высоких трат в категории. Простой подход: текущие траты в категории за период vs среднее за последние 3 месяца. Если > 1.5x среднего — аномалия.

```typescript
interface CategoryAnomaly {
  category: string;
  current_month_total: number;
  avg_3_month: number;
  deviation_ratio: number;   // current / avg (2.0 = в два раза больше нормы)
  severity: 'mild' | 'significant' | 'extreme';
}
```

**SQL:**
```sql
-- Среднемесячные траты по категориям за последние 3 месяца (исключая текущий)
SELECT
  category,
  AVG(monthly_total) as avg_monthly,
  MAX(monthly_total) as max_monthly,
  MIN(monthly_total) as min_monthly,
  COUNT(*) as months_with_data
FROM (
  SELECT
    category,
    strftime('%Y-%m', date) as month,
    SUM(eur_amount) as monthly_total
  FROM expenses
  WHERE group_id = ?
    AND date >= date('now', 'start of month', '-3 months')
    AND date < date('now', 'start of month')
  GROUP BY category, month
) sub
GROUP BY category;
```

**Пороги:**
- `mild`: 1.3x - 1.5x от среднего
- `significant`: 1.5x - 2.5x
- `extreme`: > 2.5x

### 2.4 Day-of-Week Spending Patterns

Паттерны по дням недели. Полезно для: "по субботам вы тратите в 3 раза больше".

```typescript
interface DayOfWeekPattern {
  day_of_week: number;       // 0=Sun, 6=Sat (SQLite strftime('%w') convention)
  day_name: string;
  avg_daily_spend: number;   // total / unique_days (не avg per tx!)
  total_transactions: number;
  top_category: string;
  // Сравнение с общим средним
  vs_average_percent: number; // сколько % от среднедневного
}
```

**SQL:**
```sql
SELECT
  CAST(strftime('%w', date) AS INTEGER) as dow, -- 0=Sun, 1=Mon, ..., 6=Sat
  COUNT(*) as tx_count,
  SUM(eur_amount) as total,
  AVG(eur_amount) as avg_per_tx,
  COUNT(DISTINCT date) as unique_days
FROM expenses
WHERE group_id = ? AND date >= date(?, '-90 days')
GROUP BY dow;
-- avg_daily_spend вычислять в JS как total / unique_days
-- top_category — отдельный запрос или подзапрос с RANK/ROW_NUMBER (но SQLite <3.25 не поддерживает window functions; bun:sqlite поддерживает)
```

### 2.5 Spending Velocity (ускорение/замедление)

Показывает, тратите ли вы всё быстрее или замедляетесь. Сравнение daily_burn_rate первой половины месяца со второй, или последних 7 дней vs 7 дней до того.

```typescript
interface SpendingVelocity {
  period_1_daily_avg: number;  // более ранний период
  period_2_daily_avg: number;  // более поздний период
  acceleration: number;        // (p2 - p1) / p1 * 100
  trend: 'accelerating' | 'decelerating' | 'stable';
}
```

**SQL:**
```sql
-- Последние 7 дней vs предыдущие 7 дней
-- Параметр ? = today (YYYY-MM-DD), передаётся из JS для избежания проблем с UTC
SELECT
  CASE
    WHEN date >= date(?, '-6 days') THEN 'recent'
    ELSE 'earlier'
  END as period,
  SUM(eur_amount) as total,
  COUNT(*) as tx_count,
  COUNT(DISTINCT date) as active_days
FROM expenses
WHERE group_id = ? AND date >= date(?, '-13 days') AND date <= ?
GROUP BY period;
-- Добавлен `date <= ?` чтобы не захватить будущие записи (если кто-то внёс расход с завтрашней датой)
```

**Важно для velocity:** делить total на 7 (фиксированный размер окна), а не на active_days. Иначе 1 большая трата за 1 день покажет тот же daily_avg, что 7 мелких за 7 дней — а это разные паттерны.

### 2.6 Budget Utilization Rate (использование бюджета)

Если есть бюджет — можно посчитать, какой % бюджета остаётся. Это НЕ настоящий savings rate (для него нужен income, которого у нас нет), а budget utilization — насколько полно используется выделенный бюджет.

```typescript
interface BudgetUtilization {
  total_budget: number;
  total_spent: number;
  remaining: number;
  utilization_percent: number;   // (spent / budget) * 100
  remaining_percent: number;     // (budget - spent) / budget * 100
  // Без привязки к 50/30/20 — эта модель требует данных о доходе, которых у нас нет.
  // Вместо этого: если utilization > 90% — concern, > 100% — critical
}
```

> Примечание: правило 50/30/20 (needs/wants/savings) требует знания дохода пользователя. У нас есть только траты и бюджет. Не стоит притворяться, что (budget - spent) = savings. Это просто остаток бюджета.

### 2.7 Top Spending Streak

Последовательные дни с тратами выше среднего. "Вы тратите больше обычного уже 5 дней подряд."

```typescript
interface SpendingStreak {
  current_streak_days: number;
  streak_type: 'above_average' | 'below_average' | 'no_spending';
  avg_daily_during_streak: number;
  overall_daily_average: number;
}
```

**Вычисление:** streak нельзя посчитать одним SQL-запросом (нужно сканировать последовательные дни с конца). Подход:
1. Получить `getDailyTotals()` за последние 30 дней
2. Посчитать overall average
3. Идти от сегодня назад, считая streak пока daily_total > average (или < average)
4. Дни без расходов разрывают streak (или включаются в below_average — решить при реализации)

### 2.8 Monthly Projection (прогноз на конец месяца)

Линейная экстраполяция текущего темпа на весь месяц. По каждой категории и суммарно.

```typescript
interface MonthlyProjection {
  days_elapsed: number;
  days_in_month: number;
  current_total: number;
  projected_total: number;           // (current_total / days_elapsed) * days_in_month
  projected_vs_last_month: number;   // projected / last_month_total * 100
  confidence: 'low' | 'medium' | 'high'; // low = <7 дней данных, high = >20 дней
  category_projections: Array<{
    category: string;
    current: number;
    projected: number;
    budget_limit: number | null;
    will_exceed: boolean;
  }>;
}
```

> Edge case: `days_elapsed = 0` (1-е число, нет трат) — projection невозможна, возвращать null. При `days_elapsed < 7` — линейная экстраполяция ненадёжна (одна крупная покупка может исказить прогноз в 10 раз), пометить `confidence: 'low'` и не использовать для триггеров.

---

## 3. Data Pipeline

### 3.1 Архитектура: AnalyticsService

Новый сервис `src/services/analytics/spending-analytics.ts` — центральный модуль для вычисления всех метрик. Не хранит состояние, получает данные из репозиториев, возвращает чистые структуры.

```
src/services/analytics/
├── spending-analytics.ts    # Главный класс — вычисляет все метрики
├── types.ts                 # Типы для всех метрик (см. секцию 2)
└── formatters.ts            # Форматирование метрик в текст для LLM-промпта
```

```typescript
// spending-analytics.ts — основной API

export class SpendingAnalytics {
  constructor(private db: Database) {}

  /**
   * Собирает полный "финансовый снимок" для группы.
   * Это основной метод — его результат уходит в промпт.
   */
  getFinancialSnapshot(groupId: number): FinancialSnapshot {
    const now = new Date();
    const currentMonth = format(now, 'yyyy-MM');

    return {
      burnRates: this.computeBurnRates(groupId, currentMonth),
      weekTrend: this.computeWeekOverWeek(groupId),
      monthTrend: this.computeMonthOverMonth(groupId, currentMonth),
      anomalies: this.computeAnomalies(groupId, currentMonth),
      dayOfWeekPatterns: this.computeDayPatterns(groupId),
      velocity: this.computeVelocity(groupId),
      budgetUtilization: this.computeBudgetUtilization(groupId, currentMonth),
      streak: this.computeStreak(groupId),
      projection: this.computeProjection(groupId, currentMonth),
    };
  }

  // Каждый compute-метод содержит SQL-запрос + бизнес-логику
  // Все методы работают синхронно (bun:sqlite — синхронный)
}
```

### 3.2 Новые SQL-запросы в ExpenseRepository

Вместо подтягивания всех 100000 расходов в JS и фильтрации там — добавить целевые запросы:

```typescript
// Добавить в expense.repository.ts:

// Суммарные траты по месяцам (для трендов)
getMonthlyTotals(groupId: number, monthsBack: number): MonthlyTotal[]

// Траты по категориям за диапазон дат
getCategoryTotals(groupId: number, startDate: string, endDate: string): CategoryTotal[]

// Ежедневные суммы (для velocity и streak)
getDailyTotals(groupId: number, daysBack: number): DailyTotal[]

// Траты по дням недели (агрегация)
getDayOfWeekStats(groupId: number, daysBack: number): DayOfWeekStats[]

// Количество дней с тратами (для корректных средних)
getActiveDaysCount(groupId: number, startDate: string, endDate: string): number
```

Все запросы — одиночные `SELECT` с `GROUP BY`, никаких N+1. SQLite справится быстро.

**Важно: нужен составной индекс.** Сейчас есть отдельные индексы на `group_id` и `date`, но нет составного `(group_id, date)`. Для аналитических запросов (WHERE group_id = ? AND date >= ? AND date <= ?) составной индекс критичен — без него SQLite может сканировать всю таблицу. Добавить миграцию:

```sql
CREATE INDEX IF NOT EXISTS idx_expenses_group_date ON expenses(group_id, date);
-- Этот индекс покрывает все аналитические запросы и ускорит их на порядок для больших таблиц
```

### 3.3 Форматирование для LLM

`formatters.ts` превращает `FinancialSnapshot` в текстовый блок для промпта:

```typescript
export function formatSnapshotForPrompt(snapshot: FinancialSnapshot): string {
  const sections: string[] = [];

  // Секция 1: Budget Burn Rates
  if (snapshot.burnRates.length > 0) {
    sections.push(formatBurnRates(snapshot.burnRates));
  }

  // Секция 2: Trends
  sections.push(formatTrends(snapshot.weekTrend, snapshot.monthTrend));

  // Секция 3: Anomalies (только если есть)
  if (snapshot.anomalies.length > 0) {
    sections.push(formatAnomalies(snapshot.anomalies));
  }

  // Секция 4: Projection
  sections.push(formatProjection(snapshot.projection));

  // Секция 5: Velocity
  if (snapshot.velocity.trend !== 'stable') {
    sections.push(formatVelocity(snapshot.velocity));
  }

  // Секция 6: Streak (только если streak >= 3 дней)
  if (snapshot.streak.current_streak_days >= 3) {
    sections.push(formatStreak(snapshot.streak));
  }

  return sections.join('\n\n');
}
```

---

## 4. Prompt Engineering

### 4.1 Tiered Advice System

Вместо одного формата "философский совет" — три уровня глубины, выбираемые автоматически на основе данных:

#### Tier 1: Quick Insight (1-2 предложения)
**Когда:** Нет критичных проблем, вызван из `maybeSendAdvice` (фоновый).
**Формат:** Одно конкретное наблюдение + один actionable совет.
**max_tokens:** 500 (для DeepSeek-R1 нужен запас на `<think>` блок, который мы потом отрежем)
**temperature:** 0.6

```
Промпт: "Дай ОДИН конкретный финансовый инсайт на основе данных ниже.
Не философствуй. Назови конкретную цифру и конкретное действие."
```

#### Tier 2: Alert (3-5 предложений)
**Когда:** Обнаружена аномалия, burn rate в warning/critical, velocity ускоряется.
**Формат:** Описание проблемы + контекст + рекомендация.
**max_tokens:** 1000 (запас на think-блок)
**temperature:** 0.5

```
Промпт: "Обнаружена финансовая ситуация, требующая внимания.
Опиши проблему с конкретными числами. Предложи 1-2 действия."
```

#### Tier 3: Deep Analysis (полный разбор)
**Когда:** Вызван по `/advice`. Полный месячный обзор.
**Формат:** Структурированный отчёт с секциями.
**max_tokens:** 3000 (запас на think-блок + развёрнутый ответ)
**temperature:** 0.5

```
Промпт: "Сделай полный финансовый обзор на основе данных.
Структура:
1. Общая картина (total spend vs budget, budget utilization)
2. Тренды (week/month comparison)
3. Проблемные категории (anomalies, exceeded budgets)
4. Прогноз на конец месяца
5. Рекомендации (max 3, конкретные, с числами)"
```

> **О temperature:** DeepSeek-R1 уже генерирует рассуждения в `<think>` блоке, что само по себе повышает качество. Temperature 0.3 делает ответы слишком шаблонными и однообразными. 0.5-0.6 — оптимальный баланс: числа будут точными (они берутся из данных), а формулировки — живыми. Проблема с числовыми галлюцинациями решается не temperature, а форматированием данных в промпте (см. 4.2).

> **О max_tokens:** DeepSeek-R1 использует существенную часть лимита на think-блок. При max_tokens: 200 можно получить 180 токенов think + 20 токенов ответа = "Да". Закладывать 2-3x от желаемого размера ответа.

### 4.2 Улучшенные промпты

Ключевые принципы:

1. **Числа, не философия.** Промпт явно запрещает абстракции: "Каждое утверждение должно содержать конкретную цифру из данных."

2. **Financial frameworks.** В промпт встраиваются ключевые правила:
   - Burn rate > 100% к текущему дню месяца = перерасход
   - Anomaly > 2x среднего = нужен alert
   - Budget utilization > 90% = concern, > 100% = critical
   - Week-over-week рост > 20% = тренд вверх

3. **Context-aware severity.** Промпт получает pre-computed severity level, чтобы не тратить токены на оценку:

```typescript
const severityContext = computeOverallSeverity(snapshot);
// 'good' | 'watch' | 'concern' | 'critical'

// В промпт:
`УРОВЕНЬ СИТУАЦИИ: ${severityContext}
Если CRITICAL — начни с самой острой проблемы.
Если GOOD — похвали и дай совет по оптимизации.`
```

4. **Anti-repetition.** В промпт передаётся список тем последних 3 советов (из advice_log), с инструкцией "не повторяй эти темы".

### 4.3 Пример полного промпта (Tier 2 — Alert)

```
Ты — финансовый аналитик. Не философ. Не мотиватор. Аналитик.
Каждое утверждение ДОЛЖНО содержать конкретную цифру из данных.

УРОВЕНЬ СИТУАЦИИ: concern

ДАННЫЕ:
=== BURN RATE ===
- Продукты: 450€ потрачено из 600€ бюджета (75%). При текущем темпе 15€/день
  будет потрачено 465€ к концу месяца. Запас: 135€ на 9 оставшихся дней.
- Развлечения: 280€ потрачено из 200€ бюджета (140%). ПРЕВЫШЕН на 80€.

=== АНОМАЛИИ ===
- Категория "Такси": 95€ за текущий месяц vs среднее 40€/мес за 3 месяца.
  Deviation: 2.38x. SIGNIFICANT.

=== ТРЕНДЫ ===
- Неделя: +15% к прошлой неделе (320€ vs 278€)
- Месяц: пока -8% к прошлому месяцу при пропорциональном сравнении

=== ПРОГНОЗ ===
- К концу месяца: ~1340€ (прошлый месяц: 1280€, +4.7%)

=== СКОРОСТЬ ТРАТ ===
- Ускорение: +22% за последние 7 дней vs предыдущие 7 дней

Последние 3 совета были на темы: ["budget overrun", "taxi spending", "weekly trend"]
НЕ повторяй эти темы. Найди новый ракурс.

Опиши 1-2 самые важные финансовые наблюдения. Каждое — с числами.
Предложи 1 конкретное действие. Используй HTML теги.
```

---

## 5. Система частоты и триггеров

### 5.1 Замена рулетки на Smart Triggers

Текущая система: `Math.random() > 0.2` — полная случайность. Заменяем на event-driven подход.

#### Trigger 1: Budget Threshold Crossed

Срабатывает когда бюджет категории пересекает один из порогов: 50%, 75%, 90%, 100%.

```typescript
interface ThresholdTrigger {
  type: 'budget_threshold';
  category: string;
  threshold: 50 | 75 | 90 | 100;
  current_percent: number;
}
```

**Защита от спама:** Хранить `last_triggered_threshold` per category per month. Каждый порог срабатывает только один раз.

#### Trigger 2: Anomaly Detected

Срабатывает при добавлении расхода, если категория уходит в anomaly territory (> 1.5x среднего).

```typescript
interface AnomalyTrigger {
  type: 'anomaly';
  category: string;
  current_total: number;
  average_total: number;
  deviation: number;
}
```

**Защита от спама:** Один alert per category per month.

#### Trigger 3: Velocity Spike

Если spending velocity за последние 3 дня > 2x от среднедневного за месяц.

```typescript
interface VelocityTrigger {
  type: 'velocity_spike';
  recent_daily_avg: number;
  monthly_daily_avg: number;
  ratio: number;
}
```

**Защита от спама:** Максимум 1 раз в 7 дней.

#### Trigger 4: Time-Based Check

Проверка 1 раз в неделю (понедельник) — краткий weekly summary, если были расходы. Не случайный, а привязанный к первому @ask в понедельник.

#### Trigger 5: Milestone

Первый расход дня, N-ный расход месяца (каждые 50 или 100), начало нового месяца.

### 5.2 Cooldown Manager

**Раздельные кулдауны по tier:**
- **Tier 1 (quick):** не чаще 1 раза в 4 часа per group
- **Tier 2 (alert):** кулдаун 1 час (алерты важнее, их не стоит задерживать)
- **Tier 3 (deep):** без кулдауна (всегда ручной вызов через `/advice`)

> Почему раздельные: если поставить один глобальный кулдаун 4 часа, то Tier 1 quick insight может заблокировать показ важного Tier 2 alert (бюджет превышен) на 4 часа. Это хуже, чем вообще не иметь системы.

```typescript
// Хранить в памяти (Map). При рестарте бота кулдауны сбрасываются — это ок.
// НЕ хранить в SQLite — это оперативное состояние, не персистентные данные.
interface AdviceCooldown {
  group_id: number;
  last_quick_at: number;          // timestamp для Tier 1
  last_alert_at: number;          // timestamp для Tier 2
  triggered_thresholds: Map<string, number[]>;  // category -> [50, 75, ...]
  anomaly_alerts: Set<string>;    // categories с алертом в этом месяце
  last_velocity_alert: number;    // timestamp
}
```

> Максимум за день: 3 автоматических совета (1 quick + 2 alert). Если триггеров больше — приоритизация: budget_threshold > anomaly > velocity > time_based > milestone.

### 5.3 Migration: advice_log table

Новая таблица для отслеживания выданных советов:

```sql
CREATE TABLE IF NOT EXISTS advice_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('quick', 'alert', 'deep')),
  trigger_type TEXT NOT NULL,
  trigger_data TEXT,       -- JSON с деталями триггера
  topic TEXT,              -- краткая тема для anti-repetition ("budget_overrun:food", "anomaly:taxi")
  advice_text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- Составной индекс для типичного запроса "последние N советов для группы"
CREATE INDEX IF NOT EXISTS idx_advice_log_group_created ON advice_log(group_id, created_at);
```

---

## 6. Связь с будущим tool_use (AI queries data)

Текущая архитектура: вся аналитика вычисляется в JS, засовывается в промпт текстом, LLM интерпретирует. Это работает, но:

- Промпт раздувается при большом количестве данных
- LLM не может задать уточняющий вопрос к данным
- Добавление новых метрик = изменение кода

### Будущая архитектура: Tool Use

LLM получает набор инструментов для самостоятельного запроса данных:

```typescript
const tools = [
  {
    name: 'get_expenses',
    description: 'Get expenses for a date range, optionally filtered by category',
    parameters: {
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
      category: { type: 'string', optional: true },
    }
  },
  {
    name: 'get_budget_status',
    description: 'Get current budget status for all categories or a specific one',
    parameters: {
      month: { type: 'string', description: 'YYYY-MM' },
      category: { type: 'string', optional: true },
    }
  },
  {
    name: 'get_spending_trend',
    description: 'Compare spending between two periods',
    parameters: {
      period_1_start: { type: 'string' },
      period_1_end: { type: 'string' },
      period_2_start: { type: 'string' },
      period_2_end: { type: 'string' },
    }
  },
  {
    name: 'get_category_stats',
    description: 'Get detailed stats for a category: average, max, min, trend',
    parameters: {
      category: { type: 'string' },
      months_back: { type: 'number', default: 3 },
    }
  },
];
```

**Преимущества:**
- LLM сам решает, какие данные нужны для конкретного вопроса
- Промпт не раздувается — данные подтягиваются по запросу
- Новые аналитические возможности добавляются как новые инструменты

**Как готовиться уже сейчас:**
- `SpendingAnalytics` проектировать так, чтобы каждый метод мог быть обёрнут как tool
- Возвращать структурированные данные, а не текст
- Форматирование в текст — отдельный слой (`formatters.ts`)

**Зависимость:** Hugging Face Inference API должен поддерживать tool_use для выбранной модели. На март 2026 DeepSeek-R1 не поддерживает tool_use. Альтернативы: использовать другую модель для advice (Qwen, Llama с tool support) или реализовать pseudo-tool-use через structured prompting.

---

## 7. Implementation Steps

### Phase 1: Analytics Foundation (~ 2-3 дня)

1. Добавить миграцию `018_add_composite_index_expenses` — составной индекс `(group_id, date)` на expenses
2. Создать `src/services/analytics/types.ts` — все интерфейсы метрик
3. Добавить SQL-запросы в `expense.repository.ts`:
   - `getMonthlyTotals()`
   - `getCategoryTotals()`
   - `getDailyTotals()`
   - `getDayOfWeekStats()`
4. Создать `src/services/analytics/spending-analytics.ts` — главный класс
5. Реализовать compute-методы: `computeBurnRates`, `computeMonthOverMonth`, `computeAnomalies`, `computeProjection`
6. Создать `src/services/analytics/formatters.ts` — текстовое форматирование
7. Написать unit-тесты для compute-методов с фикстурными данными

### Phase 2: Smart Triggers (~ 1-2 дня)

8. Добавить миграцию `019_create_advice_log` для `advice_log` table
9. Создать `src/services/analytics/trigger-manager.ts`:
   - `checkTriggers(groupId): Trigger | null` — проверка триггеров после каждого добавления расхода
   - `selectTier(trigger): 'quick' | 'alert' | 'deep'` — выбор tier на основе триггера
   - `canSendAdvice(groupId, tier): boolean` — проверка кулдауна для конкретного tier
   - `recordAdvice(groupId, tier, trigger, topic, text)` — запись в лог
10. Интегрировать trigger check в `message.handler.ts` (после добавления расхода)

### Phase 3: Improved Prompts (~ 1 день)

11. Переписать `sendDailyAdvice` -> `sendSmartAdvice(ctx, groupId, trigger, tier)`
12. Реализовать три промпта (Tier 1/2/3) с учётом severity
13. Добавить anti-repetition: передавать темы последних 5 советов (из advice_log.topic)
14. Выставить temperature 0.5-0.6 (не ниже — R1 и так консервативен внутри think-блока)

### Phase 4: Integration (~ 1 день)

15. Заменить `maybeSendDailyAdvice` на `maybeSmartAdvice` с trigger-based логикой
16. Обновить `handleAdviceCommand` для Tier 3 (deep analysis)
17. Использовать `SpendingAnalytics` также в `handleAskQuestion` (обогатить контекст @ask)
18. Добавить финансовый снимок в системный промпт @ask

### Phase 5: Polish (~ 1 день)

19. Тестирование с реальными данными
20. Тюнинг порогов (burn rate thresholds, anomaly multipliers)
21. Мониторинг: логировать какие triggers срабатывают, какие советы генерируются
22. Добавить `/advice off` для отключения автоматических советов (column `advice_enabled` в groups, default = 1)

---

## 8. Estimated Impact

| Метрика | Сейчас | После |
|---------|--------|-------|
| Релевантность советов | ~20% (философия) | ~80% (data-driven) |
| Частота | Случайная (0-10/день) | Контролируемая (0-2/день) |
| Actionability | "Экономьте деньги" | "Такси: 95€ vs обычные 40€, сократите до 2 поездок/нед" |
| Повторы | Частые | Исключены (anti-repetition + topic tracking) |
| False positives | N/A | <10% (настраиваемые пороги) |

---

## 9. Risks & Mitigations

1. **Мало исторических данных** — если группа новая, метрики будут пустые. Mitigation: graceful degradation — если < 30 дней данных, показывать только Tier 1 с тем что есть, без трендов/аномалий.

2. **Нагрузка на SQLite** — аналитические запросы на 100k+ записей. Mitigation: добавить составной индекс `(group_id, date)` (сейчас есть только отдельные индексы на `group_id` и `date`). Запросы с агрегацией + составной индекс — быстрые даже на 100k+ строк. Кеширование snapshot на 5 минут в памяти.

3. **LLM галлюцинации с числами** — даже с low temperature, LLM может переврать числа. Mitigation: критические числа (бюджет, остаток) форматировать прямо в промпте как "Потрачено: ТОЧНО 450€ из 600€", а не давать сырые данные для самостоятельных подсчётов.

4. **Annoying советы** — даже умные советы могут раздражать. Mitigation: раздельные кулдауны по tier (quick: 4ч, alert: 1ч), максимум 3 автоматических в день, `/advice off` для opt-out.

5. **Модель для advice** — DeepSeek-R1 тяжеловесен для коротких советов (think tags, долгий ответ). Mitigation: использовать более лёгкую модель для Tier 1 (quick insight), R1 оставить для Tier 3.

6. **Дни без расходов** — линейная экстраполяция в начале месяца (1-3 числа) после нескольких крупных покупок даст абсурдный прогноз. Mitigation: confidence level в projection, не триггерить alerts при confidence: 'low'.

---

## Review Notes

**Дата ревью:** 2026-03-09

### Что исправлено

1. **Инвертированные пороги burn rate (секция 2.1).** Оригинальные пороги содержали логическую ошибку: `on_track` покрывал все значения <= 1.0, но `warning` начинался с 0.85 — получалось, что всё от 0 до 1.0 одновременно `on_track` и `warning`. Исправлено на каскадную проверку сверху вниз (exceeded -> critical -> warning -> on_track), с чётким приоритетом: факт (`exceeded` = spent >= limit) важнее прогноза.

2. **Ложное утверждение о составном индексе (секции 3.2, 9.2).** План утверждал "индексы уже есть на `(group_id, date)`". Это неправда — в `schema.ts` есть отдельные `idx_expenses_group_id` и `idx_expenses_date`, но составного индекса нет. Для WHERE + GROUP BY по обоим полям — это принципиально. Добавлена необходимость создать `idx_expenses_group_date(group_id, date)` как первый шаг Phase 1.

3. **Несоответствие day_of_week между интерфейсом и SQL (секция 2.4).** Интерфейс говорил `0=Mon, 6=Sun`, SQL-комментарий — `0=Sun`. SQLite `strftime('%w')` действительно возвращает 0=Sun. Интерфейс исправлен. Также добавлен комментарий о том, что `avg_daily_spend` нужно считать как `total / unique_days`, а не как `AVG(eur_amount)` (это среднее по транзакции, а не по дню).

4. **Savings Rate переименован в Budget Utilization (секция 2.6).** "Savings rate" — конкретный финансовый термин, означающий долю сбережений от дохода. У нас нет данных о доходе — есть только бюджет и траты. `(budget - spent) / budget` — это budget utilization rate, а не savings rate. Удалена ссылка на правило 50/30/20 (бессмысленно без income).

5. **max_tokens для DeepSeek-R1 (секция 4.1).** DeepSeek-R1 использует значительную часть max_tokens на `<think>` блок. При max_tokens: 200 модель может потратить 180 токенов на размышления и выдать 20 токенов ответа. Tier 1 увеличен с 200 до 500, Tier 2 с 500 до 1000, Tier 3 с 1500 до 3000.

6. **Temperature 0.3 слишком низкая (секция 4.1).** DeepSeek-R1 уже консервативен внутри `<think>` блока — дополнительное снижение temperature до 0.3 делает ответы шаблонными и однообразными. Числовая точность определяется качеством промпта (pre-computed данные), а не temperature. Все tier-ы скорректированы до 0.5-0.6.

7. **Единый кулдаун 4 часа блокирует важные алерты (секция 5.2).** Если quick insight (Tier 1) был показан в 10:00, а в 10:30 пользователь превысил бюджет — алерт (Tier 2) будет заблокирован до 14:00. Исправлено на раздельные кулдауны: quick 4ч, alert 1ч, deep без кулдауна. Добавлена приоритизация триггеров.

8. **SQL-запросы используют date('now') (секции 2.2, 2.4, 2.5).** SQLite `date('now')` возвращает UTC-дату. Если сервер в одном часовом поясе, а пользователь в другом — "последние 7 дней" может захватить не те дни (особенно вокруг полуночи). Все `date('now')` заменены на параметризованную дату из JS.

9. **Добавлена колонка `topic` в advice_log (секция 5.3).** Для anti-repetition нужен машинно-читаемый topic, а не разбор LLM-текста. Формат: `"trigger_type:category"` (например `"anomaly:taxi"`, `"budget_threshold:food:90"`). Также заменены два отдельных индекса на один составной `(group_id, created_at)`.

10. **Добавлен confidence level в Monthly Projection (секция 2.8).** Линейная экстраполяция при days_elapsed < 7 даёт бессмысленные результаты (одна крупная покупка 2-го числа = "вы потратите 15x бюджета за месяц"). Добавлен confidence field и правило: при low confidence не триггерить автоматические советы.

11. **Streak — уточнён алгоритм вычисления (секция 2.7).** Streak нельзя посчитать одним SQL-запросом. Добавлено описание подхода: получить daily totals, вычислить average, сканировать от сегодня назад.

12. **Velocity — деление на фиксированный период (секция 2.5).** Добавлено пояснение: для velocity нужно делить total на 7 (размер окна), а не на active_days. Иначе 1 крупная трата за 1 день покажет тот же daily avg, что 7 мелких за 7 дней.

### Что НЕ изменено (и почему)

- **8 метрик сохранены в полном объёме.** Все 8 вычислимы в SQLite, все дают полезный контекст. DayOfWeekPattern (2.4) — наименее полезная для персонального трекинга (ценна на масштабе 6+ месяцев), но overhead её вычисления минимален (1 запрос), поэтому оставлена.

- **Tier-система 3 уровня сохранена.** Альтернатива (2 уровня: normal/alert) слишком грубая, 4+ уровня — overengineering для Telegram-бота.

- **Tool use как будущая архитектура (секция 6).** Это разумное направление, но явно out of scope для текущей фазы. Раздел оставлен как roadmap.

- **Trigger 5: Milestone.** "N-ный расход месяца" — сомнительной ценности (кого волнует 50-й расход?), но описание достаточно абстрактно, чтобы при реализации отбросить бесполезные варианты и оставить полезные (начало нового месяца).
