// Every migration in the order it must run. Order is the contract with already-migrated
// databases (the runner applies whatever is missing from the `migrations` table, in this order):
// never reorder, rename or edit shipped entries — append new migrations at the end.
import { aiTrajectoryAndUsageMigrations } from './ai-trajectories-and-usage';
import { analyticsAndDevTaskMigrations } from './analytics-and-dev-tasks';
import { bankIntegrationMigrations } from './bank-integration';
import { coreTableMigrations } from './core-tables';
import { groupMemberAndReceiptMigrations } from './group-members-and-receipts';
import { photoQueueAndReceiptItemMigrations } from './photo-queue-and-receipt-items';
import { snapshotAndDataFixMigrations } from './snapshots-and-data-fixes';
import type { Migration } from './types';

export const migrations: Migration[] = [
  ...coreTableMigrations,
  ...photoQueueAndReceiptItemMigrations,
  ...analyticsAndDevTaskMigrations,
  ...bankIntegrationMigrations,
  ...snapshotAndDataFixMigrations,
  ...groupMemberAndReceiptMigrations,
  ...aiTrajectoryAndUsageMigrations,
];
