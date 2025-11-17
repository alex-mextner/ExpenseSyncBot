import type { Database } from 'bun:sqlite';
import type { Category, CreateCategoryData } from '../types';

export class CategoryRepository {
  constructor(private db: Database) {}

  /**
   * Find all categories for a group
   */
  findByGroupId(groupId: number): Category[] {
    const query = this.db.query<Category, [number]>(`
      SELECT * FROM categories
      WHERE group_id = ?
      ORDER BY name ASC
    `);

    return query.all(groupId);
  }

  /**
   * Find category by name for a group
   */
  findByName(groupId: number, name: string): Category | null {
    const query = this.db.query<Category, [number, string]>(`
      SELECT * FROM categories
      WHERE group_id = ? AND LOWER(name) = LOWER(?)
    `);

    return query.get(groupId, name) || null;
  }

  /**
   * Normalize category name - capitalize first letter
   */
  private normalizeCategory(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return trimmed;
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  }

  /**
   * Create new category
   */
  create(data: CreateCategoryData): Category {
    // Normalize category name
    const normalizedName = this.normalizeCategory(data.name);

    // Check if category already exists
    const existing = this.findByName(data.group_id, normalizedName);

    if (existing) {
      return existing;
    }

    const query = this.db.query<{ id: number }, [number, string]>(`
      INSERT INTO categories (group_id, name)
      VALUES (?, ?)
      RETURNING id
    `);

    const result = query.get(data.group_id, normalizedName);

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
   * Check if category exists for group
   */
  exists(groupId: number, name: string): boolean {
    return this.findByName(groupId, name) !== null;
  }

  /**
   * Get category names for group (for autocomplete)
   */
  getCategoryNames(groupId: number): string[] {
    const categories = this.findByGroupId(groupId);
    return categories.map(c => c.name);
  }
}
