// Tests for /help command — ensures text stays within Telegram limits

import { describe, expect, it } from 'bun:test';
import { buildHelpText } from './help';

describe('/help message', () => {
  it('fits within Telegram 4096 char limit', () => {
    const text = buildHelpText();
    expect(text.length).toBeLessThan(4096);
  });

  it('contains key sections', () => {
    const text = buildHelpText();

    expect(text).toContain('Запись расходов');
    expect(text).toContain('Фото чеков');
    expect(text).toContain('AI-ассистент');
    expect(text).toContain('Google-таблица');
    expect(text).toContain('/spreadsheet');
    expect(text).toContain('telegra.ph/ExpenseSyncBot');
  });

  it('does not mention Menu button', () => {
    const text = buildHelpText();
    expect(text).not.toContain('Menu');
  });
});
