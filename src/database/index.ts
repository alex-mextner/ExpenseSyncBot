import type { Database } from 'bun:sqlite';
import { setupDatabase } from './schema';
import { GroupRepository } from './repositories/group.repository';
import { UserRepository } from './repositories/user.repository';
import { CategoryRepository } from './repositories/category.repository';
import { PendingExpenseRepository } from './repositories/pending-expense.repository';
import { ExpenseRepository } from './repositories/expense.repository';
import { BudgetRepository } from './repositories/budget.repository';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { PhotoQueueRepository } from './repositories/photo-queue.repository';
import { ReceiptItemsRepository } from './repositories/receipt-items.repository';
import { ExpenseItemsRepository } from './repositories/expense-items.repository';

/**
 * Database instance and repositories
 */
export class DatabaseService {
  public db: Database;
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

  constructor() {
    this.db = setupDatabase();
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
