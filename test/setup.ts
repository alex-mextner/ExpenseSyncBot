// Test preload — sets required env vars so tests don't depend on .env
process.env['BOT_TOKEN'] ??= 'test-bot-token';
process.env['GOOGLE_CLIENT_ID'] ??= 'test-client-id';
process.env['GOOGLE_CLIENT_SECRET'] ??= 'test-client-secret';
process.env['GOOGLE_REDIRECT_URI'] ??= 'http://localhost:3000/callback';
process.env['ENCRYPTION_KEY'] ??= 'a'.repeat(64);
