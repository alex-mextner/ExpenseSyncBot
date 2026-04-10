// Test preload — sets placeholder env vars so src/config/env.ts validation
// passes in CI where the real .env is absent. All AI calls are mocked in tests,
// so these values are never hit over the wire.
process.env['BOT_TOKEN'] ??= 'test-bot-token';
process.env['GOOGLE_CLIENT_ID'] ??= 'test-client-id';
process.env['GOOGLE_CLIENT_SECRET'] ??= 'test-client-secret';
process.env['GOOGLE_REDIRECT_URI'] ??= 'http://localhost:3000/callback';
process.env['ENCRYPTION_KEY'] ??= 'a'.repeat(64);

// AI providers — all 12 required vars. Tests mock aiStreamRound, so these
// placeholder values never hit a real provider.
process.env['ANTHROPIC_API_KEY'] ??= 'test-zai-key';
process.env['AI_BASE_URL'] ??= 'https://api.z.ai/api/coding/paas/v4';
process.env['AI_MODEL'] ??= 'glm-5.1';
process.env['AI_FAST_MODEL'] ??= 'glm-4.5-flash';

process.env['HF_TOKEN'] ??= 'test-hf-token';
process.env['HF_BASE_URL'] ??= 'https://router.huggingface.co/v1';
process.env['HF_MODEL'] ??= 'Qwen/Qwen3-235B-A22B';
process.env['HF_FAST_MODEL'] ??= 'meta-llama/Llama-3.3-70B-Instruct';
process.env['HF_VISION_MODEL'] ??= 'Qwen/Qwen2.5-VL-72B-Instruct';

process.env['GEMINI_API_KEY'] ??= 'test-gemini-key';
process.env['GEMINI_BASE_URL'] ??= 'https://generativelanguage.googleapis.com/v1beta/openai/';
process.env['GEMINI_MODEL'] ??= 'gemini-2.5-pro';
process.env['GEMINI_FAST_MODEL'] ??= 'gemini-2.5-flash';
process.env['GEMINI_VISION_MODEL'] ??= 'gemini-2.5-flash';
