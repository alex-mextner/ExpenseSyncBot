/**
 * Work-log step details: which tool input fields the writer shows next to the tool label.
 * Pins the per-tool formatting (field order, separators, falsy/nullish quirks) through the public
 * setToolLabel() -> flush() path, so the formatter's structure can change without changing output.
 */
import { describe, expect, test } from 'bun:test';
import { makeRecordingWriter, splitWorkLog } from './telegram-stream.test-helpers';

/** The running-step line the writer shows for a tool call (the part after "⏳ " and before "..."). */
async function runningStep(name: string, input?: Record<string, unknown>): Promise<string> {
  const { writer, edits } = makeRecordingWriter();
  writer.setToolLabel(name, input);
  await writer.flush(true);
  const { log } = splitWorkLog(edits.at(-1) ?? '');
  const match = log.match(/⏳ (.*)\.\.\./);
  await writer.finalize();
  return match?.[1] ?? '';
}

describe('work-log step details per tool', () => {
  test('no input: just the label', async () => {
    expect(await runningStep('get_expenses')).toBe('Загружаю расходы');
  });

  test('unknown tool: its raw name, input ignored', async () => {
    expect(await runningStep('mystery_tool', { category: 'Еда' })).toBe('mystery_tool');
  });

  test('tool without a details formatter shows only the label', async () => {
    expect(await runningStep('get_categories', { anything: 'x' })).toBe('Загружаю категории');
  });

  describe('set_budget', () => {
    test('category and amount with currency', async () => {
      expect(
        await runningStep('set_budget', { category: 'Еда', amount: 500, currency: 'EUR' }),
      ).toBe('Устанавливаю бюджет: Еда, 500 EUR');
    });

    test('amount without currency has no trailing space', async () => {
      expect(await runningStep('set_budget', { category: 'Еда', amount: 500 })).toBe(
        'Устанавливаю бюджет: Еда, 500',
      );
    });

    test('amount 0 is shown (only null/undefined hide it)', async () => {
      expect(await runningStep('set_budget', { category: 'Еда', amount: 0, currency: 'EUR' })).toBe(
        'Устанавливаю бюджет: Еда, 0 EUR',
      );
    });

    test('missing amount leaves the category alone', async () => {
      expect(await runningStep('set_budget', { category: 'Еда' })).toBe('Устанавливаю бюджет: Еда');
    });

    test('nothing to show: just the label', async () => {
      expect(await runningStep('set_budget', {})).toBe('Устанавливаю бюджет');
    });
  });

  describe('delete_budget', () => {
    test('category and month', async () => {
      expect(await runningStep('delete_budget', { category: 'Еда', month: '2026-03' })).toBe(
        'Удаляю бюджет: Еда, 2026-03',
      );
    });

    test('month alone', async () => {
      expect(await runningStep('delete_budget', { month: '2026-03' })).toBe(
        'Удаляю бюджет: 2026-03',
      );
    });
  });

  describe('add_expense', () => {
    test('amount with currency, category and comment in that order', async () => {
      expect(
        await runningStep('add_expense', {
          comment: 'кофе',
          category: 'Еда',
          currency: 'EUR',
          amount: 5,
        }),
      ).toBe('Записываю расход: 5 EUR, Еда, кофе');
    });

    test('amount 0 is hidden (falsy), unlike set_budget', async () => {
      expect(
        await runningStep('add_expense', { amount: 0, currency: 'EUR', category: 'Еда' }),
      ).toBe('Записываю расход: Еда');
    });

    test('empty comment is dropped', async () => {
      expect(await runningStep('add_expense', { amount: 5, category: 'Еда', comment: '' })).toBe(
        'Записываю расход: 5, Еда',
      );
    });
  });

  describe('delete_expense', () => {
    test('id gets a # prefix', async () => {
      expect(await runningStep('delete_expense', { expense_id: 42 })).toBe('Удаляю расход: #42');
    });

    test('missing or zero id shows nothing', async () => {
      expect(await runningStep('delete_expense', {})).toBe('Удаляю расход');
      expect(await runningStep('delete_expense', { expense_id: 0 })).toBe('Удаляю расход');
    });
  });

  describe('get_expenses', () => {
    test('category, period and summary flag', async () => {
      expect(
        await runningStep('get_expenses', {
          summary_only: true,
          period: '2026-10',
          category: 'Еда',
        }),
      ).toBe('Загружаю расходы: Еда, 2026-10, сводка');
    });

    test('array params are joined with ", "', async () => {
      expect(
        await runningStep('get_expenses', {
          category: ['Еда', 'Машина'],
          period: ['2026-09', '2026-10'],
        }),
      ).toBe('Загружаю расходы: Еда, Машина, 2026-09, 2026-10');
    });

    test('non-string, non-array params are ignored', async () => {
      expect(await runningStep('get_expenses', { category: 5, period: { a: 1 } })).toBe(
        'Загружаю расходы',
      );
    });

    test('page > 1 is shown, page 1 is not', async () => {
      expect(await runningStep('get_expenses', { page: 3 })).toBe('Загружаю расходы: стр. 3');
      expect(await runningStep('get_expenses', { page: 1 })).toBe('Загружаю расходы');
    });

    test('page size is shown unless it is the default 100', async () => {
      expect(await runningStep('get_expenses', { page_size: 50 })).toBe('Загружаю расходы: (50)');
      expect(await runningStep('get_expenses', { page_size: 100 })).toBe('Загружаю расходы');
    });

    test('everything together keeps the order category, period, summary, page, page size', async () => {
      expect(
        await runningStep('get_expenses', {
          page_size: 20,
          page: 2,
          summary_only: true,
          period: '2026-10',
          category: 'Еда',
        }),
      ).toBe('Загружаю расходы: Еда, 2026-10, сводка, стр. 2, (20)');
    });
  });

  test('get_budgets: category and month', async () => {
    expect(await runningStep('get_budgets', { month: '2026-03', category: ['Еда', 'Кино'] })).toBe(
      'Проверяю бюджеты: Еда, Кино, 2026-03',
    );
  });

  test('get_bank_transactions: bank, period and status', async () => {
    expect(
      await runningStep('get_bank_transactions', {
        status: 'pending',
        period: '2026-10',
        bank_name: 'Revolut',
      }),
    ).toBe('Загружаю банковские транзакции: Revolut, 2026-10, pending');
  });

  describe('find_missing_expenses', () => {
    test('period only', async () => {
      expect(await runningStep('find_missing_expenses', { period: ['2026-09', '2026-10'] })).toBe(
        'Ищу пропущенные расходы: 2026-09, 2026-10',
      );
    });

    test('no period: just the label', async () => {
      expect(await runningStep('find_missing_expenses', {})).toBe('Ищу пропущенные расходы');
    });
  });

  describe('manage_category', () => {
    test('action and name are joined with a space, not a comma', async () => {
      expect(await runningStep('manage_category', { action: 'add', name: 'Еда' })).toBe(
        'Управляю категориями: add Еда',
      );
    });

    test('action alone', async () => {
      expect(await runningStep('manage_category', { action: 'list' })).toBe(
        'Управляю категориями: list',
      );
    });
  });

  describe('set_custom_prompt', () => {
    test('shows the prompt length in characters', async () => {
      expect(await runningStep('set_custom_prompt', { prompt: 'отвечай кратко' })).toBe(
        'Обновляю промпт: 14 символов',
      );
    });

    test('missing or empty prompt means the prompt is being cleared', async () => {
      expect(await runningStep('set_custom_prompt', {})).toBe('Обновляю промпт: очистка');
      expect(await runningStep('set_custom_prompt', { prompt: '' })).toBe(
        'Обновляю промпт: очистка',
      );
    });
  });

  describe('calculate', () => {
    test('the expression as text', async () => {
      expect(
        await runningStep('calculate', { expression: '100 USD', target_currency: 'EUR' }),
      ).toBe('Считаю: 100 USD');
    });

    test('a non-string expression is stringified', async () => {
      expect(await runningStep('calculate', { expression: 42 })).toBe('Считаю: 42');
    });

    test('missing expression: just the label', async () => {
      expect(await runningStep('calculate', {})).toBe('Считаю');
    });
  });
});
