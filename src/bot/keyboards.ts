import { InlineKeyboard } from 'gramio';
import type { CurrencyCode } from '../config/constants';
import { SUPPORTED_CURRENCIES, KEYBOARD_TEXTS } from '../config/constants';

/**
 * Create currency set selection keyboard (Step 1)
 */
export function createCurrencyKeyboard(selectedCurrencies: CurrencyCode[] = []): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Add currency buttons in rows of 3
  for (let i = 0; i < SUPPORTED_CURRENCIES.length; i += 3) {
    const row = SUPPORTED_CURRENCIES.slice(i, i + 3);

    for (const currency of row) {
      const isSelected = selectedCurrencies.includes(currency);
      const text = isSelected ? `✅ ${currency}` : currency;
      keyboard.text(text, `currency:${currency}`);
    }

    keyboard.row();
  }

  // Add next button (not done)
  if (selectedCurrencies.length > 0) {
    keyboard.text(KEYBOARD_TEXTS.next, 'currency:next');
  }

  return keyboard;
}

/**
 * Create default currency selection keyboard (Step 2)
 */
export function createDefaultCurrencyKeyboard(enabledCurrencies: CurrencyCode[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Show only enabled currencies in rows of 3
  for (let i = 0; i < enabledCurrencies.length; i += 3) {
    const row = enabledCurrencies.slice(i, i + 3);

    for (const currency of row) {
      keyboard.text(currency, `default:${currency}`);
    }

    keyboard.row();
  }

  return keyboard;
}

/**
 * Create category confirmation keyboard
 */
export function createCategoryConfirmKeyboard(category: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text(KEYBOARD_TEXTS.addNewCategory, `category:add:${category}`)
    .row()
    .text(KEYBOARD_TEXTS.selectExistingCategory, 'category:select');

  return keyboard;
}

/**
 * Create existing categories keyboard
 */
export function createCategoriesListKeyboard(categories: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const category of categories) {
    keyboard.text(category, `category:choose:${category}`).row();
  }

  keyboard.text(KEYBOARD_TEXTS.cancel, 'category:cancel');

  return keyboard;
}

/**
 * Create yes/no confirmation keyboard
 */
export function createConfirmKeyboard(action: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text('✅ Да', `confirm:${action}:yes`)
    .text('❌ Нет', `confirm:${action}:no`);

  return keyboard;
}

/**
 * Create budget setup prompt keyboard
 */
export function createBudgetPromptKeyboard(category: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text('💰 Установить бюджет €100', `budget:set:${category}:100`)
    .row()
    .text('⏭️ Пропустить', `budget:skip:${category}`);

  return keyboard;
}

/**
 * Create keyboard for adding new category with budget
 */
export function createAddCategoryWithBudgetKeyboard(category: string, amount: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text(`✅ Добавить "${category}" с бюджетом €${amount}`, `budget:add-category:${category}:${amount}`)
    .row()
    .text('❌ Отменить', `budget:cancel`);

  return keyboard;
}
