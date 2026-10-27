# Part 1: Sections 1-3: architecture, state machine, tool catalog

[← Back to index](../2026-03-09-self-modifying-bot.md)

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

