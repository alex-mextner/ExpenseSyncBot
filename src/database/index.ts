/** Database singleton — initializes all repositories and exposes them via a shared `database` object */
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { AdviceLogRepository } from './repositories/advice-log.repository';
import { BankAccountsRepository } from './repositories/bank-accounts.repository';
import { BankConnectionsRepository } from './repositories/bank-connections.repository';
import { BankCredentialsRepository } from './repositories/bank-credentials.repository';
import { BankTransactionsRepository } from './repositories/bank-transactions.repository';
import { type BudgetReadRepository, BudgetRepository } from './repositories/budget.repository';
import { CategoryRepository } from './repositories/category.repository';
import { CategoryEmojiCacheRepository } from './repositories/category-emoji-cache.repository';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { DevTaskRepository } from './repositories/dev-task.repository';
import { ExpenseRepository } from './repositories/expense.repository';
import { ExpenseItemsRepository } from './repositories/expense-items.repository';
import { GroupRepository } from './repositories/group.repository';
import { GroupSpreadsheetRepository } from './repositories/group-spreadsheet.repository';
import { MerchantRulesRepository } from './repositories/merchant-rules.repository';
import { PendingExpenseRepository } from './repositories/pending-expense.repository';
import { PhotoQueueRepository } from './repositories/photo-queue.repository';
import { ReceiptItemsRepository } from './repositories/receipt-items.repository';
import { RecurringPatternRepository } from './repositories/recurring-pattern.repository';
import { SyncSnapshotRepository } from './repositories/sync-snapshot.repository';
import { UserRepository } from './repositories/user.repository';
import { setupDatabase } from './schema';

/**
 * Database instance and repositories
 */
export class DatabaseService {
  private db: Database;
  public groups: GroupRepository;
  public groupSpreadsheets: GroupSpreadsheetRepository;
  public users: UserRepository;
  public categories: CategoryRepository;
  public categoryEmojiCache: CategoryEmojiCacheRepository;
  public pendingExpenses: PendingExpenseRepository;
  public expenses: ExpenseRepository;
  public budgets: BudgetReadRepository;
  private _budgetWriter: BudgetRepository;
  public chatMessages: ChatMessageRepository;
  public photoQueue: PhotoQueueRepository;
  public receiptItems: ReceiptItemsRepository;
  public expenseItems: ExpenseItemsRepository;
  public adviceLogs: AdviceLogRepository;
  public syncSnapshots: SyncSnapshotRepository;
  public devTasks: DevTaskRepository;
  public bankConnections: BankConnectionsRepository;
  public bankCredentials: BankCredentialsRepository;
  public bankAccounts: BankAccountsRepository;
  public bankTransactions: BankTransactionsRepository;
  public merchantRules: MerchantRulesRepository;
  public recurringPatterns: RecurringPatternRepository;

  constructor(db?: Database) {
    this.db = db ?? setupDatabase();
    this.groups = new GroupRepository(this.db);
    this.groupSpreadsheets = new GroupSpreadsheetRepository(this.db);
    this.users = new UserRepository(this.db);
    this.categories = new CategoryRepository(this.db);
    this.categoryEmojiCache = new CategoryEmojiCacheRepository(this.db);
    this.pendingExpenses = new PendingExpenseRepository(this.db);
    this.expenses = new ExpenseRepository(this.db);
    this._budgetWriter = new BudgetRepository(this.db);
    this.budgets = this._budgetWriter;
    _budgetWriterRef = this._budgetWriter;
    this.chatMessages = new ChatMessageRepository(this.db);
    this.photoQueue = new PhotoQueueRepository(this.db);
    this.receiptItems = new ReceiptItemsRepository(this.db);
    this.expenseItems = new ExpenseItemsRepository(this.db);
    this.adviceLogs = new AdviceLogRepository(this.db);
    this.syncSnapshots = new SyncSnapshotRepository(this.db);
    this.devTasks = new DevTaskRepository(this.db);
    this.bankConnections = new BankConnectionsRepository(this.db);
    this.bankCredentials = new BankCredentialsRepository(this.db);
    this.bankAccounts = new BankAccountsRepository(this.db);
    this.bankTransactions = new BankTransactionsRepository(this.db);
    this.merchantRules = new MerchantRulesRepository(this.db);
    this.recurringPatterns = new RecurringPatternRepository(this.db);
  }

  /**
   * Run a function inside a SQLite transaction — rolls back on error
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Execute a raw SQL query and return all matching rows.
   * Use only when no repository method covers the query.
   */
  queryAll<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...params);
  }

  /**
   * Execute a raw SQL query and return the first matching row, or null.
   * Use only when no repository method covers the query.
   */
  queryOne<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...params);
  }

  /**
   * Execute a raw SQL statement that returns no rows (INSERT/UPDATE/DELETE).
   * Use only when no repository method covers the operation.
   */
  exec(sql: string, ...params: SQLQueryBindings[]): void {
    if (params.length === 0) {
      this.db.exec(sql);
    } else {
      this.db.query(sql).run(...params);
    }
  }

  /**
   * Provide raw Database access for low-level services (e.g. ZenMoney shim)
   * that must prepare statements at construction time.
   */
  getDb(): Database {
    return this.db;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Module-level reference to full BudgetRepository (with write methods).
// Populated during DatabaseService construction, before any consumer can call _budgetWriter().
let _budgetWriterRef: BudgetRepository;

// Export singleton instance
export const database = new DatabaseService();

/** @internal — only for BudgetManager. Write access to budgets. */
export function _budgetWriter(): BudgetRepository {
  return _budgetWriterRef;
}

// Re-export types
export * from './types';
