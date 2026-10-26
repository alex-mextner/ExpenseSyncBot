// Shape of one schema migration. `up` receives the database instead of closing over it so a
// migration can live in its own module, apart from the runner in ../schema.ts.
import type { Database } from 'bun:sqlite';

export interface Migration {
  name: string;
  up: (db: Database) => void;
}
