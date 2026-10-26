# Batch Tool Parameters & Pre-calculated Statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add array support to tool parameters and pre-calculated statistics (avg, median, min, max) to eliminate redundant tool calls and manual arithmetic.

**Architecture:** Extract stats computation into a pure module. Normalize all array-capable params with a shared utility. Each tool handler loops over normalized arrays and appends stats/diff/trend blocks. Schema descriptions updated for array types.

**Tech Stack:** Bun, TypeScript, bun:test

**Spec:** `docs/specs/2026-04-02-batch-tools-stats.md`

---

## Parts

1. [File Structure; Tasks 1-2: stats module and formatting](2026-04-02-batch-tools-stats/01-stats-and-formatting.md)
2. [Tasks 3-4: period resolution, get_expenses batch + stats](2026-04-02-batch-tools-stats/02-period-and-expenses.md)
3. [Tasks 5-11: get_budgets, bank transactions, missing expenses, schemas, prompt, labels, final checks](2026-04-02-batch-tools-stats/03-budgets-bank-schemas-final.md)
