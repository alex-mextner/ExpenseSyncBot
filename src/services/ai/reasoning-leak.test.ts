// Tests for findReasoningLeak — English meta-reasoning a model wrote into a Russian answer.

import { describe, expect, it } from 'bun:test';
import { findReasoningLeak } from './reasoning-leak';

// The answer gpt-oss-120b (then served by Groq) sent on stage (PR #170 QA, 2026-10-15 05:10 UTC), as stored in
// chat_messages: a cut-off list, its own notes about the conversation, then the real answer.
const STAGE_ANSWER = `• <b>Путешествия</b>: <b>2798.61 EUR</b>  
• <b>Алекс</b>: <b>1705.55 EUR</b>  
• <b>Эда</b>: <b>625.

We have a conversation where the user repeatedly asks: "сколько в евро потрачено в мае 2026 по каждой категории". The assistant finally called get_expenses with summary_only true and got the data. Then rendered a table. The final answer should present bullet list and table. However the assistant's final answer is incomplete: it ends with "• <b>Эда</b>: <b>625." and cut off. Need to correct.

We must produce final answer with bullet list of categories and totals, and also include the table via render_table. Must ensure categories exactly as returned: "Путешествия", "Алекс", "Еда". Use correct spelling "Еда".

Let's produce final answer.• <b>Путешествия</b>: <b>2798.61 EUR</b>  
• <b>Алекс</b>: <b>1705.55 EUR</b>  
• <b>Еда</b>: <b>625.68 EUR</b>  

Таблица с теми же данными отображена выше.`;

const RU_QUESTION = 'mxtnr: сколько в евро потрачено в мае 2026 по каждой категории';

describe('findReasoningLeak', () => {
  it('finds the stage answer: notes about the conversation inside a Russian reply', () => {
    // The quoted Russian question splits the paragraph; any English part of it is the evidence.
    expect(findReasoningLeak(STAGE_ANSWER, RU_QUESTION)).toContain('The assistant finally called');
  });

  it('finds reasoning written over several lines', () => {
    const answer =
      'Итого: 8561.59 EUR\n\nThe user asks for totals per category.\nI should use the summary from the tool result.\nNeed to answer in Russian with a bullet list.';
    expect(findReasoningLeak(answer, RU_QUESTION)).toContain('The user asks');
  });

  it('finds reasoning that mentions Russian category names', () => {
    const answer =
      'Итого: 8561.59 EUR\n\nThe user asks about Еда and Дом. I should use the tool result for Еда. Need to answer in Russian with a bullet list.';
    expect(findReasoningLeak(answer, RU_QUESTION)).toContain('The user asks about');
  });

  it.each([
    [
      'a long English quote in «»',
      'В комментарии написано «we need to pay rent by Friday before the landlord leaves for vacation», трата 700 EUR.',
    ],
    [
      'a long quote in <blockquote> and formatting tags',
      'Комментарий: <blockquote expandable><b>we need to pay rent by Friday before the landlord leaves for vacation</b></blockquote>',
    ],
  ])('leaves alone %s', (_label, answer) => {
    expect(findReasoningLeak(answer, 'mxtnr: что написано в комментарии к аренде?')).toBeNull();
  });

  it.each([
    'Let me check the expenses first. We need to call get_expenses for May and then sum up the categories properly before answering.',
    'The user asks for totals per category. I should use the summary from the tool result and answer in Russian with a bullet list.',
    'The <b>user</b> asks for totals per category and the <b>assistant</b> must produce a response using the expenses returned by tools.',
    '<|channel|>analysis<|message|>Need to answer in Russian.',
  ])('finds other meta-reasoning shapes: %s', (leak) => {
    expect(findReasoningLeak(`Итого: <b>8561.59 EUR</b>\n\n${leak}`, RU_QUESTION)).not.toBeNull();
  });

  // Pins tag removal to '' (not ' '): a space would split "us<b>er</b>" into two words.
  it('finds reasoning with formatting tags inside words', () => {
    const answer =
      'Итого: 5 EUR\n\nThe us<b>er</b> asks for the totals per category. The assis<i>tant</i> should use the expenses returned by tools to produce the response.';
    expect(findReasoningLeak(answer, RU_QUESTION)).toContain('The user asks');
  });

  it('a question about money transfers ("переводы") is still checked', () => {
    const leak =
      'We have a conversation where the user asks about transfers. The assistant must answer with the totals. Let me produce the final answer.';
    expect(
      findReasoningLeak(`Итого: 120 EUR\n\n${leak}`, 'mxtnr: сколько ушло на переводы в мае?'),
    ).not.toBeNull();
  });

  it.each([
    ['the user name "translate"', 'translate: сколько потратили на еду в мае?'],
    ['a money conversion ("переведи в евро")', 'mxtnr: переведи все расходы за май в евро'],
  ])('still checks %s', (_label, question) => {
    const leak =
      'We have a conversation where the user asks about expenses. The assistant must answer with the totals. Let me produce the final answer.';
    expect(findReasoningLeak(`Итого: 120 EUR\n\n${leak}`, question)).not.toBeNull();
  });

  it.each([
    [
      'a requested translation into English',
      'mxtnr: Переведи на английский: Нам нужно оплатить аренду до пятницы, пока арендодатель не уехал в отпуск.',
      'We need to pay rent by Friday before the landlord leaves for vacation, so please send the money soon.',
    ],
    [
      'an English question from a user with a Cyrillic name',
      'Алексей: How should we adjust our budget?',
      'We need to reduce dining expenses by twenty percent to stay within the budget next month, starting today.',
    ],
    [
      'a channel marker quoted in <code>',
      RU_QUESTION,
      'В комментарии написано <code><|channel|>analysis<|message|></code>, это мусор из выгрузки.',
    ],
    [
      'a channel marker quoted in «»',
      RU_QUESTION,
      'В комментарии написано «<|channel|>analysis<|message|>», это мусор из выгрузки.',
    ],
    [
      'a translation where one phrase matches two patterns ("we need to check")',
      'mxtnr: Переведи на английский: Нам нужно проверить платёж за аренду до пятницы, хозяин уезжает завтра.',
      'We need to check the rent payment before Friday because the landlord leaves tomorrow morning early.',
    ],
    [
      'a translation with "I need to answer"',
      'mxtnr: Переведи на английский: Мне нужно ответить арендодателю до пятницы, иначе мы потеряем квартиру.',
      'I need to answer the landlord before Friday, otherwise we will lose the apartment for good.',
    ],
    [
      'a translation repeating one phrase ("we need to … we need to …")',
      'mxtnr: Переведи на английский: Нам нужно оплатить аренду сегодня, и нам нужно купить продукты до пятницы.',
      'We need to pay the rent today, and we need to buy groceries before Friday evening at home.',
    ],
    [
      'a requested translation that happens to contain two such phrases',
      'mxtnr: Переведи на английский: Нам нужно оплатить аренду сегодня. Мне следует позвонить арендодателю до пятницы.',
      'We need to pay the rent today. I should call the landlord before Friday to confirm the transfer.',
    ],
    [
      'an answer the user asked to get in English ("по-английски")',
      'mxtnr: Ответь по-английски: что нам нужно сделать с бюджетом?',
      'We need to cut dining out, and I should move 200 EUR from travel to groceries this month.',
    ],
    [
      'an English question that names a Russian category',
      'mxtnr: What should we do about spending on Еда?',
      'We need to reduce restaurant spending, and I should move some budget from travel to groceries.',
    ],
  ])('leaves alone %s', (_label, question, answer) => {
    expect(findReasoningLeak(answer, question)).toBeNull();
  });

  // Sizes where a quadratic scan takes seconds and the linear one milliseconds, so the loose bound
  // tells them apart without failing on a busy CI machine.
  it.each([
    ['Cyrillic letters', `${'а'.repeat(100_000)} The user asks for totals. Let me answer.`],
    ['"<" without ">"', `Итого 5 EUR ${'<'.repeat(200_000)}`],
    ['"«" without "»"', `Итого 5 EUR ${'«'.repeat(200_000)}`],
    ['<code> without a closing tag', `Итого 5 EUR ${'<code>'.repeat(30_000)}`],
    ['many closed <code> blocks', `Итого 5 EUR ${'<code>x</code> '.repeat(30_000)}`],
  ])('a long run of %s is scanned in linear time', (_label, answer) => {
    const started = performance.now();
    findReasoningLeak(answer, RU_QUESTION);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['a plain Russian answer', 'Итого за май: <b>8561.59 EUR</b>'],
    [
      'English category and merchant names',
      '• <b>Netflix</b>: 12.99 EUR\n• <b>Amazon Prime</b>: 8.99 EUR\n• <b>Booking.com</b>: 420.00 EUR',
    ],
    [
      'a short English quote inside the answer',
      'В комментарии написано «we need to pay rent by Friday», трата 700 EUR.',
    ],
  ])('leaves alone %s', (_label, answer) => {
    expect(findReasoningLeak(answer, RU_QUESTION)).toBeNull();
  });

  it('ignores an English conversation: the user wrote in English', () => {
    expect(
      findReasoningLeak(
        'We need to look at May first. The user asked for totals, and the summary shows 8561.59 EUR in total for all categories.',
        'alex: how much did we spend in May?',
      ),
    ).toBeNull();
  });
});
