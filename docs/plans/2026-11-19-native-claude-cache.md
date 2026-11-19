# Native Claude caching and attempt accounting (#203)

## Evidence and decision

At the 2026-11-19 00:45 UTC cutoff, the production SQLite ledger recorded 95 Sonnet calls over seven days (1,389,551 compatibility prompt tokens and 32,632 output tokens). All 95 cache counts were unknown. The SDK used `/v1/chat/completions`; Anthropic does not support prompt caching on that compatibility endpoint. Historical credential attribution and native fresh/write/read splits cannot be reconstructed.

Use native `/v1/messages` through the existing SDK's public transport, preserving credential failover, provider order, visible-answer budgets, receipt images and Haiku's supported disabled-thinking mode. The default transport is `native`; `AI_CLAUDE_TRANSPORT=openai` is the rollback. No credentials or global routing are changed.

The stable tools and static rules/tool index precede dynamic date, user and group instructions. Use the default five-minute cache lifetime only on stable system/tools and on incremental history of explicitly marked agent prompts (never automatic caching of unique one-shot receipt/OCR inputs): 79 of 94 observed Sonnet interarrival gaps were at most five minutes. This is an opportunity measure, not a measured hit rate, since historical prefix/account identity is absent. Smaller validator prompts may not reach the model's minimum cache size.

## Native conversation contract

Preserve native assistant blocks in order, including empty signed thinking and opaque redacted blocks, privately for the current run. Replay the exact original system/tool prefix, append tool results, and append newly discovered schemas using inline tool additions. Reject an incompatible prefix/schema mutation before sending the request. Corrective validation retries and development-agent rounds retain the exact completed assistant object. Opaque blocks are excluded from logs, persisted messages and other-provider serialization; native SDK logging is disabled.

Native input_tokens is fresh input, excluding cache reads and writes. Store all three categories and total prompt input separately. Output usage is cumulative; terminal counts replace initial counts. Preserve observed input on a failed stream and identify the actual selected credential using a non-secret SHA-256 prefix. Usage observers belong to the request, not a possibly shared abort Error. A partial failed output count is a lower bound. Unknown remains NULL; a reported zero remains zero. Preflight validation failures are operation attempts, not evidence of billed provider requests.

## Implementation and validation

- [x] Add native request/SSE adaptation behind the existing shared stream entrypoint, covering chat, fast, OCR, receipt and history callers.
- [x] Preserve images, signed tool-loop content, schema discovery, caller aborts and credential attribution.
- [x] Add migration 058, its additive schema snapshot, and per-credential JSON aggregates with historical unknown coverage.
- [x] Route the documented chain/vision probes through the runtime adapter; offline synthetic coverage verifies the native endpoint.
- [x] Exercise real SDK named SSE parsing, the actual prompt builder, migrations/repository and failure accounting using one focused offline test file.
- [ ] Complete configured independent review iterations and real CI; no workstation whole-suite/coverage/typecheck runs.
- [ ] Ship through the repository workflow and verify at most two small requests through the deployed adapter, without executing tools or sending messages.

## Sources

- [Native prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI compatibility limitations](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [Thinking support by model](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Preserved thinking and tool changes](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/change-tools-or-instructions)
