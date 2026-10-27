# Massive Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all ~70 findings from the [massive review audit](../specs/2026-03-23-massive-review.md) — security, data integrity, performance, error handling, UX, DevOps, architecture, code quality.

**Architecture:** Five sequential phases ordered by severity. Each phase is independently deployable. Security fixes first, then data safety, quick wins, performance, architecture cleanup.

**Tech Stack:** Bun, SQLite (bun:sqlite), GramIO, googleapis, pino, Biome

**Decisions from review discussion:**
- PERF-4 (`silentSyncBudgets` in per-expense path): **keep as-is** — reliability over speed
- PERF-7 (AI validation): use `glm-4.7-flash` as lightweight model to filter greetings, keep retry logic for real questions
- UX-4 (`/sync`): add pre-sync snapshot in DB + `/sync rollback` command
- OPS-3: UptimeRobot (external pinger on `/health` endpoint) + PM2 webhook on crash
- OPS-1 (backups): **already implemented** — daily cron at 03:00, `scripts/backup-db.sh`, WAL-safe VACUUM INTO + gzip, 30-day retention. Off-server copy is a follow-up (DO Spaces or scp).
- Playwright stays in `dependencies` (used in production for receipt fetching)
- `readExpensesFromSheet` A:Z — MEDIUM, optimize column range
- WAL checkpoint — LOW, default autocheckpoint is sufficient
- AppError typed error hierarchy — already exists in `src/errors/`, needs wiring into all handlers

---

## Parts

1. [Phase 1 (security) and Phase 2 (data safety)](2026-03-25-massive-review-fixes/01-phases-1-2.md)
2. [Phase 3 (quick wins) and Phase 4 (performance)](2026-03-25-massive-review-fixes/02-phases-3-4.md)
3. [Phase 5 (architecture), deferred items, final verification](2026-03-25-massive-review-fixes/03-phase-5-and-final.md)
