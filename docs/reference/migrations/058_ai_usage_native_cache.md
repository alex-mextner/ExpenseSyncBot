# 058: native Claude usage categories

Adds nullable `fresh_input_tokens`, `cache_write_tokens` and `credential_id` columns to `ai_usage_events`. `cached_tokens` continues to mean cache reads. Native `prompt_tokens` is fresh + cache creation + cache reads only when all three counts are reported; otherwise it is NULL. The credential id is a short SHA-256 identifier of the actual selected key, never the key itself.

The migration is additive and leaves existing rows NULL. Historical account/cache-write attribution is unknown. Existing readers remain compatible; rolling application code back does not require dropping the columns. Startup applies the migration through the normal migration registry.
