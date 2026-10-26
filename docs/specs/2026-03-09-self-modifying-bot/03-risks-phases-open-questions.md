# Part 3: Sections 12-16, sources, review notes

[← Back to index](../2026-03-09-self-modifying-bot.md)

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
