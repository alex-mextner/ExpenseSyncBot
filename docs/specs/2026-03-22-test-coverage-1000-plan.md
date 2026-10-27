# Test Coverage 1000 / TDD Error Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring test count from 302 to ~1052 and overall coverage to ~80% by writing TDD tests for all untested modules and adding typed error handling for external services (Anthropic API, network, OAuth).

**Architecture:** 6 parallel independent agents each own isolated file sets. Agent 1 creates `src/errors/` first (unblocks Agent 4). Agent 2 creates `src/test-utils/db.ts` (unblocks Agent 3). All other work is fully independent. TDD flow for new code: failing test → minimal implementation → green. For existing code without tests: write spec-style tests describing expected behaviour.

**Tech Stack:** Bun test (jest-compatible), TypeScript, `bun:sqlite` in-memory SQLite, Anthropic SDK (`@anthropic-ai/sdk`), Playwright (mocked in tests), `bun:test` mock() API.

**Spec:** `docs/specs/2026-03-22-test-coverage-1000-design.md`

---

## Parts

1. [01-agent1-pure-services.md](2026-03-22-test-coverage-1000-plan/01-agent1-pure-services.md) — File map, Agent 1: pure services + error architecture (original lines 15-564)
2. [02-agents2-3-repositories.md](2026-03-22-test-coverage-1000-plan/02-agents2-3-repositories.md) — Agents 2-3: core and small repositories (original lines 565-979)
3. [03-agents4-5-receipt-ai.md](2026-03-22-test-coverage-1000-plan/03-agents4-5-receipt-ai.md) — Agents 4-5: receipt pipeline, AI layer + bot error formatter (original lines 980-1583)
4. [04-agent6-final-verification.md](2026-03-22-test-coverage-1000-plan/04-agent6-final-verification.md) — Agent 6, final verification, test count summary (original lines 1584-1851)
