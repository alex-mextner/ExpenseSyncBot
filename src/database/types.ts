import type { CurrencyCode } from '../config/constants';

/**
 * User model
 */
export interface User {
  id: number;
  telegram_id: number;
  google_refresh_token: string | null;
  spreadsheet_id: string | null;
  default_currency: CurrencyCode;
  enabled_currencies: CurrencyCode[];
  created_at: string;
  updated_at: string;
}

export interface CreateUserData {
  telegram_id: number;
  default_currency?: CurrencyCode;
}

export interface UpdateUserData {
  google_refresh_token?: string;
  spreadsheet_id?: string;
  default_currency?: CurrencyCode;
  enabled_currencies?: CurrencyCode[];
}

/**
 * Category model
 */
export interface Category {
  id: number;
  user_id: number;
  name: string;
  created_at: string;
}

export interface CreateCategoryData {
  user_id: number;
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
  user_id: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
  usd_amount: number;
  created_at: string;
}

export interface CreateExpenseData {
  user_id: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
  usd_amount: number;
}
