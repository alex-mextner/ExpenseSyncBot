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
  active_topic_id: number | null;
  bank_panel_summary_message_id: number | null;
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
  active_topic_id?: number | null;
  bank_panel_summary_message_id?: number | null;
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
  // Summary mode fields (migration 016)
  summary_mode: number; // 0=item-by-item, 1=bulk summary
  ai_summary: string | null;
  correction_history: string | null;
  waiting_for_bulk_correction: number; // 0 or 1
  summary_message_id: number | null;
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
  summary_mode?: number;
  ai_summary?: string | null;
  correction_history?: string | null;
  waiting_for_bulk_correction?: number;
  summary_message_id?: number | null;
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
  status: 'pending' | 'confirmed' | 'skipped';
  confirmed_category: string | null;
  waiting_for_category_input: number; // 0 or 1 (SQLite boolean)
  created_at: string;
}

export interface CreateReceiptItemData {
  photo_queue_id: number;
  name_ru: string;
  name_original?: string | null;
  quantity: number;
  price: number;
  total: number;
  currency: CurrencyCode;
  suggested_category: string;
  possible_categories: string[];
  status: 'pending' | 'confirmed' | 'skipped';
}

export interface UpdateReceiptItemData {
  status?: 'pending' | 'confirmed' | 'skipped';
  confirmed_category?: string;
  waiting_for_category_input?: number;
  possible_categories?: string; // JSON string of array
}

/**
 * Per-year spreadsheet mapping for a group
 */
export interface GroupSpreadsheet {
  id: number;
  group_id: number;
  year: number;
  spreadsheet_id: string;
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
  name_original?: string | null;
  quantity: number;
  price: number;
  total: number;
}

// ─── Bank Integration Types ─────────────────────────────────────────────────

export interface BankConnection {
  id: number;
  group_id: number;
  bank_name: string;
  display_name: string;
  status: 'setup' | 'active' | 'disconnected';
  consecutive_failures: number;
  last_sync_at: string | null;
  last_error: string | null;
  panel_message_id: number | null;
  panel_message_thread_id: number | null;
  created_at: string;
}

export interface CreateBankConnectionData {
  group_id: number;
  bank_name: string;
  display_name: string;
  status?: BankConnection['status'];
}

export interface UpdateBankConnectionData {
  status?: BankConnection['status'];
  consecutive_failures?: number;
  last_sync_at?: string | null;
  last_error?: string | null;
  panel_message_id?: number | null;
  panel_message_thread_id?: number | null;
}

export interface BankCredential {
  connection_id: number;
  encrypted_data: string;
}

export interface BankAccount {
  id: number;
  connection_id: number;
  account_id: string;
  title: string;
  balance: number;
  currency: string;
  type: string | null;
  is_excluded: number;
  updated_at: string;
}

export interface UpsertBankAccountData {
  connection_id: number;
  account_id: string;
  title: string;
  balance: number;
  currency: string;
  type?: string | null;
}

export interface BankTransaction {
  id: number;
  connection_id: number;
  external_id: string;
  account_id: string | null;
  date: string;
  time: string | null;
  amount: number;
  sign_type: 'debit' | 'credit' | 'reversal';
  currency: string;
  merchant: string | null;
  merchant_normalized: string | null;
  mcc: number | null;
  raw_data: string;
  matched_expense_id: number | null;
  telegram_message_id: number | null;
  edit_in_progress: number;
  awaiting_comment: number;
  prefill_category: string | null;
  prefill_comment: string | null;
  status: 'pending' | 'confirmed' | 'skipped' | 'skipped_reversal';
  created_at: string;
}

export interface CreateBankTransactionData {
  connection_id: number;
  external_id: string;
  account_id?: string | null;
  date: string;
  time?: string | null;
  amount: number;
  sign_type: BankTransaction['sign_type'];
  currency: string;
  merchant?: string | null;
  merchant_normalized?: string | null;
  mcc?: number | null;
  raw_data: string;
  status: BankTransaction['status'];
}

export interface BankTransactionFilters {
  period?: string;
  bank_name?: string;
  status?: BankTransaction['status'];
}

export interface MerchantRule {
  id: number;
  pattern: string;
  flags: string;
  replacement: string;
  category: string | null;
  confidence: number;
  status: 'pending_review' | 'approved' | 'rejected';
  source: 'ai' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface CreateMerchantRuleData {
  pattern: string;
  flags?: string;
  replacement: string;
  category?: string | null;
  confidence?: number;
  source?: MerchantRule['source'];
}

export interface UpdateMerchantRuleData {
  pattern?: string;
  replacement?: string;
  category?: string | null;
  confidence?: number;
  status?: MerchantRule['status'];
}

export interface MerchantRuleRequest {
  id: number;
  merchant_raw: string;
  mcc: number | null;
  group_id: number | null;
  user_category: string | null;
  user_comment: string | null;
  processed: number;
  created_at: string;
}

export interface CreateMerchantRuleRequestData {
  merchant_raw: string;
  mcc?: number | null;
  group_id?: number | null;
  user_category?: string | null;
  user_comment?: string | null;
}

// ─── Recurring Pattern Types ────────────────────────────────────────────────

export type RecurringPatternStatus = 'active' | 'paused' | 'dismissed';

/**
 * Recurring expense pattern detected from history
 */
export interface RecurringPattern {
  id: number;
  group_id: number;
  category: string;
  expected_amount: number;
  currency: string;
  interval_days: number;
  expected_day: number | null;
  tolerance_days: number;
  last_seen_date: string | null;
  next_expected_date: string | null;
  status: RecurringPatternStatus;
  created_at: string;
  updated_at: string;
}

// ─── Sync Snapshot Types ──────────────────────────────────────────────────

export interface ExpenseSnapshot {
  id: number;
  snapshot_id: string;
  group_id: number;
  expense_id: number;
  user_id: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
  eur_amount: number;
  created_at: string;
}

export interface BudgetSnapshot {
  id: number;
  snapshot_id: string;
  group_id: number;
  budget_id: number;
  category: string;
  month: string;
  limit_amount: number;
  currency: CurrencyCode;
  created_at: string;
}

export interface CreateRecurringPatternData {
  group_id: number;
  category: string;
  expected_amount: number;
  currency: string;
  interval_days?: number;
  expected_day?: number;
  tolerance_days?: number;
  last_seen_date?: string;
  next_expected_date?: string;
}
