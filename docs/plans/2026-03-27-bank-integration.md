# Bank Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate ZenPlugins bank adapters into ExpenseSyncBot via a separate bank-sync microservice that polls bank APIs on a 30-min schedule, stores raw transactions, and sends AI-prefilled confirmation cards to groups via direct Telegram API calls.

**Architecture:** Two-process model — main bot handles all Telegram updates and user interactions; bank-sync service (separate PM2 process) owns the sync loop and sends confirmation cards via direct `fetch` calls to Telegram API. Both share the same SQLite DB in WAL mode. No IPC needed.

**Tech Stack:** Bun runtime, bun:sqlite, ZenPlugins (git submodule), node:crypto (AES-256-GCM), @anthropic-ai/sdk, node-cron, direct Telegram Bot API HTTP calls (bank-sync send-only)

---

## Parts

1. [01-file-map-env-migrations.md](2026-03-27-bank-integration/01-file-map-env-migrations.md) — File map, Tasks 1-2: env/crypto, DB migrations (original lines 13-620)
2. [02-repositories-core.md](2026-03-27-bank-integration/02-repositories-core.md) — Tasks 3-6: connections, credentials, accounts, transactions repositories (original lines 621-1422)
3. [03-rules-registry-plugins.md](2026-03-27-bank-integration/03-rules-registry-plugins.md) — Tasks 7-9: merchant rules, DatabaseService registration, ZenPlugin submodule (original lines 1423-2051)
4. [04-runtime-sync.md](2026-03-27-bank-integration/04-runtime-sync.md) — Tasks 10-14: ZenPlugin shim, Telegram sender, AI pre-fill, sync, merchant normalization (original lines 2052-2752)
5. [05-ai-tools-confirmation.md](2026-03-27-bank-integration/05-ai-tools-confirmation.md) — Tasks 15-16: AI bank tools, confirmation/edit flows (original lines 2753-3155)
6. [06-bank-command.md](2026-03-27-bank-integration/06-bank-command.md) — Task 17: /bank command (original lines 3156-3655)
7. [07-entrypoint-analytics-review.md](2026-03-27-bank-integration/07-entrypoint-analytics-review.md) — Tasks 18-19 and self-review (original lines 3656-3840)
