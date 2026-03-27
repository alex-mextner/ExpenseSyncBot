import type { Database } from 'bun:sqlite';
import { AdviceLogRepository } from './repositories/advice-log.repository';
import { BankAccountsRepository } from './repositories/bank-accounts.repository';
import { BankConnectionsRepository } from './repositories/bank-connections.repository';
import { BankCredentialsRepository } from './repositories/bank-credentials.repository';
import { BankTransactionsRepository } from './repositories/bank-transactions.repository';
import { BudgetRepository } from './repositories/budget.repository';
import { CategoryRepository } from './repositories/category.repository';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { DevTaskRepository } from './repositories/dev-task.repository';
import { ExpenseRepository } from './repositories/expense.repository';
import { ExpenseItemsRepository } from './repositories/expense-items.repository';
import { GroupRepository } from './repositories/group.repository';
import { MerchantRulesRepository } from './repositories/merchant-rules.repository';
import { PendingExpenseRepository } from './repositories/pending-expense.repository';
import { PhotoQueueRepository } from './repositories/photo-queue.repository';
import { ReceiptItemsRepository } from './repositories/receipt-items.repository';
import { UserRepository } from './repositories/user.repository';
import { setupDatabase } from './schema';

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
  public adviceLogs: AdviceLogRepository;
  public devTasks: DevTaskRepository;
  public bankConnections: BankConnectionsRepository;
  public bankCredentials: BankCredentialsRepository;
  public bankAccounts: BankAccountsRepository;
  public bankTransactions: BankTransactionsRepository;
  public merchantRules: MerchantRulesRepository;

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
    this.adviceLogs = new AdviceLogRepository(this.db);
    this.devTasks = new DevTaskRepository(this.db);
    this.bankConnections = new BankConnectionsRepository(this.db);
    this.bankCredentials = new BankCredentialsRepository(this.db);
    this.bankAccounts = new BankAccountsRepository(this.db);
    this.bankTransactions = new BankTransactionsRepository(this.db);
    this.merchantRules = new MerchantRulesRepository(this.db);
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
