# Monthly Budget Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat "Budget" sheet with per-month tabs (Jan–Dec), one Google Spreadsheet per calendar year, auto-cloned on the 1st of each month via cron.

**Architecture:** New `group_spreadsheets` table (group_id, year → spreadsheet_id) replaces `groups.spreadsheet_id`. `GroupRepository` LEFT JOINs on current year for backward compatibility. Budget sync reads/writes the current month's tab instead of the flat sheet. A one-time startup migration moves the old "Budget" flat sheet to monthly tabs. `node-cron` creates new month tabs at 00:00 on the 1st.

**Tech Stack:** Bun, bun:sqlite, googleapis, node-cron, date-fns

---

## Parts

1. [01-file-map-migration.md](2026-03-27-sheets-monthly-budget-tabs/01-file-map-migration.md) — File map, Task 1: migration 021 + GroupSpreadsheetRepository (original lines 13-316)
2. [02-repositories-month-abbr.md](2026-03-27-sheets-monthly-budget-tabs/02-repositories-month-abbr.md) — Tasks 2-4: GroupRepository, BudgetRepository, MonthAbbr (original lines 317-778)
3. [03-sheets-tabs-budget-sync.md](2026-03-27-sheets-monthly-budget-tabs/03-sheets-tabs-budget-sync.md) — Tasks 5-6: month tab functions, syncBudgetsDiff (original lines 779-1345)
4. [04-handlers-migration.md](2026-03-27-sheets-monthly-budget-tabs/04-handlers-migration.md) — Tasks 7-8: budget handlers, one-time migration (original lines 1346-1962)
5. [05-cleanup-wiring-checklist.md](2026-03-27-sheets-monthly-budget-tabs/05-cleanup-wiring-checklist.md) — Tasks 9-11 and verification checklist (original lines 1963-2375)
