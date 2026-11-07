// Regression tests for the mention-question extraction — pins the 2026-11-06 production
// incident (issue #123 follow-up): an @mention followed by a multi-line budget list was
// truncated to its first line and the AI answered «список … не дошёл».

import { describe, expect, test } from 'bun:test';
import { extractMentionQuestion } from './mention-question';

/** The exact message lari4kina_babich sent on 2026-11-06 12:22 UTC (chat_messages row 573
 * stored only its first line — 68 chars — everything after the newline was lost). */
const NOVEMBER_BUDGET_LIST = `Установи следующие лимиты по бюджету по категориям
Суммы в евро
Аренда 550
Еда 900
КУ 250
Животные 200
Машина 200
Алекс 700
Лена 700
Прочее 200
Подписки 450
Накопления семья 700
Путешествия 800`;

describe('extractMentionQuestion', () => {
  test('keeps every line of the 2026-11-06 budget list after the mention', () => {
    const question = extractMentionQuestion(
      `@ExpenseSyncBot ${NOVEMBER_BUDGET_LIST}`,
      'ExpenseSyncBot',
    );
    expect(question).toBe(NOVEMBER_BUDGET_LIST);
  });

  test('keeps the «Суммы в евро» currency note and the category-first line order verbatim', () => {
    const question = extractMentionQuestion(
      `@ExpenseSyncBot ${NOVEMBER_BUDGET_LIST}`,
      'ExpenseSyncBot',
    );
    expect(question).toContain('Суммы в евро');
    expect(question).toContain('Аренда 550');
    expect(question).not.toContain('550 Аренда');
    expect(question?.split('\n')).toHaveLength(13);
  });

  test('a mention in the middle of the message keeps the multi-line remainder', () => {
    const question = extractMentionQuestion(
      `Ребята, давайте зафиксируем\n@ExpenseSyncBot ${NOVEMBER_BUDGET_LIST}`,
      'ExpenseSyncBot',
    );
    expect(question).toBe(NOVEMBER_BUDGET_LIST);
  });

  test('the bot name matches case-insensitively', () => {
    expect(extractMentionQuestion(`@expensesyncbot Аренда 550\nЕда 900`, 'ExpenseSyncBot')).toBe(
      'Аренда 550\nЕда 900',
    );
  });

  test('a bare mention with no payload is not a question', () => {
    // The follow-up turn of the incident: «@ExpenseSyncBot» alone (row 580) must fall
    // through to the normal text routing, not produce an empty AI question.
    expect(extractMentionQuestion('@ExpenseSyncBot', 'ExpenseSyncBot')).toBeNull();
    expect(extractMentionQuestion('@ExpenseSyncBot \n\n', 'ExpenseSyncBot')).toBeNull();
  });

  test('a message without the mention is left alone (plain-text routing handles it)', () => {
    expect(extractMentionQuestion(NOVEMBER_BUDGET_LIST, 'ExpenseSyncBot')).toBeNull();
    expect(extractMentionQuestion('@ДругойБот Аренда 550', 'ExpenseSyncBot')).toBeNull();
  });

  test('several prompts in one chat extract independently and statelessly', () => {
    const first = extractMentionQuestion('@ExpenseSyncBot Аренда 550', 'ExpenseSyncBot');
    const second = extractMentionQuestion('@ExpenseSyncBot Еда 900\nКУ 250', 'ExpenseSyncBot');
    expect(first).toBe('Аренда 550');
    expect(second).toBe('Еда 900\nКУ 250');
    expect(extractMentionQuestion('@ExpenseSyncBot Аренда 550', 'ExpenseSyncBot')).toBe(first);
  });
});

// Source-contract pin: createBot() routes @mentions through extractMentionQuestion. The
// unit tests above cannot catch a regression that reintroduces an inline single-line
// `(.+)` regex in src/bot/index.ts (booting the real bot in a test is not viable), so the
// wiring is pinned textually — the incident fix must not be bypassable by an edit there.
describe('mention routing wiring', () => {
  test('src/bot/index.ts extracts mention questions via extractMentionQuestion', async () => {
    const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(source).toContain('extractMentionQuestion');
    expect(source).not.toContain(String.raw`\\s+(.+)`);
  });
});
