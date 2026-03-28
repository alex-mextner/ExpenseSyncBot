// Maps groups to their per-year Google Spreadsheets

import type { Database } from 'bun:sqlite';

export class GroupSpreadsheetRepository {
  constructor(private db: Database) {}

  getByYear(groupId: number, year: number): string | null {
    const result = this.db
      .query<{ spreadsheet_id: string }, [number, number]>(
        'SELECT spreadsheet_id FROM group_spreadsheets WHERE group_id = ? AND year = ?',
      )
      .get(groupId, year);
    return result?.spreadsheet_id ?? null;
  }

  setYear(groupId: number, year: number, spreadsheetId: string): void {
    this.db
      .query<void, [number, number, string]>(
        'INSERT OR REPLACE INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (?, ?, ?)',
      )
      .run(groupId, year, spreadsheetId);
  }

  getCurrentYear(groupId: number): string | null {
    return this.getByYear(groupId, new Date().getFullYear());
  }

  listAll(groupId: number): { year: number; spreadsheetId: string }[] {
    return this.db
      .query<{ year: number; spreadsheet_id: string }, [number]>(
        'SELECT year, spreadsheet_id FROM group_spreadsheets WHERE group_id = ? ORDER BY year DESC',
      )
      .all(groupId)
      .map((r) => ({ year: r.year, spreadsheetId: r.spreadsheet_id }));
  }
}
