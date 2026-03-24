// Tests for /help command — ensures text stays within Telegram limits

import { describe, expect, it } from 'bun:test';

describe('/help message', () => {
  it('handler is exported and callable', async () => {
    const mod = await import('./help');
    expect(mod.handleHelpCommand).toBeDefined();
  });

  it('text fits within 4096 characters', async () => {
    const source = await Bun.file(new URL('./help.ts', import.meta.url).pathname).text();

    // Extract the template literal content between backticks in buildHelpText
    const match = source.match(/return `([^`]+)`/s);
    expect(match).not.toBeNull();
    if (!match?.[1]) throw new Error('Could not extract help text');

    // Replace ${bot} with a realistic username
    const text = match[1].replace(/\$\{bot\}/g, 'expensesyncbot');
    expect(text.length).toBeLessThan(4096);
  });

  it('contains key sections', async () => {
    const source = await Bun.file(new URL('./help.ts', import.meta.url).pathname).text();

    expect(source).toContain('Запись расходов');
    expect(source).toContain('Фото чеков');
    expect(source).toContain('AI-ассистент');
    expect(source).toContain('Работа с таблицей');
    expect(source).toContain('Ручные правки');
    expect(source).toContain('/sync');
    expect(source).toContain('/push');
    expect(source).toContain('/budget sync');
    expect(source).toContain('EUR (calc)');
  });
});
