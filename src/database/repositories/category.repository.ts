import type { Database } from 'bun:sqlite';
import type { Category, CreateCategoryData } from '../types';

export class CategoryRepository {
  constructor(private db: Database) {}

  /**
   * Find all categories for a user
   */
  findByUserId(userId: number): Category[] {
    const query = this.db.query<Category, [number]>(`
      SELECT * FROM categories
      WHERE user_id = ?
      ORDER BY name ASC
    `);

    return query.all(userId);
  }

  /**
   * Find category by name for a user
   */
  findByName(userId: number, name: string): Category | null {
    const query = this.db.query<Category, [number, string]>(`
      SELECT * FROM categories
      WHERE user_id = ? AND LOWER(name) = LOWER(?)
    `);

    return query.get(userId, name) || null;
  }

  /**
   * Create new category
   */
  create(data: CreateCategoryData): Category {
    // Check if category already exists
    const existing = this.findByName(data.user_id, data.name);

    if (existing) {
      return existing;
    }

    const query = this.db.query<{ id: number }, [number, string]>(`
      INSERT INTO categories (user_id, name)
      VALUES (?, ?)
      RETURNING id
    `);

    const result = query.get(data.user_id, data.name);

    if (!result) {
      throw new Error('Failed to create category');
    }

    const category = this.findById(result.id);

    if (!category) {
      throw new Error('Failed to retrieve created category');
    }

    return category;
  }

  /**
   * Find category by ID
   */
  findById(id: number): Category | null {
    const query = this.db.query<Category, [number]>(`
      SELECT * FROM categories WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Delete category
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM categories WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Check if category exists for user
   */
  exists(userId: number, name: string): boolean {
    return this.findByName(userId, name) !== null;
  }

  /**
   * Get category names for user (for autocomplete)
   */
  getCategoryNames(userId: number): string[] {
    const categories = this.findByUserId(userId);
    return categories.map(c => c.name);
  }
}
