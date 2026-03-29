import { format } from 'date-fns';
import { MESSAGES } from '../../config/constants';
import { database } from '../../database';
import type { Group, PhotoQueueItem, User } from '../../database/types';

import { createLogger } from '../../utils/logger.ts';
import {
  handleBankAccountsCallback,
  handleBankAccountToggleCallback,
  handleBankAddCallback,
  handleBankConfirmCallback,
  handleBankDisconnectCallback,
  handleBankDisconnectCancelCallback,
  handleBankDisconnectConfirmCallback,
  handleBankEditCallback,
  handleBankLetterCallback,
  handleBankLetterNavCallback,
  handleBankNoCommentCallback,
  handleBankReconnectCallback,
  handleBankSettingsBackCallback,
  handleBankSettingsCallback,
  handleBankSetupCallback,
  handleBankSyncCallback,
  handleBankWizardCancelCallback,
  handleBankWizardStartCallback,
} from '../commands/bank';
import { getCurrencySymbol, normalizeCurrency } from '../commands/budget';
import { handleCurrencyCallback, handleDefaultCurrencyCallback } from '../commands/connect';
import { handleDevCallback } from '../commands/dev';
import { handleDisconnectCancel, handleDisconnectConfirm } from '../commands/disconnect';
import { createBudgetPromptKeyboard, createCategoriesListKeyboard } from '../keyboards';
import type { BotInstance, Ctx } from '../types';
import { getSheetWriteErrorMessage, saveExpenseToSheet } from './message.handler';

const logger = createLogger('callback.handler');

/**
 * Ensure user exists and is linked to group from chat
 * Creates user if not exists, updates group_id if changed
 */
function ensureUserInGroup(telegramId: number, chatId: number | undefined) {
  if (!chatId) return null;

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return null;

  let user = database.users.findByTelegramId(telegramId);

  if (!user) {
    user = database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  } else if (user.group_id !== group.id) {
    database.users.update(telegramId, { group_id: group.id });
    user = database.users.findByTelegramId(telegramId);
  }

  return user ? { user, group } : null;
}

/**
 * Handle callback queries from inline keyboards
 */
export async function handleCallbackQuery(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
): Promise<void> {
  const data = ctx.data;
  const telegramId = ctx.from.id;
  const chatId = ctx.message?.chat?.id;

  if (!data) {
    return;
  }

  const [action, ...params] = data.split(':');

  try {
    switch (action) {
      case 'currency': {
        const currencyAction = params[0];
        if (!currencyAction || !chatId) {
          await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
          return;
        }
        await handleCurrencyCallback(ctx, currencyAction, chatId);
        break;
      }

      case 'default': {
        // Step 2: Default currency selection
        const currency = params[0];
        if (!currency || !chatId) {
          await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
          return;
        }
        await handleDefaultCurrencyCallback(ctx, currency, chatId);
        break;
      }

      case 'category':
        await handleCategoryAction(ctx, params, telegramId, bot);
        break;

      case 'confirm':
        await handleConfirmAction(ctx, params, bot);
        break;

      case 'budget':
        await handleBudgetAction(ctx, params, telegramId, bot);
        break;

      case 'confirm_receipt_item':
        await handleReceiptItemConfirm(ctx, params, telegramId, bot);
        break;

      case 'receipt_item_other':
        await handleReceiptItemOther(ctx, params, bot);
        break;

      case 'skip_receipt_item':
        await handleSkipReceiptItem(ctx, params, telegramId, bot);
        break;

      case 'use_found_category':
        await handleUseFoundCategory(ctx, params, telegramId, bot);
        break;

      case 'create_new_category':
        await handleCreateNewCategory(ctx, params, telegramId, bot);
        break;

      case 'receipt':
        await handleReceiptSummaryAction(ctx, params, telegramId, bot);
        break;

      case 'dev':
        await handleDevCallback(ctx, params, telegramId, bot);
        break;

      case 'bank_confirm': {
        const txId = Number(params[0]);
        if (!chatId || !txId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankConfirmCallback(ctx, bot, txId, chatId);
        break;
      }

      case 'bank_edit': {
        const txId = Number(params[0]);
        if (!chatId || !txId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankEditCallback(ctx, bot, txId, chatId);
        break;
      }

      case 'bank_nocomment': {
        const txId = Number(params[0]);
        if (!chatId || !txId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankNoCommentCallback(ctx, bot, txId, chatId);
        break;
      }

      case 'merchant_approve': {
        const ruleId = Number(params[0]);
        if (!ruleId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        database.merchantRules.updateStatus(ruleId, 'approved');
        await ctx.answerCallbackQuery({ text: '✅ Правило принято' });
        if (chatId && ctx.message?.id) {
          try {
            await bot.api.editMessageReplyMarkup({
              chat_id: chatId,
              message_id: ctx.message.id,
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            // message may be too old to edit
          }
        }
        break;
      }

      case 'merchant_reject': {
        const ruleId = Number(params[0]);
        if (!ruleId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        database.merchantRules.updateStatus(ruleId, 'rejected');
        await ctx.answerCallbackQuery({ text: '❌ Правило отклонено' });
        if (chatId && ctx.message?.id) {
          try {
            await bot.api.editMessageReplyMarkup({
              chat_id: chatId,
              message_id: ctx.message.id,
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            // message may be too old to edit
          }
        }
        break;
      }

      case 'merchant_edit': {
        const ruleId = Number(params[0]);
        if (!ruleId || !chatId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await ctx.answerCallbackQuery();
        // TODO: implement reply-based edit for merchant rules (out of scope for this task)
        break;
      }

      case 'bank_setup': {
        const bankKey = params[0];
        if (!chatId || !bankKey) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankSetupCallback(ctx, bot, bankKey, chatId);
        break;
      }

      case 'bank_reconnect': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankReconnectCallback(ctx, bot, connId, chatId);
        break;
      }

      case 'bank_wizard_start': {
        const bankKey = params.join(':');
        if (!chatId || !bankKey) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankWizardStartCallback(ctx, bot, bankKey, chatId);
        break;
      }

      case 'bank_wizard_cancel': {
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankWizardCancelCallback(ctx, chatId);
        break;
      }

      case 'bank_settings': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankSettingsCallback(ctx, bot, connId, chatId);
        break;
      }

      case 'bank_sync': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankSyncCallback(ctx, connId, chatId);
        break;
      }

      case 'bank_disconnect': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankDisconnectCallback(ctx, bot, connId, chatId);
        break;
      }

      case 'bank_disconnect_confirm': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankDisconnectConfirmCallback(ctx, bot, connId, chatId);
        break;
      }

      case 'bank_disconnect_cancel': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankDisconnectCancelCallback(ctx, bot, connId, chatId);
        break;
      }

      case 'bank_settings_back': {
        const connId = Number(params[0]);
        if (!chatId || !connId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankSettingsBackCallback(ctx, bot, connId, chatId);
        break;
      }

      case 'bank_add': {
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankAddCallback(ctx, chatId);
        break;
      }

      case 'bank_letter': {
        const letter = params[0]?.toUpperCase();
        if (!chatId || !letter) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankLetterCallback(ctx, bot, letter, chatId);
        break;
      }

      case 'bank_letter_nav': {
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankLetterNavCallback(ctx, bot, chatId);
        break;
      }

      case 'bank_accounts': {
        const connectionId = Number(params[0]);
        if (!chatId || !connectionId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankAccountsCallback(ctx, bot, connectionId, chatId);
        break;
      }

      case 'bank_account_toggle': {
        const accountId = Number(params[0]);
        const connectionId = Number(params[1]);
        if (!chatId || !accountId || !connectionId) {
          await ctx.answerCallbackQuery({ text: 'Неверные данные' });
          return;
        }
        await handleBankAccountToggleCallback(ctx, bot, accountId, connectionId, chatId);
        break;
      }

      case 'sync_more': {
        await handleSyncMoreCallback(ctx, params, bot);
        break;
      }

      case 'bsync_more': {
        await handleBudgetSyncMoreCallback(ctx, params, bot);
        break;
      }

      default:
        await ctx.answerCallbackQuery({ text: 'Unknown action' });
    }
  } catch (error) {
    logger.error({ err: error }, `[CALLBACK] Unhandled error for action "${data}"`);
    try {
      await ctx.answerCallbackQuery({ text: 'Internal error' });
    } catch {}
  }
}

/**
 * Handle category-related callbacks
 */
async function handleCategoryAction(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, ...rest] = params;
  const chatId = ctx.message?.chat?.id;
  const result = ensureUserInGroup(telegramId, chatId);

  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const { user, group } = result;

  switch (subAction) {
    case 'add': {
      // Add new category
      const categoryName = rest.join(':');
      database.categories.create({ group_id: group.id, name: categoryName });

      await ctx.answerCallbackQuery({
        text: MESSAGES.categoryAdded.replace('{category}', categoryName),
      });

      // Delete the button message
      const messageId = ctx.message?.id;
      const chatId = ctx.message?.chat?.id;
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }

      // Find and save pending expense
      const pendingExpenses = database.pendingExpenses.findByUserId(user.id);
      const pending = pendingExpenses.find(
        (p) => p.detected_category === categoryName && p.status === 'pending_category',
      );

      let expenseSaved = false;
      if (pending) {
        database.pendingExpenses.update(pending.id, { status: 'confirmed' });
        try {
          await saveExpenseToSheet(user.id, group.id, pending.id, chatId || undefined, bot);
          expenseSaved = true;
        } catch (error) {
          logger.error({ err: error }, `[CALLBACK] Failed to save expense to sheet`);
          database.pendingExpenses.delete(pending.id);
          if (chatId) {
            await bot.api.sendMessage({
              chat_id: chatId,
              text: getSheetWriteErrorMessage(group.id),
            });
          }
        }
      }

      // Prompt for budget setup only if expense was saved
      if (expenseSaved && chatId) {
        const keyboard = createBudgetPromptKeyboard(categoryName, group.default_currency);
        await bot.api.sendMessage({
          chat_id: chatId,
          text: `💰 Хочешь установить бюджет для категории "${categoryName}"?`,
          reply_markup: keyboard.build(),
        });
      }

      break;
    }

    case 'select': {
      // Show existing categories
      const categories = database.categories.getCategoryNames(group.id);

      if (categories.length === 0) {
        await ctx.answerCallbackQuery({ text: 'Нет сохраненных категорий' });
        return;
      }

      const keyboard = createCategoriesListKeyboard(categories);
      await ctx.editReplyMarkup({
        inline_keyboard: keyboard.build().inline_keyboard,
      });
      await ctx.answerCallbackQuery({ text: 'Выбери категорию' });
      break;
    }

    case 'choose': {
      // Choose existing category
      const categoryName = rest.join(':');

      // Find pending expense for this user
      const pendingExpenses = database.pendingExpenses.findByUserId(user.id);
      const pending = pendingExpenses.find((p) => p.status === 'pending_category');

      if (!pending) {
        await ctx.answerCallbackQuery({ text: 'Расход не найден' });
        return;
      }

      // Update category
      database.pendingExpenses.update(pending.id, {
        detected_category: categoryName,
        status: 'confirmed',
      });

      await ctx.answerCallbackQuery({ text: `Категория: ${categoryName}` });

      // Delete the button message
      const messageId = ctx.message?.id;
      const chatId = ctx.message?.chat?.id;
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }

      // Save expense
      try {
        await saveExpenseToSheet(user.id, group.id, pending.id, chatId || undefined, bot);
      } catch (error) {
        logger.error({ err: error }, `[CALLBACK] Failed to save expense to sheet`);
        database.pendingExpenses.delete(pending.id);
        if (chatId) {
          await bot.api.sendMessage({
            chat_id: chatId,
            text: getSheetWriteErrorMessage(group.id),
          });
        }
      }
      break;
    }

    case 'cancel': {
      await ctx.answerCallbackQuery({ text: 'Отменено' });

      // Delete the button message
      const messageId = ctx.message?.id;
      const chatId = ctx.message?.chat?.id;
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }
      break;
    }
  }
}

/**
 * Handle confirmation callbacks
 */
async function handleConfirmAction(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  bot: BotInstance,
): Promise<void> {
  const action = params[0] ?? '';
  const answer = params[1] ?? '';

  if (action === 'disconnect') {
    if (answer === 'yes') {
      await handleDisconnectConfirm(ctx, bot);
    } else {
      await handleDisconnectCancel(ctx, bot);
    }
    return;
  }

  if (answer === 'yes') {
    await ctx.answerCallbackQuery({ text: '✅ Подтверждено' });
    // Handle specific confirmation actions here
  } else {
    await ctx.answerCallbackQuery({ text: '❌ Отменено' });

    // Delete the button message
    const messageId = ctx.message?.id;
    const chatId = ctx.message?.chat?.id;
    if (messageId && chatId) {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    }
  }
}

/**
 * Handle budget-related callbacks
 */
async function handleBudgetAction(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, category, ...rest] = params;
  const chatId = ctx.message?.chat?.id;
  const messageId = ctx.message?.id;
  const result = ensureUserInGroup(telegramId, chatId);

  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const { group } = result;

  switch (subAction) {
    case 'set': {
      // Set budget for category
      const amountStr = rest[0];
      const currencyStr = rest[1];
      const amount = amountStr ? parseFloat(amountStr) : 100;
      const currency = currencyStr
        ? normalizeCurrency(currencyStr) || group.default_currency
        : group.default_currency;

      if (Number.isNaN(amount) || amount <= 0) {
        await ctx.answerCallbackQuery({ text: '❌ Неверная сумма' });
        return;
      }

      const now = new Date();
      const currentMonth = format(now, 'yyyy-MM');

      // Save to database
      database.budgets.setBudget({
        group_id: group.id,
        category: category ?? '',
        month: currentMonth,
        limit_amount: amount,
        currency,
      });

      const currencySymbol = getCurrencySymbol(currency);
      await ctx.answerCallbackQuery({
        text: `✅ Бюджет установлен: ${currencySymbol}${amount}`,
      });

      // Delete the button message
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }

      break;
    }

    case 'add-category': {
      // Add new category and set budget
      const amountStr = rest[0];
      const currencyStr = rest[1];
      const amount = amountStr ? parseFloat(amountStr) : 100;
      const currency = currencyStr
        ? normalizeCurrency(currencyStr) || group.default_currency
        : group.default_currency;

      if (Number.isNaN(amount) || amount <= 0) {
        await ctx.answerCallbackQuery({ text: '❌ Неверная сумма' });
        return;
      }

      // Create category
      database.categories.create({ group_id: group.id, name: category ?? '' });

      const now = new Date();
      const currentMonth = format(now, 'yyyy-MM');

      // Set budget
      database.budgets.setBudget({
        group_id: group.id,
        category: category ?? '',
        month: currentMonth,
        limit_amount: amount,
        currency: currency,
      });

      const currencySymbol = getCurrencySymbol(currency);

      await ctx.answerCallbackQuery({
        text: `✅ Категория "${category}" создана, бюджет ${currencySymbol}${amount} установлен`,
      });

      // Delete the button message
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }

      break;
    }

    case 'skip': {
      await ctx.answerCallbackQuery({ text: '⏭️ Пропущено' });

      // Delete the button message
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }

      break;
    }

    case 'cancel': {
      await ctx.answerCallbackQuery({ text: '❌ Отменено' });

      // Delete the button message
      if (messageId && chatId) {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
      }

      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: 'Unknown budget action' });
  }
}

/**
 * Handle receipt item confirmation
 */
async function handleReceiptItemConfirm(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const itemIdStr = params[0];
  const categoryIndexStr = params[1];
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  if (!itemIdStr || categoryIndexStr === undefined) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const itemId = parseInt(itemIdStr, 10);
  const categoryIndex = parseInt(categoryIndexStr, 10);

  if (Number.isNaN(itemId) || Number.isNaN(categoryIndex)) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const result = ensureUserInGroup(telegramId, chatId);

  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const { user, group } = result;

  // Get receipt item
  const item = database.receiptItems.findById(itemId);

  if (!item || item.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: 'Товар не найден или уже обработан' });
    return;
  }

  // Collect all confirmed categories from this receipt (custom categories from user)
  const allItemsFromReceipt = database.receiptItems.findByPhotoQueueId(item.photo_queue_id);
  const confirmedCategories = allItemsFromReceipt
    .map((i) => (i.status === 'confirmed' ? i.confirmed_category : null))
    .filter((cat): cat is string => cat !== null);

  // Merge with possible_categories to create the same array as in showNextItemForConfirmation
  const allPossibleCategories = [...item.possible_categories, ...confirmedCategories].filter(
    (cat, index, self) => cat !== item.suggested_category && self.indexOf(cat) === index,
  );

  // Determine category based on index
  let category: string;
  if (categoryIndex === -1) {
    // Use suggested category
    category = item.suggested_category;
  } else {
    // Use category from dynamic allPossibleCategories array
    const selectedCategory = allPossibleCategories[categoryIndex];
    if (categoryIndex < 0 || categoryIndex >= allPossibleCategories.length || !selectedCategory) {
      await ctx.answerCallbackQuery({ text: 'Некорректный индекс категории' });
      return;
    }
    category = selectedCategory;
  }

  // Update receipt item with confirmed category
  database.receiptItems.update(itemId, {
    status: 'confirmed',
    confirmed_category: category,
  });

  // Create category if doesn't exist
  if (!database.categories.exists(group.id, category)) {
    database.categories.create({
      group_id: group.id,
      name: category,
    });
  }

  await ctx.answerCallbackQuery({ text: `✅ ${category}` });

  // Delete confirmation message
  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }

  // Check if all items from this receipt are confirmed
  const allItems = database.receiptItems.findByPhotoQueueId(item.photo_queue_id);
  const allConfirmed = allItems.every((i) => i.status === 'confirmed');

  if (allConfirmed) {
    // Save all items to expenses
    await saveReceiptExpenses(item.photo_queue_id, group.id, user.id, bot);
  } else {
    // Show next pending item
    const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
    await showNextItemForConfirmation(bot, group.id, item.photo_queue_id);
  }
}

/**
 * Handle "Other category" button
 */
async function handleReceiptItemOther(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  bot: BotInstance,
): Promise<void> {
  const itemIdStr = params[0];
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  if (!itemIdStr) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const itemId = parseInt(itemIdStr, 10);

  if (Number.isNaN(itemId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  // Get receipt item
  const item = database.receiptItems.findById(itemId);

  if (!item || item.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: 'Товар не найден или уже обработан' });
    return;
  }

  // Set waiting flag
  database.receiptItems.update(itemId, {
    waiting_for_category_input: 1,
  });

  await ctx.answerCallbackQuery({
    text: '✏️ Напишите название категории',
  });

  // Delete confirmation message with buttons
  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }

  // Send new message asking for category
  if (chatId) {
    await bot.api.sendMessage({
      chat_id: chatId,
      text: `✏️ Напишите категорию для товара:\n<b>${item.name_ru}</b>\n\nПросто отправьте сообщение с названием категории.`,
      parse_mode: 'HTML',
    });
  }
}

/**
 * Save all confirmed receipt items as expenses via ExpenseRecorder
 */
export async function saveReceiptExpenses(
  photoQueueId: number,
  groupId: number,
  userId: number,
  bot: BotInstance,
): Promise<void> {
  const confirmedItems = database.receiptItems.findConfirmedByPhotoQueueId(photoQueueId);

  if (confirmedItems.length === 0) {
    return;
  }

  const group = database.groups.findById(groupId);

  if (!group || !group.spreadsheet_id || !group.google_refresh_token) {
    logger.error('[RECEIPT] Group not configured for Google Sheets');
    return;
  }

  const { getExpenseRecorder } = await import('../../services/expense-recorder');
  const recorder = getExpenseRecorder();

  // Build receipt items for batch recording
  const receiptItems = confirmedItems
    .filter(
      (item): item is typeof item & { confirmed_category: string } =>
        item.confirmed_category !== null,
    )
    .map((item) => ({
      name: item.name_ru,
      nameOriginal: item.name_original || null,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      currency: item.currency,
      category: item.confirmed_category,
    }));

  await recorder.recordBatch(groupId, userId, receiptItems);

  // Delete all processed receipt items (confirmed + skipped)
  database.receiptItems.deleteProcessedByPhotoQueueId(photoQueueId);

  // Notify user
  const totalItems = confirmedItems.length;
  const categories = new Set(confirmedItems.map((i) => i.confirmed_category).filter(Boolean));

  await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    text: `✅ Чек обработан!\n📦 Товаров: ${totalItems}\n📂 Категорий: ${categories.size}`,
    parse_mode: 'HTML',
  });

  logger.info(`[RECEIPT] Saved ${totalItems} items from receipt (${categories.size} categories)`);
}

/**
 * Handle "use found category" button
 */
async function handleUseFoundCategory(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const itemIdStr = params[0];
  const category = params[1];
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  if (!itemIdStr || !category) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const itemId = parseInt(itemIdStr, 10);

  if (Number.isNaN(itemId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const result = ensureUserInGroup(telegramId, chatId);

  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const { user, group } = result;

  const item = database.receiptItems.findById(itemId);

  if (!item) {
    await ctx.answerCallbackQuery({ text: 'Товар не найден' });
    return;
  }

  // Update item with found category
  database.receiptItems.update(itemId, {
    status: 'confirmed',
    confirmed_category: category,
    waiting_for_category_input: 0,
  });

  // Create category if doesn't exist
  if (!database.categories.exists(group.id, category)) {
    database.categories.create({
      group_id: group.id,
      name: category,
    });
  }

  await ctx.answerCallbackQuery({ text: `✅ ${category}` });

  // Delete confirmation message
  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }

  // Check if all items are confirmed
  const allItems = database.receiptItems.findByPhotoQueueId(item.photo_queue_id);
  const allConfirmed = allItems.every((i) => i.status === 'confirmed');

  if (allConfirmed) {
    // Save all items
    await saveReceiptExpenses(item.photo_queue_id, group.id, user.id, bot);
  } else {
    // Show next pending item
    const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
    await showNextItemForConfirmation(bot, group.id, item.photo_queue_id);
  }
}

/**
 * Handle "skip receipt item" button
 */
async function handleSkipReceiptItem(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const itemIdStr = params[0];
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  if (!itemIdStr) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const itemId = parseInt(itemIdStr, 10);

  if (Number.isNaN(itemId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const result = ensureUserInGroup(telegramId, chatId);

  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const { user, group } = result;

  // Get receipt item
  const item = database.receiptItems.findById(itemId);

  if (!item || item.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: 'Товар не найден или уже обработан' });
    return;
  }

  // Update item status to skipped
  database.receiptItems.update(itemId, {
    status: 'skipped',
  });

  await ctx.answerCallbackQuery({ text: '⏭️ Товар пропущен' });

  // Delete confirmation message
  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }

  // Check if all items from this receipt are processed (confirmed or skipped)
  const allItems = database.receiptItems.findByPhotoQueueId(item.photo_queue_id);
  const allPending = allItems.filter((i) => i.status === 'pending');

  if (allPending.length === 0) {
    // No more pending items - save all confirmed items
    await saveReceiptExpenses(item.photo_queue_id, group.id, user.id, bot);
  } else {
    // Show next pending item
    const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
    await showNextItemForConfirmation(bot, group.id, item.photo_queue_id);
  }
}

/**
 * Handle "create new category" button
 */
async function handleCreateNewCategory(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const itemIdStr = params[0];
  const category = params[1];
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  if (!itemIdStr || !category) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const itemId = parseInt(itemIdStr, 10);

  if (Number.isNaN(itemId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const result = ensureUserInGroup(telegramId, chatId);

  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const { user, group } = result;

  const item = database.receiptItems.findById(itemId);

  if (!item) {
    await ctx.answerCallbackQuery({ text: 'Товар не найден' });
    return;
  }

  // Normalize category name
  const { normalizeCategoryName } = await import('../../utils/fuzzy-search');
  const normalizedCategory = normalizeCategoryName(category);

  // Update item with new category
  database.receiptItems.update(itemId, {
    status: 'confirmed',
    confirmed_category: normalizedCategory,
    waiting_for_category_input: 0,
  });

  // Create new category
  if (!database.categories.exists(group.id, normalizedCategory)) {
    database.categories.create({
      group_id: group.id,
      name: normalizedCategory,
    });
  }

  await ctx.answerCallbackQuery({ text: `✅ Создана новая: ${normalizedCategory}` });

  // Delete confirmation message
  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }

  // Re-fetch all items after update (categories will be collected dynamically in showNextItemForConfirmation)
  const allItems = database.receiptItems.findByPhotoQueueId(item.photo_queue_id);

  // Check if all items are confirmed
  const allConfirmed = allItems.every((i) => i.status === 'confirmed');

  if (allConfirmed) {
    // Save all items
    await saveReceiptExpenses(item.photo_queue_id, group.id, user.id, bot);
  } else {
    // Show next pending item
    const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
    await showNextItemForConfirmation(bot, group.id, item.photo_queue_id);
  }
}

/**
 * Handle receipt summary actions (accept_all, bulk_edit, itemwise, accept_bulk, cancel)
 */
async function handleReceiptSummaryAction(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, queueIdStr] = params;
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  if (!subAction || !queueIdStr) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const queueId = parseInt(queueIdStr, 10);

  if (Number.isNaN(queueId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid queue ID' });
    return;
  }

  const queueItem = database.photoQueue.findById(queueId);

  if (!queueItem) {
    await ctx.answerCallbackQuery({ text: 'Чек не найден' });
    return;
  }

  // Use group from queueItem (where receipt was created)
  const group = database.groups.findById(queueItem.group_id);

  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  // Ensure user exists and is linked to group
  const result = ensureUserInGroup(telegramId, chatId);
  const user = result?.user ?? database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  switch (subAction) {
    case 'accept_all':
      await handleReceiptAcceptAll(ctx, queueItem, group, user, bot, messageId, chatId);
      break;

    case 'bulk_edit':
      await handleReceiptBulkEdit(ctx, queueItem, bot, messageId, chatId);
      break;

    case 'itemwise':
      await handleReceiptItemwise(ctx, queueItem, group, bot, messageId, chatId);
      break;

    case 'accept_bulk':
      await handleReceiptAcceptBulk(ctx, queueItem, group, user, bot, messageId, chatId);
      break;

    case 'cancel':
      await handleReceiptCancel(ctx, queueItem, group, bot, messageId, chatId);
      break;

    default:
      await ctx.answerCallbackQuery({ text: 'Unknown receipt action' });
  }
}

/**
 * Accept all items as-is (using suggested categories)
 */
async function handleReceiptAcceptAll(
  ctx: Ctx['CallbackQuery'],
  queueItem: PhotoQueueItem,
  group: Group,
  user: User,
  bot: BotInstance,
  messageId?: number,
  chatId?: number,
): Promise<void> {
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  // Mark all pending items as confirmed with their suggested category
  for (const item of items) {
    if (item.status === 'pending') {
      database.receiptItems.update(item.id, {
        status: 'confirmed',
        confirmed_category: item.suggested_category,
      });

      // Create category if doesn't exist
      if (!database.categories.exists(group.id, item.suggested_category)) {
        database.categories.create({
          group_id: group.id,
          name: item.suggested_category,
        });
      }
    }
  }

  await ctx.answerCallbackQuery({ text: '✅ Принято!' });

  // Delete summary message
  if (messageId && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {}
  }

  // Save to Google Sheets
  await saveReceiptExpenses(queueItem.id, group.id, user.id, bot);
}

/**
 * Enter bulk edit mode (AI correction)
 */
async function handleReceiptBulkEdit(
  ctx: Ctx['CallbackQuery'],
  queueItem: PhotoQueueItem,
  bot: BotInstance,
  messageId?: number,
  chatId?: number,
): Promise<void> {
  // Set waiting for bulk correction flag
  database.photoQueue.update(queueItem.id, {
    summary_mode: 1,
    waiting_for_bulk_correction: 1,
    summary_message_id: messageId || null,
  });

  await ctx.answerCallbackQuery({ text: '🎨 Напишите корректировку' });

  // Update message to show instruction (no buttons - user just types correction text)
  if (messageId && chatId) {
    const items = database.receiptItems.findByPhotoQueueId(queueItem.id);
    const { buildSummaryFromItems, formatSummaryMessage } = await import(
      '../../services/receipt/receipt-summarizer'
    );

    const summary = buildSummaryFromItems(items);
    const summaryText = formatSummaryMessage(summary, items.length);

    const message = `${summaryText}\n\n✏️ <i>Напишите корректировку текстом, например:</i>\n<code>перенеси салфетки в Хозтовары</code>`;

    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: message,
        parse_mode: 'HTML',
      });
    } catch (error) {
      logger.error({ err: error }, '[RECEIPT] Failed to edit message');
    }
  }
}

/**
 * Switch to item-by-item mode
 */
async function handleReceiptItemwise(
  ctx: Ctx['CallbackQuery'],
  queueItem: PhotoQueueItem,
  group: Group,
  bot: BotInstance,
  messageId?: number,
  chatId?: number,
): Promise<void> {
  // Reset summary mode flags
  database.photoQueue.update(queueItem.id, {
    summary_mode: 0,
    waiting_for_bulk_correction: 0,
    ai_summary: null,
    correction_history: null,
  });

  await ctx.answerCallbackQuery({ text: '📦 По одной позиции' });

  // Delete summary message
  if (messageId && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {}
  }

  // Show first item
  const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
  await showNextItemForConfirmation(bot, group.id, queueItem.id);
}

/**
 * Accept bulk edit result
 */
async function handleReceiptAcceptBulk(
  ctx: Ctx['CallbackQuery'],
  queueItem: PhotoQueueItem,
  group: Group,
  user: User,
  bot: BotInstance,
  messageId?: number,
  chatId?: number,
): Promise<void> {
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  // If we have AI summary, use it to determine categories
  if (queueItem.ai_summary) {
    try {
      const summary = JSON.parse(queueItem.ai_summary);
      const { summaryToCategoryMap } = await import('../../services/receipt/receipt-summarizer');
      const categoryMap = summaryToCategoryMap(summary);

      // Update items with categories from summary
      for (const item of items) {
        if (item.status === 'pending') {
          const category = categoryMap.get(item.name_ru) || item.suggested_category;

          database.receiptItems.update(item.id, {
            status: 'confirmed',
            confirmed_category: category,
          });

          // Create category if doesn't exist
          if (!database.categories.exists(group.id, category)) {
            database.categories.create({
              group_id: group.id,
              name: category,
            });
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, '[RECEIPT] Failed to parse AI summary');
      // Fall back to suggested categories
      for (const item of items) {
        if (item.status === 'pending') {
          database.receiptItems.update(item.id, {
            status: 'confirmed',
            confirmed_category: item.suggested_category,
          });
        }
      }
    }
  } else {
    // No AI summary - use suggested categories
    for (const item of items) {
      if (item.status === 'pending') {
        database.receiptItems.update(item.id, {
          status: 'confirmed',
          confirmed_category: item.suggested_category,
        });

        if (!database.categories.exists(group.id, item.suggested_category)) {
          database.categories.create({
            group_id: group.id,
            name: item.suggested_category,
          });
        }
      }
    }
  }

  // Reset summary mode
  database.photoQueue.update(queueItem.id, {
    summary_mode: 0,
    waiting_for_bulk_correction: 0,
  });

  await ctx.answerCallbackQuery({ text: '✅ Принято!' });

  // Delete message
  if (messageId && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {}
  }

  // Save to Google Sheets
  await saveReceiptExpenses(queueItem.id, group.id, user.id, bot);
}

/**
 * Cancel receipt processing
 */
async function handleReceiptCancel(
  ctx: Ctx['CallbackQuery'],
  queueItem: PhotoQueueItem,
  group: Group,
  bot: BotInstance,
  messageId?: number,
  chatId?: number,
): Promise<void> {
  // Delete all receipt items
  database.receiptItems.deleteProcessedByPhotoQueueId(queueItem.id);

  // Reset queue item
  database.photoQueue.update(queueItem.id, {
    status: 'done',
    summary_mode: 0,
    waiting_for_bulk_correction: 0,
    ai_summary: null,
    correction_history: null,
  });

  await ctx.answerCallbackQuery({ text: '❌ Отменено' });

  // Delete message
  if (messageId && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {}
  }

  // Send cancellation notification
  await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    text: '❌ Обработка чека отменена',
    parse_mode: 'HTML',
  });
}

async function handleSyncMoreCallback(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  bot: BotInstance,
): Promise<void> {
  const [cacheKey, section] = params;
  const chatId = ctx.message?.chat?.id;

  if (!cacheKey || !section || !chatId) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели' });
    return;
  }

  const { getSyncCachedResult } = await import('../commands/sync');
  const result = getSyncCachedResult(cacheKey);
  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели. Выполни /sync заново.' });
    return;
  }

  let items: Array<{
    date: string;
    amount: number;
    currency: string;
    category: string;
    comment: string;
    field?: string;
  }>;
  let label: string;
  if (section === 'a') {
    items = result.added.slice(10);
    label = 'Добавлено';
  } else if (section === 'd') {
    items = result.deleted.slice(10);
    label = 'Удалено';
  } else {
    items = result.updated.slice(10);
    label = 'Обновлено';
  }

  const lines = [`📋 ${label} (ещё ${items.length}):`];
  for (const e of items) {
    const field = e.field ? ` (${e.field})` : '';
    lines.push(
      `  ${e.date} ${e.amount} ${e.currency} ${e.category}${e.comment ? ` ${e.comment}` : ''}${field}`,
    );
  }

  let text = lines.join('\n');
  if (text.length > 4096) text = `${text.slice(0, 4090)}\n...`;

  await ctx.answerCallbackQuery();
  await bot.api
    .sendMessage({ chat_id: chatId, text })
    .catch((err: unknown) => logger.error({ err }, '[CALLBACK] sync_more send failed'));
}

async function handleBudgetSyncMoreCallback(
  ctx: Ctx['CallbackQuery'],
  params: string[],
  bot: BotInstance,
): Promise<void> {
  const [cacheKey, section] = params;
  const chatId = ctx.message?.chat?.id;

  if (!cacheKey || !section || !chatId) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели' });
    return;
  }

  const { getBudgetSyncCachedResult } = await import('../commands/budget');
  const result = getBudgetSyncCachedResult(cacheKey);
  if (!result) {
    await ctx.answerCallbackQuery({ text: 'Данные устарели. Перезапусти бота.' });
    return;
  }

  let items: Array<{ category: string; limit: number; currency: string; oldLimit?: number }>;
  let label: string;
  if (section === 'a') {
    items = result.added.slice(10);
    label = 'Добавлено';
  } else if (section === 'd') {
    items = result.deleted.slice(10);
    label = 'Удалено';
  } else {
    items = result.updated.slice(10);
    label = 'Обновлено';
  }

  const lines = [`📋 Бюджеты — ${label} (ещё ${items.length}):`];
  for (const e of items) {
    const change = e.oldLimit !== undefined ? ` (было ${e.oldLimit})` : '';
    lines.push(`  ${e.category}: ${e.limit} ${e.currency}${change}`);
  }

  let text = lines.join('\n');
  if (text.length > 4096) text = `${text.slice(0, 4090)}\n...`;

  await ctx.answerCallbackQuery();
  await bot.api
    .sendMessage({ chat_id: chatId, text })
    .catch((err: unknown) => logger.error({ err }, '[CALLBACK] bsync_more send failed'));
}
