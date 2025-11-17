import { InlineKeyboard } from 'gramio';
import type { CurrencyCode } from '../config/constants';
import { SUPPORTED_CURRENCIES, KEYBOARD_TEXTS } from '../config/constants';

/**
 * Create currency selection keyboard
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

  // Add done button
  if (selectedCurrencies.length > 0) {
    keyboard.text(KEYBOARD_TEXTS.done, 'currency:done');
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
