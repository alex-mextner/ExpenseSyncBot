/** TelegramStreamWriter.finalize with tools but no AI text, and tool state tracking. */
import { describe, expect, test } from 'bun:test';
import type { Bot } from 'gramio';
import {
  makeRecordingWriter,
  makeWriter,
  NO_ANSWER_MESSAGE,
  runToolRound,
  splitWorkLog,
  TelegramStreamWriter,
} from './telegram-stream.test-helpers';

// ── finalize: tools-only (no AI text) ────────────────────────────────

describe('finalize: tools without AI text', () => {
  /** Writer whose bot records every text it puts on screen (placeholder edits included). */
  function makeShippingWriter(): { writer: TelegramStreamWriter; shipped: string[] } {
    const shipped: string[] = [];
    const bot = {
      api: {
        sendMessage: () => Promise.resolve({ message_id: 1 }),
        sendChatAction: () => Promise.resolve(true),
        deleteMessage: () => Promise.resolve(true),
        editMessageText: (params: { text: string }) => {
          shipped.push(params.text);
          return Promise.resolve(true);
        },
      },
    };
    // Test stub: only the four API methods the writer calls exist on it.
    const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
    return { writer, shipped };
  }

  // Contract change (prod incident 2026-10-12): a reply made only of ✅ tool lines is not an
  // answer. When tools ran but the AI produced no text, the user sees the failure message
  // under the collapsed tool summary, and that message is what history stores. This replaces
  // the old 'shows tool lines inline when AI produced no text' test, which pinned the bug.
  test('never ships only tool lines when AI produced no text — shows the failure message', async () => {
    const { writer, shipped } = makeShippingWriter();
    writer.setToolLabel('get_expenses', { period: '2026-03' });
    writer.markToolResult(true);
    await writer.finalize();

    const finalText = shipped.at(-1) ?? '';
    expect(finalText).toContain(NO_ANSWER_MESSAGE);
    // Tool lines stay available, collapsed under the summary header
    expect(finalText).toContain('<blockquote expandable>');
    expect(finalText).toContain('Загружаю расходы');
  });

  test('tools-only: getText() returns the failure message the user saw', async () => {
    const { writer } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    await writer.finalize();
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
  });

  test('a [SKIP] after tool calls is replaced by the failure message', async () => {
    const { writer, shipped } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText('[SKIP]');
    await writer.finalize();
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
    expect(shipped.at(-1)).not.toContain('[SKIP]');
  });

  test('no tools and no text: shows the Russian failure message', async () => {
    const { writer, shipped } = makeShippingWriter();
    await writer.finalize();
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
    expect(shipped.at(-1)).toBe(NO_ANSWER_MESSAGE);
  });

  test('allowSilence keeps a bare [SKIP] for the caller to delete', async () => {
    const { writer } = makeShippingWriter();
    writer.appendText('[SKIP]');
    await writer.finalize({ allowSilence: true });
    expect(writer.getText()).toBe('[SKIP]');
  });

  test.each([
    ['no text', ''],
    ['an ellipsis', '...'],
    ['a unicode ellipsis', '…'],
    // Short text that only contains the marker can be a real answer — never deleted silently.
    ['the marker next to an answer', '[SKIP] Потрачено 1 200 EUR'],
  ])('allowSilence never keeps %s once tools ran — that is a failed answer', async (_label, text) => {
    const { writer } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    writer.appendText(text);
    await writer.finalize({ allowSilence: true });
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
  });

  test.each([
    '[SKIP]',
    ' [skip]. ',
    '[ПРОПУСК]',
  ])('allowSilence keeps the bare marker %p after tool calls for the caller to delete', async (marker) => {
    const { writer, shipped } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText(marker);
    await writer.finalize({ allowSilence: true });
    expect(writer.getText()).toBe(marker.trim());
    expect(shipped.join('\n')).not.toContain(NO_ANSWER_MESSAGE);
  });

  // Asserts on the shipped message: the private finalDisplayText this used to read is gone (the
  // final message is now the work log plus the answer's first chunk).
  test('with AI text: tool summary wrapped in expandable blockquote', async () => {
    const { writer, edits } = makeRecordingWriter();
    runToolRound(writer, 'get_expenses', {});
    writer.appendText('Ответ AI.');
    await writer.finalize();

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('Инструменты');
    expect(body).toBe('Ответ AI.');
  });
});

// ── Edge cases: tool state tracking ───────────────────────────────────

describe('tool state tracking', () => {
  test('failed tool shows error status in the shipped work log', async () => {
    const { writer, edits } = makeRecordingWriter();
    writer.setToolLabel('add_expense', { amount: 100, currency: 'EUR', category: 'food' });
    writer.markToolResult(false);
    await writer.finalize();
    expect(splitWorkLog(edits.at(-1) ?? '').log).toContain('❌ Записываю расход: 100 EUR, food');
  });

  test('getText returns empty string before finalize', async () => {
    const writer = makeWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    expect(writer.getText()).toBe('');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });

  test('multiple tool calls all appear in the work log after finalize', async () => {
    const { writer, edits } = makeRecordingWriter();
    writer.setToolLabel('get_expenses', {});
    writer.markToolResult(true);
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(false);
    writer.commitIntermediate();
    writer.appendText('Summary.');
    await writer.finalize();

    const { log } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('✅ Загружаю расходы');
    expect(log).toContain('❌ Проверяю бюджеты');
  });

  test('getText() returns only the final AI text, not tool UI', async () => {
    const writer = makeWriter();
    // Round 1: tool call
    writer.setToolLabel('get_expenses', { period: '2026-03' });
    writer.markToolResult(true);
    writer.commitIntermediate();
    // Round 2: AI text response
    writer.appendText('Ответ AI.');
    await writer.finalize();

    const histText = writer.getText();
    expect(histText).not.toContain('<blockquote expandable>');
    expect(histText).not.toContain('Инструменты');
    expect(histText).toBe('Ответ AI.');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });
});
