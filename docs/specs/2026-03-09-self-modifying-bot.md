# Self-Modifying Bot: Architecture & Research Plan

> ExpenseSyncBot, который умеет модифицировать собственный код через Telegram.
> Дата: 2026-03-09

---

## 1. Обзор архитектуры

### 1.1. Что мы строим

Бот получает задачу через Telegram (фича, баг, рефакторинг), проходит полный цикл разработки — от уточнения требований до мержа PR — и отчитывается пользователю на каждом шаге. По сути, это автономный coding agent, встроенный в Telegram-бота, который работает над собственной кодовой базой.

### 1.2. Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│                    TELEGRAM INTERFACE                        │
│  /dev add weekly spending summary command                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   DEV PIPELINE ORCHESTRATOR                  │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Brainstorm│→│  Design  │→│  Implement│→│   Verify    │ │
│  │  & Clarify│  │  & Plan  │  │  & Code  │  │  & Test    │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘ │
│                                     │              │        │
│                                     ▼              ▼        │
│                               ┌──────────┐  ┌────────────┐ │
│                               │ Create PR │→│   Merge     │ │
│                               │ (GitHub) │  │  & Deploy  │ │
│                               └──────────┘  └────────────┘ │
└─────────────────────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │  Codex   │ │   Git    │ │   File   │
    │  SDK     │ │ Worktree │ │  Tools   │
    │ (review) │ │ (isolat.)│ │ (sandbox)│
    └──────────┘ └──────────┘ └──────────┘
```

### 1.3. Принципы

1. **Бот никогда не модифицирует свой работающий код напрямую.** Все изменения — на отдельной ветке.
2. **Каждая операция обратима.** Git — наш safety net.
3. **Пользователь — финальный gate-keeper.** Без явного approval ни один PR не мержится.
4. **Деплой отделён от разработки.** Бот создаёт PR, существующий CI/CD (GitHub Actions) деплоит.
5. **Fail-safe by default.** Если что-то идёт не так — бот останавливается и спрашивает.

---

## 2. State Machine: Dev Pipeline

### 2.1. Упрощённая модель (10 состояний)

Исходный дизайн содержал 16 состояний, но несколько из них (`idle`, `commit`, `create_pr`) не представляют реального ожидания или принятия решений — это мгновенные переходы. `idle` — это отсутствие задачи, а не состояние задачи. `design_review` и `code_review` можно объединить с предшествующими шагами (review — часть реализации/дизайна, а не отдельное ожидание). Упрощённая модель:

```
                    ┌─────────────┐
                    │ BRAINSTORM  │ ◄── уточняющие вопросы, пользователь отправил задачу
                    └──────┬──────┘
                           │ пользователь подтвердил scope
                           ▼
                    ┌─────────────┐
                    │   DESIGN    │ ◄── анализ кода, план, включая Codex review плана
                    └──────┬──────┘
                           │ план + review готовы
                           ▼
                    ┌──────────────┐
               ┌──▶│   APPROVAL   │ ◄── пользователь подтверждает план
               │   └──────┬───────┘
               │          │ approved
               │          ▼
               │   ┌─────────────┐
               │   │  IMPLEMENT  │ ◄── написание кода + Codex review кода
               │   └──────┬──────┘
               │          │ код написан и review пройден
               │          ▼
               │   ┌─────────────┐
               │   │   TESTING   │ ◄── bun test + tsc --noEmit
               │   └──────┬──────┘
               │          │
               │    ┌─────┴─────┐
               │    │           │
               │  pass        fail
               │    │           │
               │    ▼           ▼
               │ ┌────────┐ ┌──────────┐
               │ │PULL_REQ│ │ FIX_LOOP │──┐
               │ └───┬────┘ └──────────┘  │ (max 3 попытки)
               │     │           ▲        │
               │     │           └────────┘
               │     ▼
               │ ┌──────────────┐
               │ │APPROVAL_MERGE│ ◄── commit + push + PR created, ждём approval
               │ └──────┬───────┘
               │        │
               │  ┌─────┴─────┐
               │  │           │
               │ merge     reject
               │  │           │
               │  ▼           ▼
               │ ┌──────────┐ ┌──────────┐
               │ │ COMPLETED│ │ REJECTED │
               │ └──────────┘ └────┬─────┘
               │                   │
               └───────────────────┘  (можно вернуться к планированию)

         Из любого состояния:
         ──▶ CANCELLED (пользователь отменил)
         ──▶ FAILED (неустранимая ошибка)
```

Принципы упрощения:
- **Нет `idle`** — это отсутствие записи в БД, не состояние задачи.
- **`design` включает review плана** — review это подшаг, а не отдельное ожидание.
- **`implement` включает code review** — review это подшаг.
- **`commit` и `create_pr` объединены в `pull_request`** — мгновенные операции, нет смысла разделять.
- **`merged` заменён на `completed`** — используется и в restart recovery.

### 2.2. Модель данных для pipeline state

```typescript
interface DevTask {
  id: string;                           // UUID
  group_id: number;                     // Telegram group
  requested_by: number;                 // Telegram user ID
  state: DevTaskState;                  // текущее состояние
  branch_name: string;                  // git branch
  worktree_path: string | null;         // путь к git worktree (создаётся при IMPLEMENT)

  // Содержание задачи
  original_request: string;             // исходное сообщение
  clarifications: ClarificationEntry[]; // Q&A с пользователем
  design_plan: string | null;           // план реализации
  design_review: string | null;         // результат review плана

  // Реализация
  files_changed: FileChange[];          // какие файлы изменены
  code_review: string | null;           // результат review кода
  test_results: TestResult | null;      // результаты тестов
  fix_attempts: number;                 // сколько раз пытались пофиксить

  // Git/GitHub
  commit_hash: string | null;
  pr_number: number | null;
  pr_url: string | null;

  // Telegram UI
  progress_message_id: number | null;   // ID сообщения с прогрессом
  thread_id: number | null;             // topic thread ID

  // Мета
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
}

type DevTaskState =
  | 'brainstorm'
  | 'design'
  | 'approval'
  | 'implement'
  | 'testing'
  | 'fix_loop'
  | 'pull_request'
  | 'approval_merge'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed';

interface ClarificationEntry {
  question: string;
  answer: string;
  timestamp: string;
}

interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  diff: string;
}

interface TestResult {
  passed: boolean;
  output: string;
  type_check_passed: boolean;
  type_check_output: string;
}
```

### 2.3. Таблица переходов

| Из состояния | В состояние | Триггер | Approval нужен? |
|---|---|---|---|
| (нет задачи) | BRAINSTORM | Пользователь отправил `/dev` | Нет |
| BRAINSTORM | DESIGN | Пользователь подтвердил scope | Да (implicit) |
| DESIGN | APPROVAL | План + review готовы | Нет |
| APPROVAL | IMPLEMENT | Пользователь одобрил план | **Да** |
| IMPLEMENT | TESTING | Код написан, code review пройден | Нет |
| TESTING | PULL_REQUEST | Тесты и тайпчекер прошли | Нет |
| TESTING | FIX_LOOP | Тесты или тайпчекер упали | Нет |
| FIX_LOOP | TESTING | Попытка исправления (max 3) | Нет |
| FIX_LOOP | FAILED | 3 попытки не удались | Нет |
| PULL_REQUEST | APPROVAL_MERGE | Commit + push + PR создан | Нет |
| APPROVAL_MERGE | COMPLETED | Пользователь одобрил merge | **Да** |
| APPROVAL_MERGE | REJECTED | Пользователь отклонил | **Да** |
| REJECTED | DESIGN | Пользователь хочет переделать | Да |
| * | CANCELLED | /dev cancel | Да |

---

## 3. Каталог инструментов (Tool Catalog)

### 3.1. File Operations

Бот не использует Codex для написания кода — он делает это сам через файловые операции. Причина: полный контроль, детерминизм, zero-cost.

```typescript
interface FileTools {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  editFile(path: string, oldStr: string, newStr: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  globFiles(pattern: string): Promise<string[]>;
  grepContent(pattern: string, path?: string): Promise<GrepResult[]>;
}
```

Реализация: `Bun.file()` для чтения/записи, `Bun.$` для grep/glob, `node:fs` для операций с директориями.

### 3.2. Git Operations

Библиотека: **simple-git** (npm: `simple-git`) или `Bun.$` shell commands.

Рекомендация: `Bun.$` — уже есть в Bun, не нужна зависимость, полная гибкость.

```typescript
interface GitTools {
  // Worktree (основной механизм изоляции)
  createWorktree(taskId: string, branchName: string): Promise<string>;  // returns worktree path
  removeWorktree(taskId: string): Promise<void>;
  getWorktreePath(taskId: string): string;

  // Изменения (все операции в worktree, не в основной директории)
  status(worktreePath: string): Promise<GitStatus>;
  diff(worktreePath: string, options?: DiffOptions): Promise<string>;
  add(worktreePath: string, files: string[]): Promise<void>;
  commit(worktreePath: string, message: string): Promise<string>;  // returns hash
  push(worktreePath: string, branch: string): Promise<void>;

  // История
  log(count?: number): Promise<GitLogEntry[]>;

  // Безопасность
  reset(worktreePath: string, mode: 'soft' | 'hard', ref?: string): Promise<void>;
}
```

**Важно:** Все git-операции (кроме log) принимают `worktreePath` и выполняются в worktree директории. Основная директория проекта (где работает бот) НИКОГДА не модифицируется. `git checkout` на main — запрещён.

### 3.3. GitHub Operations

Инструмент: **`gh` CLI** — уже есть на сервере, авторизация через `GITHUB_TOKEN`.

```typescript
interface GitHubTools {
  createPR(options: {
    title: string;
    body: string;
    base: string;      // всегда 'main'
    head: string;      // feature branch
    draft?: boolean;
  }): Promise<{ number: number; url: string }>;

  mergePR(number: number, method?: 'merge' | 'squash' | 'rebase'): Promise<void>;
  closePR(number: number): Promise<void>;

  addPRComment(number: number, body: string): Promise<void>;
  requestReview(number: number, reviewers: string[]): Promise<void>;

  getPRStatus(number: number): Promise<PRStatus>;
  listPRChecks(number: number): Promise<Check[]>;
}
```

Реализация: `Bun.$\`gh pr create ...\``.

### 3.4. Codex Integration

**Важное ограничение:** Slash-команды (например `/review`) **НЕ работают** в `codex exec` (non-interactive mode). Это подтверждённое ограничение (GitHub issue #3641). Вместо slash-команд в exec mode нужно передавать обычные промпты.

Два варианта использования Codex:

#### Вариант A: Codex CLI (`codex exec`)

Лёгкий, без дополнительных зависимостей. Работает в non-interactive mode.

```typescript
interface CodexCLITools {
  // Запуск review через prompt (НЕ slash-команды)
  reviewPlan(planText: string): Promise<ReviewResult>;
  reviewDiff(diff: string): Promise<ReviewResult>;

  // Произвольная задача
  exec(prompt: string, options?: {
    sandbox?: 'read-only' | 'workspace-write';
    json?: boolean;
    fullAuto?: boolean;
    model?: string;
  }): Promise<CodexResult>;
}
```

Реализация:

```typescript
async function codexReviewDiff(): Promise<ReviewResult> {
  // Получаем diff самостоятельно и передаём как контекст в промпт
  const diff = await Bun.$`cd ${PROJECT_ROOT} && git diff`.text();

  const result = await Bun.$`codex exec \
    --sandbox read-only \
    --json \
    --model gpt-5.3-codex \
    "Review the following code changes. \
     Focus on correctness, security, and maintainability. \
     Provide findings in structured JSON format with verdict: APPROVE or NEEDS_CHANGES.\n\n${diff}"`.text();

  return parseCodexOutput(result);
}
```

**Примечание:** `codex exec` выводит JSONL (JSON Lines) stream в stdout при флаге `--json`. Event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`. Нужен парсер JSONL, а не обычного JSON.

#### Вариант B: Codex SDK (`@openai/codex-sdk`)

Полный программный контроль, streaming, structured output через JSON schema.

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();

// Review с structured output
const result = await thread.run(
  "Review the uncommitted changes for security and correctness issues",
  {
    outputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["APPROVE", "NEEDS_CHANGES"] },
        findings: { type: "array", items: { type: "string" } },
      },
      required: ["verdict", "findings"],
    },
  }
);
```

**Важно:** Codex SDK требует Node.js 18+. Совместимость с Bun нужно проверить.

**Рекомендация:** Начать с Вариант B (Codex SDK) — structured output через JSON schema, программный контроль, лучший парсинг результатов. Вариант A (codex exec) хорош для CI/CD, но для runtime-вызовов из бота SDK удобнее.

### 3.5. Testing & Linting

```typescript
interface TestTools {
  runTests(): Promise<TestResult>;
  runTypeCheck(): Promise<TypeCheckResult>;
  runAll(): Promise<{ tests: TestResult; typeCheck: TypeCheckResult }>;
}
```

Реализация:

```typescript
async function runTests(): Promise<TestResult> {
  try {
    const output = await Bun.$`cd ${PROJECT_ROOT} && bun test 2>&1`.text();
    return { passed: true, output };
  } catch (error: any) {
    return { passed: false, output: error.stdout?.toString() || error.message };
  }
}

async function runTypeCheck(): Promise<TypeCheckResult> {
  try {
    const output = await Bun.$`cd ${PROJECT_ROOT} && bunx tsc --noEmit 2>&1`.text();
    return { passed: true, output };
  } catch (error: any) {
    return { passed: false, output: error.stdout?.toString() || error.message };
  }
}
```

### 3.6. Context & Analysis Tools

> **ВАЖНО:** MCP-серверы (Context7, Serena) — это инструменты development-time IDE (Claude Code, HyperIDE). Они **не доступны** runtime Telegram-боту напрямую. Бот запускается через `bun run start`, а не внутри IDE с MCP-серверами.

#### Вариант A: Реализовать аналоги самостоятельно

Вместо MCP-серверов бот использует собственные инструменты:

```typescript
// Аналог Serena — через grep/find на файловой системе
interface CodeAnalysisTools {
  findSymbolUsages(symbolName: string): Promise<GrepResult[]>;  // Bun.$ grep -rn
  getFileStructure(filePath: string): Promise<string>;           // простой парсер AST или regex
  searchForPattern(pattern: string): Promise<GrepResult[]>;      // Bun.$ grep
}

// Аналог Context7 — через Codex или web fetch
// Codex уже имеет знания о библиотеках, отдельный doc lookup не нужен
```

#### Вариант B: Запустить MCP-серверы как subprocess

Теоретически можно поднять MCP-серверы (context7, serena) как дочерние процессы бота и общаться по stdio. Но это значительно усложняет архитектуру и добавляет точки отказа.

**Рекомендация:** Вариант A. Для code analysis хватит grep + file read. Для документации — передавать контекст в промпт Codex (он уже знает библиотеки).

#### Web Search / Fetch

```typescript
interface WebTools {
  search(query: string): Promise<SearchResult[]>;
  fetchPage(url: string, prompt: string): Promise<string>;
}
```

Юзкейс: бот ищет best practices для реализации конкретной фичи.

**Реализация:** `fetch()` для веб-запросов, парсинг HTML через cheerio или простой regex. Web search — через API (SerpAPI, Google Custom Search) или через Codex (у него есть web search).

---

## 4. Модель безопасности

### 4.1. Проблема: бот меняет свой собственный код

Это создаёт три класса рисков:

| Риск | Последствие | Митигация |
|------|-------------|-----------|
| Бот ломает себя | Бот перестаёт работать | PM2 autorestart, отдельная ветка, деплой только через PR |
| Бесконтрольные изменения | Произвольный код в продакшене | Approval gates, Codex review, тесты |
| Credential leak | Токены в коммитах | `.gitignore` проверка, pre-commit hook, Codex security review |
| Infinite loop | Бот пишет код, который заставляет писать код | Max iterations, timeout, state machine boundaries |
| Concurrent modifications | Два изменения конфликтуют | Очередь задач, один active task |

### 4.2. Isolation: git worktree (НЕ checkout)

**Критическая проблема исходного дизайна:** `git checkout` переключает ВСЮ рабочую директорию на другую ветку. Но бот **работает** из этой директории. `git checkout dev/...` означает, что работающий бот внезапно окажется на коде feature-ветки, а не main. Это ломает всё.

**Решение: `git worktree`** — создаёт отдельную рабочую директорию для ветки, не трогая основную.

```
/var/www/ExpenseSyncBot/           ← main (продакшен, здесь работает бот)
/var/www/ExpenseSyncBot-worktrees/
  └── bot-task-{uuid}/             ← отдельная директория для feature branch
```

Workflow:
1. `git worktree add ../ExpenseSyncBot-worktrees/bot-task-{uuid} -b dev/bot-task-{uuid}` от main
2. Все файловые операции в worktree директории
3. `cd worktree && git add && git commit && git push -u origin dev/bot-task-{uuid}`
4. `gh pr create`
5. PR merge через GitHub (triggers CI/CD)
6. PM2 reload на сервере (автоматически через GitHub Actions)
7. `git worktree remove ../ExpenseSyncBot-worktrees/bot-task-{uuid}` — cleanup

**Важно:** Все файловые операции (readFile, writeFile, editFile) должны работать относительно worktree, а не основной директории. Тесты (`bun test`) тоже запускаются в worktree.

### 4.3. Approval Gates

**Обязательные точки, где нужно одобрение пользователя:**

1. **План реализации** — перед тем как писать код
2. **Merge PR** — перед тем как изменения попадут в main

**Опциональные (настраиваемые):**

3. Code review результат (бот может автоматически решать по score)
4. Каждый отдельный файл (paranoid mode)

### 4.4. Ограничения

```typescript
const SAFETY_LIMITS = {
  MAX_FIX_ATTEMPTS: 3,           // макс попыток пофиксить тесты
  MAX_FILES_CHANGED: 20,         // макс файлов в одном PR
  MAX_LINES_CHANGED: 500,        // макс строк (добавленных + удалённых)
  TASK_TIMEOUT_MINUTES: 30,      // таймаут на весь pipeline
  STEP_TIMEOUT_MINUTES: 10,      // таймаут на один шаг
  MAX_CONCURRENT_TASKS: 1,       // только одна задача одновременно

  // Файлы, которые НЕЛЬЗЯ менять (self-referential protection)
  PROTECTED_FILES: [
    '.env',
    '.env.example',
    'ecosystem.config.cjs',
    '.github/',
    'data/',
    'src/config/env.ts',
    'src/services/dev-pipeline/',  // бот не может менять свой pipeline
    'src/database/schema.ts',     // миграции — только вручную
  ],

  // Паттерны, которых НЕ ДОЛЖНО быть в коммитах
  FORBIDDEN_PATTERNS: [
    /process\.env\.\w+\s*=/, // присвоение env vars
    /sk-[a-zA-Z0-9]{20,}/,  // API keys
    /-----BEGIN.*KEY-----/,   // private keys
    /password\s*[:=]\s*['"]/i, // hardcoded passwords
  ],
};
```

### 4.5. Sandbox для файловых операций

Бот может читать/писать ТОЛЬКО внутри worktree директории, в следующих путях:
- `src/` — основной код (разрешено)
- `*.test.ts` — тестовые файлы (разрешено)
- `CLAUDE.md`, `README.md` — документация (разрешено с approval)

Запрещено (даже в worktree):
- `index.ts` (entry point) — менять только с approval
- `src/config/env.ts` — запрещено
- `.env*` — запрещено
- `node_modules/` — запрещено
- `data/` — запрещено
- `.github/` — запрещено
- `ecosystem.config.cjs` — запрещено
- `src/services/dev-pipeline/` — **запрещено** (self-referential protection, см. раздел 16)

**Важно:** Пути должны быть относительными, не привязанными к конкретной машине. Sandbox проверяет пути относительно корня worktree.

---

## 5. Интеграция с Codex

### 5.1. Установка и настройка

```bash
# На сервере
bun add -g @openai/codex   # CLI (глобально)
bun add @openai/codex-sdk  # SDK (в проект)

# Env vars
OPENAI_API_KEY=sk-...       # или CODEX_API_KEY для codex exec
CODEX_MODEL=gpt-5.3-codex   # актуальная модель для review (март 2026)
# Альтернатива: gpt-5.4 (released 2026-03-05) — первая general-purpose модель
# с native coding capabilities от 5.3-codex, но дороже
```

### 5.2. Review потоки

#### Review плана реализации

```typescript
async function reviewDesignPlan(plan: string): Promise<ReviewResult> {
  const prompt = `You are reviewing a design plan for modifying an ExpenseSyncBot.
The bot is a Telegram expense tracker built with Bun, GramIO, SQLite.

PLAN:
${plan}

Review this plan for:
1. Feasibility - can this be implemented as described?
2. Risks - what could go wrong?
3. Missing considerations - what's not covered?
4. Architecture fit - does it align with existing patterns?

Provide structured review with verdict: APPROVE or NEEDS_CHANGES.`;

  const result = await Bun.$`codex exec \
    --sandbox read-only \
    --json \
    --model ${CODEX_MODEL} \
    ${prompt}`.text();

  return parseReviewResult(result);
}
```

#### Review uncommitted changes

**ВНИМАНИЕ:** `/review` — это slash-команда, она НЕ работает в `codex exec`. Используем обычный промпт с diff:

```typescript
async function reviewCode(): Promise<ReviewResult> {
  // Передаём diff как часть промпта, а не используем slash-команду
  const diff = await Bun.$`cd ${PROJECT_ROOT} && git diff`.text();

  const result = await Bun.$`codex exec \
    --sandbox read-only \
    --json \
    --model ${CODEX_MODEL} \
    "Review these code changes for correctness, security and maintainability:\n\n${diff}"`.text();

  return parseReviewResult(result);
}
```

Или через SDK (рекомендуется):

```typescript
async function reviewCodeWithSDK(): Promise<ReviewResult> {
  const diff = await Bun.$`cd ${PROJECT_ROOT} && git diff`.text();
  const codex = new Codex();
  const thread = codex.startThread();

  const result = await thread.run(
    `Review these code changes for correctness, security and maintainability:\n\n${diff}`,
    { outputSchema: reviewResultSchema }
  );

  return result;
}
```

### 5.3. Модель для review vs модель для генерации

| Задача | Модель | Причина |
|--------|--------|---------|
| Code review | `gpt-5.3-codex` | Лучшая точность для agentic coding (февраль 2026) |
| Design review | `gpt-5.3-codex` | Нужно понимание архитектуры |
| AI brainstorm | `deepseek-ai/DeepSeek-R1-0528` | Уже используется в боте, дешевле |
| Code generation | Бот сам (tool_use) | Полный контроль |

**Примечание:** `gpt-5.4` (released 2026-03-05) доступен, но дороже. Использовать для сложных задач, где 5.3-codex не справляется.

### 5.4. Стоимость

Codex через ChatGPT Plus/Pro — включён в подписку. Для CI/CD — нужен `OPENAI_API_KEY`. Стоимость review одного PR — порядка $0.10-0.50 в зависимости от объёма.

---

## 6. Интеграция с GitHub

### 6.1. Аутентификация

На сервере используется `gh` CLI. Аутентификация:

```bash
# Уже настроено через GitHub Actions, но для бота:
gh auth login --with-token < /path/to/token

# Или через env var
GITHUB_TOKEN=ghp_...
```

### 6.2. PR Workflow

```typescript
async function createPullRequest(task: DevTask): Promise<{ number: number; url: string }> {
  const title = generatePRTitle(task);  // max 70 chars
  const body = generatePRBody(task);    // summary, changes, test results

  // Push branch first
  await Bun.$`cd ${PROJECT_ROOT} && git push -u origin ${task.branch_name}`;

  // Create PR
  const result = await Bun.$`cd ${PROJECT_ROOT} && gh pr create \
    --base main \
    --head ${task.branch_name} \
    --title ${title} \
    --body ${body}`.text();

  // Parse PR URL from output
  const prUrl = result.trim();
  const prNumber = parseInt(prUrl.split('/').pop() || '0');

  return { number: prNumber, url: prUrl };
}
```

### 6.3. Merge flow

```typescript
async function mergePullRequest(prNumber: number): Promise<void> {
  // Check that CI passed
  const checks = await Bun.$`gh pr checks ${prNumber} --json state`.json();

  if (checks.some((c: any) => c.state === 'FAILURE')) {
    throw new Error('CI checks failed, cannot merge');
  }

  // Squash merge
  await Bun.$`cd ${PROJECT_ROOT} && gh pr merge ${prNumber} \
    --squash \
    --delete-branch`;
}
```

### 6.4. Существующий CI/CD

Текущий `.github/workflows/deploy.yml`:
- Триггер: push to main
- Действие: rsync to Digital Ocean + bun install + PM2 reload

Это значит: после merge PR бот автоматически задеплоится. Перезагрузка через PM2 reload — zero-downtime.

---

## 7. Обработка рестартов

### 7.1. Проблема

Бот меняет свой код → PR мержится → CI деплоит → PM2 reload → **бот перезапускается с новым кодом**. Во время restart теряется in-memory state.

### 7.2. Решение: персистентный state

Все данные pipeline хранятся в SQLite. При старте бот проверяет незавершённые задачи:

```typescript
// При старте бота
async function resumeDevTasks(): Promise<void> {
  const activeTasks = database.devTasks.findActive();

  for (const task of activeTasks) {
    if (task.state === 'completed') {
      // Задача, которая привела к рестарту — отчитаться об успехе
      await notifyUser(task, 'Деплой завершён! Бот перезапущен с новым кодом.');
      // Cleanup worktree
      await cleanupWorktree(task);
    } else if (task.state === 'approval_merge') {
      // Ждали approval — продолжить ждать
      await notifyUser(task, 'Бот перезапущен. PR всё ещё ждёт одобрения.');
    } else if (['implement', 'testing', 'fix_loop', 'pull_request'].includes(task.state)) {
      // Задача была в процессе — проверить что worktree на месте
      const worktreeExists = await checkWorktreeExists(task);
      if (worktreeExists) {
        await notifyUser(task, `Бот перезапущен. Задача "${task.original_request}" в состоянии ${task.state}. Продолжить?`);
      } else {
        // Worktree потерян — нельзя продолжить
        database.devTasks.updateState(task.id, 'failed');
        await notifyUser(task, `Worktree потерян после рестарта. Задача отмечена как failed.`);
      }
    } else {
      // brainstorm, design, approval — не требуют worktree
      await notifyUser(task, `Бот перезапущен. Задача "${task.original_request}" в состоянии ${task.state}. Продолжить?`);
    }
  }
}
```

**Важно:** Благодаря `git worktree` рестарт безопасен — бот всегда работает на main, а feature branch изолирован в отдельной директории. Worktree переживает рестарт бота (это обычная директория на диске).

### 7.3. Timing

```
Merge PR → GitHub Actions (~30s) → rsync + bun install (~20s) → PM2 reload (~2s)
Итого: ~1 минута от merge до работающего нового кода
```

Бот может отправить сообщение "Деплой начался, вернусь через ~1 минуту" перед тем, как merge.

### 7.4. Graceful shutdown

Текущий `index.ts` уже обрабатывает SIGTERM:

```typescript
process.on('SIGTERM', () => {
  database.close();
  process.exit(0);
});
```

Нужно добавить: сохранение текущего состояния pipeline перед shutdown.

---

## 8. Telegram UI для отчётности

### 8.1. Progress Message

Один "живой" сообщение, которое обновляется по мере продвижения:

```
Dev Task: "Add JPY currency support"

Progress:
[done] Brainstorm -- scope confirmed
[done] Design -- plan ready (3 files, ~50 lines), Codex approved
[done] Approval -- user approved plan
[done] Implementation -- 3 files changed, code review passed
[....] Testing -- running...
[    ] Pull Request
[    ] Merge

Elapsed: 2m 35s
```

### 8.2. Inline Keyboards

```typescript
// Approval для плана
const planApprovalKeyboard = {
  inline_keyboard: [
    [
      { text: '✅ Одобрить', callback_data: `dev_approve_plan:${taskId}` },
      { text: '❌ Отклонить', callback_data: `dev_reject_plan:${taskId}` },
    ],
    [
      { text: '💬 Обсудить', callback_data: `dev_discuss:${taskId}` },
    ],
  ],
};

// Approval для merge
const mergeApprovalKeyboard = {
  inline_keyboard: [
    [
      { text: '✅ Merge', callback_data: `dev_merge:${taskId}` },
      { text: '❌ Reject', callback_data: `dev_reject:${taskId}` },
    ],
    [
      { text: '👀 View PR', url: prUrl },
      { text: '📝 View Diff', callback_data: `dev_diff:${taskId}` },
    ],
  ],
};
```

### 8.3. Команды

```
/dev <description>     — начать новую dev task
/dev status            — статус текущей задачи
/dev cancel            — отменить текущую задачу
/dev history           — история завершённых задач
/dev config            — настройки (auto-approve level, etc.)
```

### 8.4. Уведомления

Бот отправляет уведомления при:
- Нужен input от пользователя (вопрос, approval)
- Шаг завершён
- Ошибка
- Task завершена (успех/неудача)

---

## 9. Интеграция с существующим AI (ask.ts)

### 9.1. Текущая архитектура AI

Сейчас бот использует `@huggingface/inference` с DeepSeek-R1 для ответов на вопросы о расходах. Модель получает контекст (расходы, бюджеты) и отвечает.

### 9.2. Как интегрировать dev pipeline

Два подхода:

#### Подход A: Отдельная команда `/dev`

Dev pipeline живёт отдельно от ask. Пользователь явно запускает `/dev` и взаимодействует с pipeline. AI для brainstorm использует отдельный prompt с контекстом кодовой базы.

**Плюсы:** Чистое разделение, не ломает существующий функционал.
**Минусы:** Пользователь должен знать про `/dev`.

#### Подход B: Через @mention

Бот распознаёт intent "хочу изменить код" и предлагает запустить dev pipeline.

```typescript
// В handleAskQuestion
if (isDevRequest(question)) {
  await ctx.send(
    'Похоже, ты хочешь изменить код бота. Запустить dev pipeline?',
    { reply_markup: startDevKeyboard }
  );
  return;
}
```

**Рекомендация:** Начать с Подход A (явный `/dev`), потом добавить распознавание через @mention.

### 9.3. AI модели для разных этапов

| Этап | Модель | Провайдер | Причина |
|------|--------|-----------|---------|
| Brainstorm | DeepSeek-R1 | HuggingFace/Novita | Дешёвый, хороший в рассуждениях |
| Design | DeepSeek-R1 | HuggingFace/Novita | Нужно глубокое планирование |
| Code generation | Bot's own tool_use | — | Прямые файловые операции |
| Code review | gpt-5.3-codex | OpenAI Codex SDK | Лучшая точность для review, structured output |
| Fix loop | DeepSeek-R1 | HuggingFace/Novita | Анализ ошибок тестов |

---

## 10. Concurrent Modifications

### 10.1. Проблема

Пользователь отправляет вторую задачу, пока первая ещё в процессе.

### 10.2. Решение: очередь

```typescript
const MAX_CONCURRENT_TASKS = 1;

async function handleDevCommand(ctx: Ctx, description: string): Promise<void> {
  const activeTasks = database.devTasks.findActiveByGroup(groupId);

  if (activeTasks.length >= MAX_CONCURRENT_TASKS) {
    const task = activeTasks[0]!;
    await ctx.send(
      `⚠️ Уже есть активная задача: "${task.original_request}"\n` +
      `Статус: ${task.state}\n\n` +
      `Используй /dev cancel чтобы отменить её, или дождись завершения.`
    );
    return;
  }

  // Создать новую задачу
  const task = database.devTasks.create({
    group_id: groupId,
    requested_by: userId,
    original_request: description,
    state: 'brainstorm',
    branch_name: `dev/bot-task-${crypto.randomUUID().slice(0, 8)}`,
  });

  await startBrainstorm(ctx, task);
}
```

В будущем можно добавить очередь, но для начала — один task за раз.

---

## 11. Error Recovery

### 11.1. Стратегии восстановления

| Ошибка | Стратегия |
|--------|-----------|
| Тесты не прошли | Fix loop (до 3 раз) |
| Тайпчекер ругается | Fix loop (до 3 раз) |
| Codex review rejected | Вернуться к implement |
| Git конфликт | Rebase от main, если не получилось — сообщить пользователю |
| GitHub API error | Retry с exponential backoff (3 попытки) |
| Codex API error | Retry с backoff, fallback на DeepSeek для review |
| Бот крашится | PM2 autorestart, resume из SQLite state |
| Файл protected | Сообщить пользователю, спросить разрешение |
| Timeout | Сохранить state, предложить продолжить |

### 11.2. Rollback

```typescript
async function rollbackTask(task: DevTask): Promise<void> {
  const worktreePath = getWorktreePath(task);

  // 1. Удалить worktree (force — даже если есть uncommitted changes)
  await Bun.$`cd ${PROJECT_ROOT} && git worktree remove ${worktreePath} --force`.nothrow();

  // 2. Удалить ветку локально
  await Bun.$`cd ${PROJECT_ROOT} && git branch -D ${task.branch_name}`.nothrow();

  // 3. Закрыть PR и удалить remote branch
  if (task.pr_number) {
    await Bun.$`gh pr close ${task.pr_number} --delete-branch`.nothrow();
  } else {
    await Bun.$`cd ${PROJECT_ROOT} && git push origin --delete ${task.branch_name}`.nothrow();
  }

  // 4. Обновить state
  database.devTasks.updateState(task.id, 'cancelled');
}
```

---

## 12. Анализ рисков

### 12.1. Технические риски

| Риск | Вероятность | Импакт | Митигация |
|------|------------|--------|-----------|
| Бот генерирует код, который ломает бота | Высокая | Критический | Тесты, review, отдельная ветка, CI/CD, PM2 autorestart |
| Codex API недоступен | Средняя | Средний | Fallback на DeepSeek для review, или пропустить review |
| GitHub API rate limit | Низкая | Низкий | Retry, cache |
| Git merge конфликты | Средняя | Средний | Rebase, уведомление пользователя |
| Бот застревает в fix loop | Средняя | Средний | Max 3 попытки, timeout |
| Пользователь забывает одобрить | Высокая | Низкий | Reminders через 1h, 24h, auto-cancel через 7d |

### 12.2. Безопасность

| Риск | Вероятность | Импакт | Митигация |
|------|------------|--------|-----------|
| Credential leak в коммите | Низкая | Критический | Pre-commit scan, protected files list, Codex security review |
| Бот добавляет backdoor | Очень низкая | Критический | Code review, user approval, protected files |
| Prompt injection через task description | Средняя | Средний | Input sanitization, sandbox boundaries |
| API keys в логах | Средняя | Высокий | Structured logging, secret masking |

### 12.3. Операционные риски

| Риск | Вероятность | Импакт | Митигация |
|------|------------|--------|-----------|
| Disk space (git history) | Низкая | Низкий | Cleanup old branches |
| Memory (AI context) | Средняя | Средний | Limit context size, chunk processing |
| Cost overrun (API calls) | Средняя | Средний | Budget limits, cheaper models where possible |
| Deployment downtime | Низкая | Средний | PM2 reload (zero-downtime), health checks |

---

## 13. Фазы реализации

### Phase 0: Infrastructure (1-2 дня)

**Цель:** Подготовить фундамент.

- [ ] Установить `@openai/codex` (глобально или локально)
- [ ] Настроить `OPENAI_API_KEY` в `.env`
- [ ] Настроить `GITHUB_TOKEN` в `.env`
- [ ] Проверить `gh` CLI аутентификацию на сервере
- [ ] Создать миграцию `018_create_dev_tasks_table` в `schema.ts`
- [ ] Создать `src/database/repositories/dev-task.repository.ts`
- [ ] Создать `src/services/dev-pipeline/` директорию

### Phase 1: Git & GitHub Tools (1-2 дня)

**Цель:** Базовые git и GitHub операции.

- [ ] `src/services/dev-pipeline/git.tools.ts` — обёртки над git через `Bun.$`
- [ ] `src/services/dev-pipeline/github.tools.ts` — обёртки над `gh` CLI
- [ ] `src/services/dev-pipeline/file.tools.ts` — безопасные файловые операции
- [ ] Тесты для git tools
- [ ] Тесты для file tools (sandbox enforcement)

### Phase 2: State Machine & Orchestrator (2-3 дня)

**Цель:** Pipeline orchestrator с state machine.

- [ ] `src/services/dev-pipeline/state-machine.ts` — переходы состояний
- [ ] `src/services/dev-pipeline/orchestrator.ts` — основной координатор
- [ ] `src/services/dev-pipeline/safety.ts` — проверки безопасности
- [ ] Telegram UI: progress message, inline keyboards
- [ ] `/dev` command handler в `src/bot/commands/dev.ts`
- [ ] Callback handlers для approval buttons

### Phase 3: AI Integration — Brainstorm & Design (2-3 дня)

**Цель:** Бот может обсуждать задачу и создавать план.

- [ ] `src/services/dev-pipeline/brainstorm.ts` — AI для уточнения задачи
- [ ] `src/services/dev-pipeline/design.ts` — AI для создания плана
- [ ] Интеграция с Serena (code analysis) для понимания кодовой базы
- [ ] Интеграция с Context7 (docs lookup) для проверки API
- [ ] Conversation state management (вопросы-ответы)

### Phase 4: Code Generation (3-5 дней)

**Цель:** Бот пишет код.

- [ ] `src/services/dev-pipeline/implement.ts` — генерация кода через AI + tool_use
- [ ] File operation tools (создание, редактирование, удаление файлов)
- [ ] Контекст: план + существующий код + документация
- [ ] Итеративная генерация (один файл за раз)
- [ ] Валидация: синтаксис, импорты, типы

### Phase 5: Review & Testing (2-3 дня)

**Цель:** Codex review и автоматические тесты.

- [ ] `src/services/dev-pipeline/review.ts` — Codex integration
- [ ] `src/services/dev-pipeline/testing.ts` — запуск тестов и тайпчекера
- [ ] Fix loop logic (анализ ошибок, попытки исправления)
- [ ] Structured review output parsing

### Phase 6: PR & Merge (1-2 дня)

**Цель:** Создание и управление PR.

- [ ] Auto-generate PR title и description
- [ ] Создание PR через `gh`
- [ ] Merge flow с approval
- [ ] Post-merge cleanup (удаление ветки, обновление state)

### Phase 7: Restart Recovery (1-2 дня)

**Цель:** Бот переживает рестарты.

- [ ] Resume logic при старте бота
- [ ] Graceful shutdown: сохранение state
- [ ] Post-deploy notification
- [ ] Stale task cleanup (auto-cancel через 7 дней)

### Phase 8: Polish & Safety (2-3 дня)

**Цель:** Hardening.

- [ ] Pre-commit security scan
- [ ] Rate limiting (max tasks per day)
- [ ] Comprehensive error handling
- [ ] Telegram notification improvements
- [ ] Documentation update
- [ ] Integration tests

---

## 14. Зависимости и env vars

### 14.1. Новые зависимости

```bash
# Уже есть в проекте: gramio, date-fns, @huggingface/inference
# Нужно добавить:
bun add @openai/codex-sdk     # если SDK подход
# или
bun add -g @openai/codex      # если CLI подход (глобально)
```

**Важно:** `simple-git` НЕ нужен — используем `Bun.$` для git операций. Одна зависимость меньше.

### 14.2. Новые env vars

```bash
# В .env
OPENAI_API_KEY=sk-...         # для Codex SDK / codex exec
GITHUB_TOKEN=ghp_...          # для gh CLI / GitHub API
CODEX_MODEL=gpt-5.3-codex     # модель для review (актуальная на март 2026)
DEV_PIPELINE_ENABLED=true     # включить/выключить pipeline
DEV_ADMIN_USER_IDS=123,456    # кто может запускать dev tasks
DEV_WORKTREE_BASE=../ExpenseSyncBot-worktrees  # базовая директория для worktrees
```

### 14.3. Системные зависимости (на сервере)

```bash
# Уже есть: git, bun, pm2
# Нужно добавить:
npm i -g @openai/codex    # Codex CLI
gh auth login             # GitHub CLI auth
```

---

## 15. Файловая структура

```
src/
├── services/
│   └── dev-pipeline/
│       ├── index.ts              # экспорт всего модуля
│       ├── orchestrator.ts       # главный координатор pipeline
│       ├── state-machine.ts      # state transitions
│       ├── types.ts              # все типы для pipeline
│       ├── safety.ts             # security checks, limits
│       ├── tools/
│       │   ├── git.tools.ts      # git операции
│       │   ├── github.tools.ts   # GitHub API (gh CLI)
│       │   ├── file.tools.ts     # файловые операции (sandboxed)
│       │   ├── codex.tools.ts    # Codex SDK (review, structured output)
│       │   ├── test.tools.ts     # bun test, tsc
│       │   ├── worktree.tools.ts # git worktree management
│       │   └── analysis.tools.ts # grep, file structure analysis (замена MCP)
│       ├── stages/
│       │   ├── brainstorm.ts     # уточнение задачи
│       │   ├── design.ts         # планирование
│       │   ├── implement.ts      # написание кода
│       │   ├── review.ts         # code review
│       │   ├── testing.ts        # тестирование
│       │   └── deploy.ts         # commit, PR, merge
│       └── ui/
│           ├── progress.ts       # progress message
│           ├── keyboards.ts      # inline keyboards
│           └── notifications.ts  # уведомления
├── bot/
│   └── commands/
│       └── dev.ts                # /dev command handler
├── database/
│   └── repositories/
│       └── dev-task.repository.ts
```

---

## 16. Открытые вопросы

1. **Где запускать Codex?** Codex CLI (`codex exec`) требует sandbox (macOS Seatbelt / Linux landlock). На Digital Ocean VPS это может не работать — landlock требует ядро 5.13+. **Рекомендация:** Использовать Codex SDK (`@openai/codex-sdk`) — это HTTP API-вызовы, sandbox не нужен. CLI оставить как fallback для локальной разработки.

2. **Какой AI для code generation?** Tool_use через DeepSeek может быть ненадёжным для файловых операций. Альтернатива: Codex SDK для генерации кода (не только review).

3. **Тесты.** В проекте сейчас минимальные тесты (`parser.test.ts`). Бот не сможет надёжно проверить свой код. Нужно сначала покрыть базовый функционал тестами. **Это блокер для Phase 5.**

4. **Self-referential changes.** Бот НЕ ДОЛЖЕН менять свой pipeline код (`src/services/dev-pipeline/`). Это добавлено в PROTECTED_FILES. Изменения pipeline — только вручную.

5. **Multi-repo.** Сейчас это один репозиторий. Если появятся другие проекты, нужна ли абстракция?

6. **Cost.** Codex через API — платный. При активном использовании (10 tasks/day) стоимость может быть $5-50/day. Нужен budget monitor.

7. **Codex SDK + Bun совместимость.** `@openai/codex-sdk` требует Node.js 18+. Нужно проверить, что SDK работает под Bun. Если нет — использовать `codex exec` или OpenAI API напрямую.

8. **Worktree cleanup.** Что если worktree не удалился (диск, permissions)? Нужен periodic cleanup cron или startup check.

---

## Источники

- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Codex SDK](https://developers.openai.com/codex/sdk/)
- [Build Code Review with Codex SDK](https://developers.openai.com/cookbook/examples/codex/build_code_review_with_codex_sdk/)
- [Codex GitHub Action](https://github.com/openai/codex-action)
- [OpenAI Codex GitHub](https://github.com/openai/codex)
- [codex-js-sdk (community)](https://dev.to/kachurun/openai-codex-as-a-native-agent-in-your-typescript-nodejs-app-kii)
- [simple-git npm](https://www.npmjs.com/package/simple-git)
- [gh pr create manual](https://cli.github.com/manual/gh_pr_create)
- [Agentic Design Patterns](https://www.sitepoint.com/the-definitive-guide-to-agentic-design-patterns-in-2026/)
- [Autonomous Coding Agents](https://www.sitepoint.com/autonomous-coding-agents-guide-2026/)
- [AI-Driven Self-Evolving Software](https://cogentinfo.com/resources/ai-driven-self-evolving-software-the-rise-of-autonomous-codebases-by-2026)
- [Google Cloud Agentic AI Patterns](https://docs.google.com/architecture/choose-design-pattern-agentic-ai-system)
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive/)
- [Codex Slash Commands Limitation in exec mode (Issue #3641)](https://github.com/openai/codex/issues/3641)
- [Codex SDK npm (@openai/codex-sdk)](https://www.npmjs.com/package/@openai/codex-sdk)

---

## Review Notes

**Дата review: 2026-03-09**

### Что было исправлено и почему

#### 1. State machine: 16 -> 12 состояний
- Убран `idle` — это отсутствие записи в БД, а не состояние задачи.
- `design_review` объединён с `design` — review это подшаг дизайна, не требует отдельного ожидания.
- `code_review` объединён с `implement` — аналогично.
- `commit` и `create_pr` объединены в `pull_request` — это мгновенные операции без пользовательского ввода.
- `merged` переименован в `completed` — это финальное состояние, а не промежуточное.
- `approval_plan` переименован в `approval` — короче и понятнее.
- **Обоснование:** Каждое состояние должно представлять точку, где pipeline ждёт чего-то (пользовательский ввод, результат операции, внешний вызов). Мгновенные переходы — это не состояния.

#### 2. Codex CLI: slash-команды не работают в exec mode
- `/review uncommitted` заменён на обычный промпт с diff в контексте.
- Добавлена информация о том, что `--json` выводит JSONL stream, не обычный JSON.
- Рекомендация изменена с "начать с CLI" на "начать с SDK" — SDK даёт structured output, лучше подходит для runtime-вызовов из бота.
- **Источник:** [GitHub issue #3641](https://github.com/openai/codex/issues/3641), [Non-interactive mode docs](https://developers.openai.com/codex/noninteractive/).

#### 3. Модель обновлена: gpt-5.2-codex -> gpt-5.3-codex
- gpt-5.3-codex вышла 2026-02-05, значительно улучшена для agentic coding.
- gpt-5.4 вышла 2026-03-05, но дороже. Добавлена как альтернатива.
- Все упоминания gpt-5.2-codex заменены на gpt-5.3-codex.

#### 4. КРИТИЧНО: git checkout -> git worktree
- Исходный план использовал `git checkout -b` для создания feature branch. Это катастрофически неправильно: checkout переключает ВСЮ рабочую директорию, а бот работает из этой же директории.
- Заменено на `git worktree` — создаёт отдельную рабочую директорию, бот продолжает работать на main.
- Обновлены: git tools interface, rollback, restart recovery, isolation section.
- Добавлена env var `DEV_WORKTREE_BASE` для настройки пути worktrees.

#### 5. MCP tools (Context7, Serena) недоступны в runtime
- MCP-серверы работают только в IDE (Claude Code, HyperIDE). Runtime Telegram-бот не имеет к ним доступа.
- Заменено на самостоятельные инструменты: grep/find для code analysis, Codex SDK для документации.
- Обновлена файловая структура: `context.tools.ts` -> `analysis.tools.ts` + `worktree.tools.ts`.

#### 6. Security: self-referential protection
- `src/services/dev-pipeline/` добавлен в PROTECTED_FILES — бот не должен менять свой собственный pipeline code.
- `src/database/schema.ts` добавлен в PROTECTED_FILES — миграции должны добавляться только вручную.
- `.github/` целиком запрещён (не только deploy.yml).
- Sandbox пути сделаны относительными (убрана привязка к `/Users/ultra/...`).

#### 7. Restart recovery улучшен
- Добавлена проверка существования worktree при рестарте.
- Разделена логика для состояний, требующих worktree, и не требующих.
- Worktree переживает рестарт бота (это обычная директория на диске), что упрощает recovery.

#### 8. Новые открытые вопросы
- Совместимость Codex SDK с Bun runtime.
- Codex CLI sandbox на Linux (landlock kernel requirements).
- Worktree cleanup при сбоях.
