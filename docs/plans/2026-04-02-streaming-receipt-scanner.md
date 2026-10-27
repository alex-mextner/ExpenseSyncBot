# Streaming Receipt Scanner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synchronous receipt scan/OCR endpoints with async processing + SSE streaming, so the miniapp shows items progressively and survives phone sleep. Also fix font rendering and improve the confirm UI with category comboboxes.

**Architecture:** Server accepts scan request → returns scanId immediately (202) → processes in background → streams events (url, item, done, error) via SSE. Client opens EventSource, renders items as they arrive. Polling fallback on SSE failure. Session recovery via sessionStorage + scanId.

**Tech Stack:** Bun.serve (existing), `@huggingface/inference` chatCompletionStream, native EventSource (client), ReadableStream SSE (server), `crypto.randomUUID()` for IDs.

**Spec:** `docs/specs/2026-04-02-streaming-receipt-scanner.md`

---

## Parts

1. [01-parser-shortener-store.md](2026-04-02-streaming-receipt-scanner/01-parser-shortener-store.md) — File structure, Tasks 1-3: stream parser, URL shortener, scan store (original lines 15-783)
2. [02-extractor-server-api.md](2026-04-02-streaming-receipt-scanner/02-extractor-server-api.md) — Tasks 4-5: streaming AI extractor, server endpoints (original lines 784-1477)
3. [03-client-and-scanner-ui.md](2026-04-02-streaming-receipt-scanner/03-client-and-scanner-ui.md) — Tasks 6-7: client API, Scanner.tsx streaming UI (original lines 1478-2358)
4. [04-verification-summary.md](2026-04-02-streaming-receipt-scanner/04-verification-summary.md) — Task 8 and summary (original lines 2359-2400)
