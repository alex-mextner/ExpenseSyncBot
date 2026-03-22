// Tests for all inline keyboard builder functions in keyboards.ts
import { describe, expect, it } from 'bun:test';
import type { InlineKeyboard } from 'gramio';
import {
  createAddCategoryWithBudgetKeyboard,
  createBudgetPromptKeyboard,
  createBulkEditKeyboard,
  createCategoriesListKeyboard,
  createCategoryConfirmKeyboard,
  createConfirmKeyboard,
  createCurrencyKeyboard,
  createDefaultCurrencyKeyboard,
  createDevApprovalKeyboard,
  createDevMergeKeyboard,
  createDevReviewKeyboard,
  createReceiptSummaryKeyboard,
} from './keyboards';

// Helper: extract the raw inline_keyboard array from a GramIO InlineKeyboard
// GramIO stores buttons in .rows (completed rows) + .currentRow (last row),
// but .toJSON() combines them cleanly into the Telegram-compatible format.
function getRows(kb: InlineKeyboard): Array<Array<{ text: string; callback_data?: string }>> {
  const json = kb.toJSON() as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  };
  return json.inline_keyboard;
}

// Helper: all buttons as a flat array
function allButtons(kb: InlineKeyboard): Array<{ text: string; callback_data?: string }> {
  return getRows(kb).flat();
}

describe('createCurrencyKeyboard', () => {
  it('returns an InlineKeyboard with at least one row', () => {
    const kb = createCurrencyKeyboard([]);
    expect(getRows(kb).length).toBeGreaterThan(0);
  });

  it('all buttons have non-empty text', () => {
    const kb = createCurrencyKeyboard([]);
    for (const btn of allButtons(kb)) {
      expect(btn.text.length).toBeGreaterThan(0);
    }
  });

  it('all buttons have non-empty callback_data', () => {
    const kb = createCurrencyKeyboard([]);
    for (const btn of allButtons(kb)) {
      expect((btn.callback_data ?? '').length).toBeGreaterThan(0);
    }
  });

  it('callback_data starts with "currency:"', () => {
    const kb = createCurrencyKeyboard([]);
    for (const btn of allButtons(kb)) {
      expect(btn.callback_data).toMatch(/^currency:/);
    }
  });

  it('shows all 12 supported currencies as buttons', () => {
    const kb = createCurrencyKeyboard([]);
    const texts = allButtons(kb).map((b) => b.text);
    // All currencies appear as buttons (not selected, so just the code)
    expect(texts).toContain('EUR');
    expect(texts).toContain('USD');
    expect(texts).toContain('RSD');
  });

  it('selected currencies get checkmark prefix', () => {
    const kb = createCurrencyKeyboard(['EUR', 'USD']);
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.startsWith('✅') && t.includes('EUR'))).toBe(true);
    expect(texts.some((t) => t.startsWith('✅') && t.includes('USD'))).toBe(true);
  });

  it('non-selected currencies have no checkmark', () => {
    const kb = createCurrencyKeyboard(['EUR']);
    const texts = allButtons(kb).map((b) => b.text);
    const rsdBtn = texts.find((t) => t.includes('RSD') && !t.includes('✅'));
    expect(rsdBtn).toBeTruthy();
  });

  it('shows "next" button when at least one currency selected', () => {
    const kb = createCurrencyKeyboard(['EUR']);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('currency:next');
  });

  it('does NOT show "next" button when no currencies selected', () => {
    const kb = createCurrencyKeyboard([]);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).not.toContain('currency:next');
  });
});

describe('createDefaultCurrencyKeyboard', () => {
  it('shows only the provided currencies', () => {
    const kb = createDefaultCurrencyKeyboard(['EUR', 'USD']);
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts).toContain('EUR');
    expect(texts).toContain('USD');
    expect(texts).not.toContain('RSD');
  });

  it('callback_data starts with "default:"', () => {
    const kb = createDefaultCurrencyKeyboard(['EUR', 'RSD']);
    for (const btn of allButtons(kb)) {
      expect(btn.callback_data).toMatch(/^default:/);
    }
  });

  it('returns empty keyboard for empty input', () => {
    const kb = createDefaultCurrencyKeyboard([]);
    // No buttons at all, or only empty rows
    const buttons = allButtons(kb).filter((b) => b.text.length > 0);
    expect(buttons.length).toBe(0);
  });

  it('single currency returns one button', () => {
    const kb = createDefaultCurrencyKeyboard(['JPY']);
    const buttons = allButtons(kb).filter((b) => b.text.length > 0);
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.callback_data).toBe('default:JPY');
  });
});

describe('createCategoryConfirmKeyboard', () => {
  const category = 'Groceries';
  const kb = createCategoryConfirmKeyboard(category);

  it('returns an InlineKeyboard with buttons', () => {
    expect(allButtons(kb).length).toBeGreaterThan(0);
  });

  it('add button callback includes category name', () => {
    const buttons = allButtons(kb);
    const addBtn = buttons.find((b) => b.callback_data?.startsWith('category:add:'));
    expect(addBtn).toBeTruthy();
    expect(addBtn?.callback_data).toContain(category);
  });

  it('select button callback is category:select', () => {
    const buttons = allButtons(kb);
    const selectBtn = buttons.find((b) => b.callback_data === 'category:select');
    expect(selectBtn).toBeTruthy();
  });

  it('cancel button callback is category:cancel', () => {
    const buttons = allButtons(kb);
    const cancelBtn = buttons.find((b) => b.callback_data === 'category:cancel');
    expect(cancelBtn).toBeTruthy();
  });

  it('all buttons have non-empty text', () => {
    for (const btn of allButtons(kb)) {
      expect(btn.text.length).toBeGreaterThan(0);
    }
  });
});

describe('createCategoriesListKeyboard', () => {
  it('shows a button for each category', () => {
    const cats = ['Food', 'Transport', 'Health'];
    const kb = createCategoriesListKeyboard(cats);
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts).toContain('Food');
    expect(texts).toContain('Transport');
    expect(texts).toContain('Health');
  });

  it('category buttons have callback_data category:choose:<name>', () => {
    const kb = createCategoriesListKeyboard(['Food']);
    const btn = allButtons(kb).find((b) => b.callback_data?.startsWith('category:choose:'));
    expect(btn?.callback_data).toBe('category:choose:Food');
  });

  it('cancel button always present', () => {
    const kb = createCategoriesListKeyboard(['Food']);
    const cancelBtn = allButtons(kb).find((b) => b.callback_data === 'category:cancel');
    expect(cancelBtn).toBeTruthy();
  });

  it('empty categories list still has cancel button', () => {
    const kb = createCategoriesListKeyboard([]);
    const cancelBtn = allButtons(kb).find((b) => b.callback_data === 'category:cancel');
    expect(cancelBtn).toBeTruthy();
  });
});

describe('createConfirmKeyboard', () => {
  it('has yes and no buttons', () => {
    const kb = createConfirmKeyboard('delete');
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('confirm:delete:yes');
    expect(data).toContain('confirm:delete:no');
  });

  it('button text includes yes/no indicators', () => {
    const kb = createConfirmKeyboard('delete');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('Да'))).toBe(true);
    expect(texts.some((t) => t.includes('Нет'))).toBe(true);
  });

  it('action is embedded in callback_data', () => {
    const kb = createConfirmKeyboard('clear_history');
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data.some((d) => d?.includes('clear_history'))).toBe(true);
  });
});

describe('createBudgetPromptKeyboard', () => {
  it('has set budget and skip buttons', () => {
    const kb = createBudgetPromptKeyboard('Food');
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data.some((d) => d?.startsWith('budget:set:'))).toBe(true);
    expect(data.some((d) => d?.startsWith('budget:skip:'))).toBe(true);
  });

  it('callback_data includes category name', () => {
    const kb = createBudgetPromptKeyboard('Transport');
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data.some((d) => d?.includes('Transport'))).toBe(true);
  });

  it('EUR currency shows € symbol in button text', () => {
    const kb = createBudgetPromptKeyboard('Food', 'EUR');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('€'))).toBe(true);
  });

  it('USD currency shows $ symbol in button text', () => {
    const kb = createBudgetPromptKeyboard('Food', 'USD');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('$'))).toBe(true);
  });

  it('RUB currency shows ₽ symbol in button text', () => {
    const kb = createBudgetPromptKeyboard('Food', 'RUB');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('₽'))).toBe(true);
  });

  it('unknown currency falls back to currency code in button text', () => {
    const kb = createBudgetPromptKeyboard('Food', 'RSD');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('RSD'))).toBe(true);
  });

  it('default currency is EUR when not specified', () => {
    const kb = createBudgetPromptKeyboard('Food');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('€'))).toBe(true);
  });
});

describe('createAddCategoryWithBudgetKeyboard', () => {
  it('has add and cancel buttons', () => {
    const kb = createAddCategoryWithBudgetKeyboard('Gym', 200, 'EUR');
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data.some((d) => d?.startsWith('budget:add-category:'))).toBe(true);
    expect(data.some((d) => d === 'budget:cancel')).toBe(true);
  });

  it('callback includes category, amount, currency', () => {
    const kb = createAddCategoryWithBudgetKeyboard('Gym', 200, 'EUR');
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data.some((d) => d?.includes('Gym') && d.includes('200') && d.includes('EUR'))).toBe(
      true,
    );
  });

  it('button text includes category name', () => {
    const kb = createAddCategoryWithBudgetKeyboard('Vacation', 500, 'USD');
    const texts = allButtons(kb).map((b) => b.text);
    expect(texts.some((t) => t.includes('Vacation'))).toBe(true);
  });
});

describe('createDevApprovalKeyboard', () => {
  it('has approve, cancel, and edit buttons for task 42', () => {
    const kb = createDevApprovalKeyboard(42);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('dev:approve:42');
    expect(data).toContain('dev:cancel:42');
    expect(data).toContain('dev:edit:42');
  });

  it('taskId is embedded correctly in all callbacks', () => {
    const kb = createDevApprovalKeyboard(99);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data.every((d) => d?.endsWith(':99'))).toBe(true);
  });
});

describe('createDevReviewKeyboard', () => {
  it('has accept review, edit, and cancel buttons', () => {
    const kb = createDevReviewKeyboard(7);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('dev:accept_review:7');
    expect(data).toContain('dev:edit:7');
    expect(data).toContain('dev:cancel:7');
  });
});

describe('createDevMergeKeyboard', () => {
  it('has merge, edit, and cancel buttons', () => {
    const kb = createDevMergeKeyboard(3);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('dev:merge:3');
    expect(data).toContain('dev:edit:3');
    expect(data).toContain('dev:cancel:3');
  });
});

describe('createReceiptSummaryKeyboard', () => {
  it('has accept_all, bulk_edit, and itemwise buttons', () => {
    const kb = createReceiptSummaryKeyboard(55);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('receipt:accept_all:55');
    expect(data).toContain('receipt:bulk_edit:55');
    expect(data).toContain('receipt:itemwise:55');
  });

  it('all buttons have non-empty text', () => {
    const kb = createReceiptSummaryKeyboard(1);
    for (const btn of allButtons(kb)) {
      expect(btn.text.length).toBeGreaterThan(0);
    }
  });
});

describe('createBulkEditKeyboard', () => {
  it('has accept, itemwise, and cancel buttons', () => {
    const kb = createBulkEditKeyboard(12);
    const data = allButtons(kb).map((b) => b.callback_data);
    expect(data).toContain('receipt:accept_bulk:12');
    expect(data).toContain('receipt:itemwise:12');
    expect(data).toContain('receipt:cancel:12');
  });

  it('all buttons have non-empty text', () => {
    const kb = createBulkEditKeyboard(1);
    for (const btn of allButtons(kb)) {
      expect(btn.text.length).toBeGreaterThan(0);
    }
  });
});
