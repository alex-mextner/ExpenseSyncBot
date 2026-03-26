/** Database singleton — initializes all repositories and exposes them via a shared `database` object */
import type { Database } from 'bun:sqlite';
import { AdviceLogRepository } from './repositories/advice-log.repository';
import { BudgetRepository } from './repositories/budget.repository';
import { CategoryRepository } from './repositories/category.repository';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { DevTaskRepository } from './repositories/dev-task.repository';
import { ExpenseRepository } from './repositories/expense.repository';
import { ExpenseItemsRepository } from './repositories/expense-items.repository';
import { GroupRepository } from './repositories/group.repository';
import { PendingExpenseRepository } from './repositories/pending-expense.repository';
import { PhotoQueueRepository } from './repositories/photo-queue.repository';
import { ReceiptItemsRepository } from './repositories/receipt-items.repository';
import { SyncSnapshotRepository } from './repositories/sync-snapshot.repository';
import { UserRepository } from './repositories/user.repository';
import { setupDatabase } from './schema';

/**
 * Database instance and repositories
 */
export class DatabaseService {
  private db: Database;
  public groups: GroupRepository;
  public users: UserRepository;
  public categories: CategoryRepository;
  public pendingExpenses: PendingExpenseRepository;
  public expenses: ExpenseRepository;
  public budgets: BudgetRepository;
  public chatMessages: ChatMessageRepository;
  public photoQueue: PhotoQueueRepository;
  public receiptItems: ReceiptItemsRepository;
  public expenseItems: ExpenseItemsRepository;
  public adviceLogs: AdviceLogRepository;
  public syncSnapshots: SyncSnapshotRepository;
  public devTasks: DevTaskRepository;

  constructor(db?: Database) {
    this.db = db ?? setupDatabase();
    this.groups = new GroupRepository(this.db);
    this.users = new UserRepository(this.db);
    this.categories = new CategoryRepository(this.db);
    this.pendingExpenses = new PendingExpenseRepository(this.db);
    this.expenses = new ExpenseRepository(this.db);
    this.budgets = new BudgetRepository(this.db);
    this.chatMessages = new ChatMessageRepository(this.db);
    this.photoQueue = new PhotoQueueRepository(this.db);
    this.receiptItems = new ReceiptItemsRepository(this.db);
    this.expenseItems = new ExpenseItemsRepository(this.db);
    this.adviceLogs = new AdviceLogRepository(this.db);
    this.syncSnapshots = new SyncSnapshotRepository(this.db);
    this.devTasks = new DevTaskRepository(this.db);
  }

  /**
   * Run a function inside a SQLite transaction — rolls back on error
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Export singleton instance
export const database = new DatabaseService();

// Re-export types
export * from './types';
