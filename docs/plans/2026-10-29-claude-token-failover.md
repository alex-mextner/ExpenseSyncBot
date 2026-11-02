# Claude credential failover

The requested behavior is to reuse the second configured Claude API token when the first credential is unavailable, while retaining the same model, request parameters and provider fallback.

1. Add failing integration coverage through the real OpenAI SDK and stream-opening path for primary rejection, secondary-only setup and z.ai isolation. Cover smart, fast, OCR and role availability with the secondary alone.
2. Reuse the bounded Claude credential pool shared with HyperCalendarBot. Keep retry at stream creation, count actual HTTP attempts, share credential cooldown across model chains, honor Retry-After and abort signals, and split the existing remaining provider budget between eligible credentials. Never retry a returned stream or rerun financial tools.
3. Wire optional `CLAUDE_API_TOKEN2` into configuration and Claude client registration. Preserve `ANTHROPIC_API_KEY` exclusively for z.ai and existing model/thinking settings.
4. Run focused tests, then the isolated full suite, typecheck, lint and knip on the owner server. Review the exact diff and address findings before the normal pull-request and stage gates.
5. Coordinate deployment and synthetic no-write live accuracy/speed checks with the parent and production-operations owner. Keep secrets and private prompts out of logs and evidence.
