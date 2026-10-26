# Part 2: Sections 4-11: security, Codex, GitHub, restarts, Telegram UI, ask.ts, concurrency, error recovery

[← Back to index](../2026-03-09-self-modifying-bot.md)

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

