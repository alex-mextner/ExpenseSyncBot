import type { Ctx } from '../types';
import { database } from '../../database';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { getCategoryEmoji } from '../../config/category-emojis';
import {
  createBudgetSheet,
  hasBudgetSheet,
  readBudgetData,
  writeBudgetRow,
} from '../../services/google/sheets';
import { createAddCategoryWithBudgetKeyboard } from '../keyboards';

/**
 * /budget command handler
 *
 * Usage:
 * - /budget - show current budgets and progress
 * - /budget set <Category> <Amount> - set budget for category
 * - /budget sync - sync budgets from Google Sheets
 */
export async function handleBudgetCommand(ctx: Ctx["Command"]): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  if (!group.spreadsheet_id || !group.google_refresh_token) {
    await ctx.send('❌ Google Sheets не подключен. Используй /connect');
    return;
  }

  // Parse command arguments
  const fullText = ctx.text || ctx.message?.text || '';

  // In GramIO, ctx.text for commands contains text WITHOUT the command itself
  // e.g. for "/budget set Food 100" it will be "set Food 100"
  const args = fullText.trim().split(/\s+/).filter(arg => arg.length > 0);

  console.log('[BUDGET] Full text:', fullText);
  console.log('[BUDGET] Args:', args);
  console.log('[BUDGET] Args length:', args.length);

  if (args.length === 0) {
    // Show current budgets and progress
    await showBudgetProgress(ctx, group);
    return;
  }

  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'set' && args.length >= 3) {
    // /budget set Category Amount
    const category = args[1]!;
    const amountStr = args[2]!;
    const amount = parseFloat(amountStr);

    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.send('❌ Неверная сумма. Используй: /budget set Категория 500');
      return;
    }

    await setBudget(ctx, group, category, amount);
    return;
  }

  if (subcommand === 'sync') {
    // Sync budgets from Google Sheets
    await syncBudgets(ctx, group);
    return;
  }

  // Invalid usage
  await ctx.send(
    '❌ Неверный формат команды.\n\n' +
    'Использование:\n' +
    '• /budget - показать бюджеты\n' +
    '• /budget set <Категория> <Сумма> - установить бюджет\n' +
    '• /budget sync - синхронизировать с Google Sheets'
  );
}

/**
 * Show budget progress for current month
 */
async function showBudgetProgress(ctx: Ctx["Command"], group: any): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthName = format(now, 'LLLL yyyy');

  // Ensure Budget sheet exists
  const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);
  if (!hasSheet) {
    const categories = database.categories.getCategoryNames(group.id);
    if (categories.length > 0) {
      try {
        await createBudgetSheet(
          group.google_refresh_token,
          group.spreadsheet_id,
          categories,
          100,
          'EUR'
        );
        await ctx.send('✅ Вкладка Budget создана в таблице!');
      } catch (err) {
        console.error('[BUDGET] Failed to create Budget sheet:', err);
        await ctx.send('⚠️ Не удалось создать вкладку Budget. Проверь доступ к таблице.');
      }
    }
  }

  // Get current month expenses
  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
  const expenses = database.expenses.findByDateRange(group.id, currentMonthStart, currentMonthEnd);

  // Calculate spending by category
  const categorySpending: Record<string, number> = {};
  for (const expense of expenses) {
    categorySpending[expense.category] = (categorySpending[expense.category] || 0) + expense.eur_amount;
  }

  // Get budgets for current month
  const budgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonth);

  if (budgets.length === 0) {
    await ctx.send(
      `📊 Бюджет на ${currentMonthName}\n\n` +
      `⚠️ Бюджеты не установлены.\n\n` +
      `Используй:\n` +
      `• /budget set <Категория> <Сумма>\n` +
      `• /budget sync - синхронизировать с Google Sheets`
    );
    return;
  }

  // Calculate total budget and total spent
  let totalBudget = 0;
  let totalSpent = 0;

  for (const budget of budgets) {
    totalBudget += budget.limit_amount;
    totalSpent += categorySpending[budget.category] || 0;
  }

  const totalPercentage = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

  // Build message
  let message = `📊 Бюджет на ${currentMonthName}\n\n`;
  message += `💰 Всего: €${totalSpent.toFixed(2)} / €${totalBudget.toFixed(2)} (${totalPercentage}%)\n\n`;

  // Sort budgets by percentage descending (exceeded first)
  const budgetProgress = budgets.map(budget => {
    const spent = categorySpending[budget.category] || 0;
    const percentage = budget.limit_amount > 0
      ? Math.round((spent / budget.limit_amount) * 100)
      : 0;

    return {
      budget,
      spent,
      percentage,
      is_exceeded: spent > budget.limit_amount,
      is_warning: percentage >= 90,
    };
  });

  budgetProgress.sort((a, b) => b.percentage - a.percentage);

  // Display each category
  for (const { budget, spent, percentage, is_exceeded, is_warning } of budgetProgress) {
    const emoji = getCategoryEmoji(budget.category);
    const status = is_exceeded ? '🔴' : is_warning ? '⚠️' : '';

    message += `${emoji} ${budget.category}: €${spent.toFixed(2)} / €${budget.limit_amount.toFixed(2)} (${percentage}%) ${status}\n`;
  }

  await ctx.send(message);
}

/**
 * Set budget for category in current month
 */
async function setBudget(
  ctx: Ctx["Command"],
  group: any,
  categoryName: string,
  amount: number
): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');

  // Normalize category name (capitalize first letter)
  const normalizedCategory = categoryName.charAt(0).toUpperCase() + categoryName.slice(1).toLowerCase();

  // Check if category exists
  const categoryExists = database.categories.exists(group.id, normalizedCategory);

  if (!categoryExists) {
    const existingCategories = database.categories.getCategoryNames(group.id);
    const keyboard = createAddCategoryWithBudgetKeyboard(normalizedCategory, amount);

    await ctx.send(
      `⚠️ Категория "${normalizedCategory}" не существует.\n\n` +
      `Хочешь добавить новую категорию "${normalizedCategory}" с бюджетом €${amount}?\n\n` +
      `Или выбери из существующих:\n${existingCategories.join(', ')}`,
      { reply_markup: keyboard.build() }
    );
    return;
  }

  // Save to database
  database.budgets.setBudget({
    group_id: group.id,
    category: normalizedCategory,
    month: currentMonth,
    limit_amount: amount,
    currency: 'EUR',
  });

  // Ensure Budget sheet exists
  const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);

  if (!hasSheet) {
    const categories = database.categories.getCategoryNames(group.id);
    await createBudgetSheet(
      group.google_refresh_token,
      group.spreadsheet_id,
      categories,
      100,
      'EUR'
    );
  }

  // Write to Google Sheets
  try {
    await writeBudgetRow(group.google_refresh_token, group.spreadsheet_id, {
      month: currentMonth,
      category: normalizedCategory,
      limit: amount,
      currency: 'EUR',
    });

    const emoji = getCategoryEmoji(normalizedCategory);
    await ctx.send(`✅ Бюджет установлен: ${emoji} ${normalizedCategory} = €${amount.toFixed(2)}`);
  } catch (err) {
    console.error('[BUDGET] Failed to write to Google Sheets:', err);
    await ctx.send(
      `⚠️ Бюджет сохранен в базу данных, но не удалось записать в Google Sheets.\n` +
      `Проверь доступ к таблице или используй /budget sync позже.`
    );
  }
}

/**
 * Sync budgets from Google Sheets to database
 */
async function syncBudgets(ctx: Ctx["Command"], group: any): Promise<void> {
  try {
    // Check if Budget sheet exists
    const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);

    if (!hasSheet) {
      // Try to create Budget sheet
      const categories = database.categories.getCategoryNames(group.id);
      if (categories.length > 0) {
        try {
          await createBudgetSheet(
            group.google_refresh_token,
            group.spreadsheet_id,
            categories,
            100,
            'EUR'
          );
          await ctx.send(
            '✅ Вкладка Budget создана в таблице!\n\n' +
            'Теперь можешь установить бюджеты через:\n' +
            '/budget set <Категория> <Сумма>'
          );
        } catch (err) {
          console.error('[BUDGET] Failed to create Budget sheet:', err);
          await ctx.send('⚠️ Не удалось создать вкладку Budget. Проверь доступ к таблице.');
        }
      } else {
        await ctx.send(
          `⚠️ Вкладка Budget не найдена в таблице.\n\n` +
          `Сначала добавь хотя бы один расход, чтобы создать категории.`
        );
      }
      return;
    }

    // Read budgets from Google Sheets
    const budgetsFromSheet = await readBudgetData(group.google_refresh_token, group.spreadsheet_id);

    if (budgetsFromSheet.length === 0) {
      await ctx.send('⚠️ В Google Sheets нет бюджетов для синхронизации.');
      return;
    }

    // Save each budget to database
    let syncedCount = 0;
    let createdCategoriesCount = 0;

    for (const budgetData of budgetsFromSheet) {
      // Check if category exists, if not - create it
      const categoryExists = database.categories.exists(group.id, budgetData.category);
      if (!categoryExists) {
        database.categories.create({ group_id: group.id, name: budgetData.category });
        createdCategoriesCount++;
        console.log(`[BUDGET] Created category: ${budgetData.category}`);
      }

      database.budgets.setBudget({
        group_id: group.id,
        category: budgetData.category,
        month: budgetData.month,
        limit_amount: budgetData.limit,
        currency: budgetData.currency,
      });
      syncedCount++;
    }

    let message = `✅ Синхронизировано бюджетов: ${syncedCount}`;
    if (createdCategoriesCount > 0) {
      message += `\n✨ Создано новых категорий: ${createdCategoriesCount}`;
    }
    await ctx.send(message);
  } catch (err) {
    console.error('[BUDGET] Failed to sync budgets:', err);
    await ctx.send('❌ Не удалось синхронизировать бюджеты. Проверь доступ к Google Sheets.');
  }
}
