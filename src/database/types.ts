import type { CurrencyCode } from '../config/constants';

/**
 * Group model (Telegram group/supergroup)
 */
export interface Group {
  id: number;
  telegram_group_id: number;
  google_refresh_token: string | null;
  spreadsheet_id: string | null;
  default_currency: CurrencyCode;
  enabled_currencies: CurrencyCode[];
  custom_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateGroupData {
  telegram_group_id: number;
  default_currency?: CurrencyCode;
}

export interface UpdateGroupData {
  google_refresh_token?: string;
  spreadsheet_id?: string;
  default_currency?: CurrencyCode;
  enabled_currencies?: CurrencyCode[];
  custom_prompt?: string | null;
}

/**
 * User model
 */
export interface User {
  id: number;
  telegram_id: number;
  group_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserData {
  telegram_id: number;
  group_id?: number;
}

export interface UpdateUserData {
  group_id?: number;
}

/**
 * Category model
 */
export interface Category {
  id: number;
  group_id: number;
  name: string;
  created_at: string;
}

export interface CreateCategoryData {
  group_id: number;
  name: string;
}

/**
 * Pending expense model
 */
export interface PendingExpense {
  id: number;
  user_id: number;
  message_id: number;
  parsed_amount: number;
  parsed_currency: CurrencyCode;
  detected_category: string | null;
  comment: string;
  status: 'pending_category' | 'confirmed';
  created_at: string;
}

export interface CreatePendingExpenseData {
  user_id: number;
  message_id: number;
  parsed_amount: number;
  parsed_currency: CurrencyCode;
  detected_category: string | null;
  comment: string;
  status: 'pending_category' | 'confirmed';
}

export interface UpdatePendingExpenseData {
  detected_category?: string;
  status?: 'pending_category' | 'confirmed';
}

/**
 * Expense (final, synced to Google Sheets)
 */
export interface Expense {
  id: number;
  group_id: number;
  user_id: number; // Who added the expense
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
  eur_amount: number;
  created_at: string;
}

export interface CreateExpenseData {
  group_id: number;
  user_id: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
  eur_amount: number;
}

/**
 * Budget model
 */
export interface Budget {
  id: number;
  group_id: number;
  category: string;
  month: string; // Format: "YYYY-MM"
  limit_amount: number;
  currency: CurrencyCode;
  created_at: string;
  updated_at: string;
}

export interface CreateBudgetData {
  group_id: number;
  category: string;
  month: string;
  limit_amount: number;
  currency?: CurrencyCode;
}

export interface UpdateBudgetData {
  limit_amount?: number;
  currency?: CurrencyCode;
}

/**
 * Budget progress (for analytics and display)
 */
export interface BudgetProgress {
  category: string;
  limit_amount: number;
  spent_amount: number;
  currency: CurrencyCode;
  percentage: number;
  is_exceeded: boolean;
  is_warning: boolean; // >= 90%
}

/**
 * Chat message model (for AI conversation history)
 */
export interface ChatMessage {
  id: number;
  group_id: number;
  user_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface CreateChatMessageData {
  group_id: number;
  user_id: number;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Photo processing queue model
 */
export interface PhotoQueueItem {
  id: number;
  group_id: number;
  user_id: number;
  message_id: number;
  message_thread_id: number | null;
  file_id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error_message: string | null;
  created_at: string;
}

export interface CreatePhotoQueueData {
  group_id: number;
  user_id: number;
  message_id: number;
  message_thread_id?: number | null;
  file_id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
}

export interface UpdatePhotoQueueData {
  status?: 'pending' | 'processing' | 'done' | 'error';
  error_message?: string | null;
}

/**
 * Receipt item model (items from scanned receipts)
 */
export interface ReceiptItem {
  id: number;
  photo_queue_id: number;
  name_ru: string;
  name_original: string | null;
  quantity: number;
  price: number;
  total: number;
  currency: CurrencyCode;
  suggested_category: string;
  possible_categories: string[]; // JSON array
  status: 'pending' | 'confirmed';
  confirmed_category: string | null;
  waiting_for_category_input: number; // 0 or 1 (SQLite boolean)
  created_at: string;
}

export interface CreateReceiptItemData {
  photo_queue_id: number;
  name_ru: string;
  name_original?: string;
  quantity: number;
  price: number;
  total: number;
  currency: CurrencyCode;
  suggested_category: string;
  possible_categories: string[];
  status: 'pending' | 'confirmed';
}

export interface UpdateReceiptItemData {
  status?: 'pending' | 'confirmed';
  confirmed_category?: string;
  waiting_for_category_input?: number;
  possible_categories?: string; // JSON string of array
}

/**
 * Expense item model (detailed items linked to expenses)
 */
export interface ExpenseItem {
  id: number;
  expense_id: number;
  name_ru: string;
  name_original: string | null;
  quantity: number;
  price: number;
  total: number;
  created_at: string;
}

export interface CreateExpenseItemData {
  expense_id: number;
  name_ru: string;
  name_original?: string;
  quantity: number;
  price: number;
  total: number;
}
