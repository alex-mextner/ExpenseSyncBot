// Tests for table-message.ts — markdown table → Bot API 10.1 rich message, <pre> fallback and send path.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { InputRichMessage } from '../../bot/telegram-rich-message';
import { createMockLogger } from '../../test-utils/mocks/logger';
import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../../utils/html';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({ createLogger: () => logMock, logger: logMock }));

const sendRichMessage = mock(
  (_richMessage: InputRichMessage): Promise<{ message_id: number } | null> =>
    Promise.resolve({ message_id: 1 }),
);
const sendMessage = mock((_text: string) => Promise.resolve({ message_id: 2 }));
mock.module('../bank/telegram-sender', () => ({ sendRichMessage, sendMessage }));

// Imported after the mocks: static imports are hoisted and would bind the real logger.
const { buildPreTableMessages, buildRichTableMessage, sendTableMessage } = await import(
  './table-message'
);

const TABLE = [
  '| Категория | Сумма | Доля |',
  '|:--|--:|:-:|',
  '| **Еда** | 5 000 RSD | 50% |',
  '| _Транспорт_ <b>x</b> | `1 200` RSD | ~~10%~~ |',
  '| [Сайт](https://example.com) | 0 | [x](javascript:alert) |',
].join('\n');

function wideTable(columns: number): string {
  const cells = Array.from({ length: columns }, (_, i) => `c${i}`);
  return [
    `| ${cells.join(' | ')} |`,
    `|${cells.map(() => '---').join('|')}|`,
    `| ${cells.join(' | ')} |`,
  ].join('\n');
}

function tallTable(rows: number, cell = 'v'): string {
  return [
    '| a | b |',
    '|---|---|',
    ...Array.from({ length: rows }, () => `| ${cell} | ${cell} |`),
  ].join('\n');
}

beforeEach(() => {
  sendRichMessage.mockClear();
  sendRichMessage.mockImplementation(() => Promise.resolve({ message_id: 1 }));
  sendMessage.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('buildRichTableMessage', () => {
  it('builds a heading, a native table and the caption', () => {
    const message = buildRichTableMessage({ title: 'Расходы', markdown: TABLE, caption: 'март' });
    expect(message?.blocks[0]).toEqual({ type: 'heading', text: 'Расходы', size: 3 });
    expect(message?.blocks[2]).toEqual({
      type: 'paragraph',
      text: { type: 'italic', text: 'март' },
    });

    const table = message?.blocks[1];
    if (table?.type !== 'table') throw new Error('expected a table block');
    expect(table.is_bordered).toBe(true);
    expect(table.cells).toHaveLength(4);
    expect(table.cells[0]).toEqual([
      { text: 'Категория', is_header: true, align: 'left', valign: 'middle' },
      { text: 'Сумма', is_header: true, align: 'right', valign: 'middle' },
      { text: 'Доля', is_header: true, align: 'center', valign: 'middle' },
    ]);
  });

  it('turns inline markdown into rich text and drops raw HTML and non-web links', () => {
    const table = buildRichTableMessage({ title: 'T', markdown: TABLE })?.blocks[1];
    if (table?.type !== 'table') throw new Error('expected a table block');
    const [food, transport, site] = [table.cells[1], table.cells[2], table.cells[3]];
    expect(food?.[0]?.text).toEqual({ type: 'bold', text: 'Еда' });
    expect(food?.[0]?.is_header).toBeUndefined();
    expect(transport?.[0]?.text).toEqual([{ type: 'italic', text: 'Транспорт' }, ' ', '', 'x', '']);
    expect(transport?.[1]?.text).toEqual([{ type: 'code', text: '1 200' }, ' RSD']);
    expect(transport?.[2]?.text).toEqual({ type: 'strikethrough', text: '10%' });
    expect(site?.[0]?.text).toEqual({ type: 'url', text: 'Сайт', url: 'https://example.com' });
    expect(site?.[2]?.text).toBe('x');
  });

  it('keeps text around the table as paragraphs', () => {
    const message = buildRichTableMessage({ title: 'T', markdown: `Итоги:\n\n${TABLE}\n\nВсё.` });
    expect(message?.blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'table',
      'paragraph',
    ]);
  });

  it('accepts 20 columns and refuses 21 (rich-message table limit)', () => {
    expect(buildRichTableMessage({ title: 'T', markdown: wideTable(20) })).not.toBeNull();
    expect(buildRichTableMessage({ title: 'T', markdown: wideTable(21) })).toBeNull();
  });

  it('counts table rows against the 500-block limit', () => {
    // heading + table block + header row + 497 rows = 500
    expect(buildRichTableMessage({ title: 'T', markdown: tallTable(497) })).not.toBeNull();
    expect(buildRichTableMessage({ title: 'T', markdown: tallTable(498) })).toBeNull();
  });

  it('refuses more than 32768 characters of text', () => {
    // title (1) + header cells (2) + 200 rows × 2 cells × n: n = 81 → 32403, n = 82 → 32803
    const rows = (n: number) => tallTable(200, 'x'.repeat(n));
    expect(buildRichTableMessage({ title: 'T', markdown: rows(81) })).not.toBeNull();
    expect(buildRichTableMessage({ title: 'T', markdown: rows(82) })).toBeNull();
  });

  it('counts the visible text of paragraphs, not their markdown markers', () => {
    // title (1) + a bold paragraph of n characters; `**` markers are not shown, so not counted
    const bold = (n: number) => `**${'x'.repeat(n)}**`;
    expect(buildRichTableMessage({ title: 'T', markdown: bold(32767) })).not.toBeNull();
    expect(buildRichTableMessage({ title: 'T', markdown: bold(32768) })).toBeNull();
  });
});

describe('buildPreTableMessages', () => {
  it('renders title, an aligned monospace table and the caption', () => {
    const [message, ...rest] = buildPreTableMessages({
      title: 'Расходы',
      markdown: '| Кат | Сумма |\n|---|--:|\n| Еда | 5 |\n| Транспорт | 1200 |',
      caption: 'март',
    });
    expect(rest).toEqual([]);
    expect(message).toBe(
      [
        '<b>Расходы</b>',
        '',
        '<pre>Кат       | Сумма',
        '----------+------',
        'Еда       |     5',
        'Транспорт |  1200</pre>',
        '',
        '<i>март</i>',
      ].join('\n'),
    );
  });

  it('strips markdown markers and neutralizes HTML in cells', () => {
    const [message] = buildPreTableMessages({ title: '<T>', markdown: TABLE });
    expect(message).toContain('<b>‹T›</b>');
    expect(message).toContain('Еда');
    expect(message).not.toContain('**');
    expect(message).not.toContain('<b>x');
  });

  it('splits a long table into messages within the Telegram limit, header in each', () => {
    const messages = buildPreTableMessages({ title: 'T', markdown: tallTable(400, 'значение') });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
      expect(message).toContain('<pre>a        | b');
    }
    const rows = messages.join('\n').match(/значение \| значение/g) ?? [];
    expect(rows).toHaveLength(400);
  });
});

describe('sendTableMessage', () => {
  it('sends a rich message and nothing else when Telegram accepts it', async () => {
    await sendTableMessage({ title: 'T', markdown: TABLE });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0].blocks[1]?.type).toBe('table');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('falls back to <pre> messages when Telegram rejects the rich message', async () => {
    sendRichMessage.mockImplementation(() => Promise.resolve(null));
    await sendTableMessage({ title: 'T', markdown: TABLE });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toContain('<pre>');
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('sends a table over 20 columns as <pre> without trying a rich message', async () => {
    await sendTableMessage({ title: 'T', markdown: wideTable(21) });
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toContain('c20');
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });
});
