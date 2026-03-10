import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CategoryRepository } from './category.repository';

describe('CategoryRepository findFuzzyMatch', () => {
  let db: Database;
  let repo: CategoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    
    // Create tables
    db.run(`
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    repo = new CategoryRepository(db);
    
    // Create test categories
    repo.create({ group_id: 1, name: 'Продукты' });
    repo.create({ group_id: 1, name: 'Транспорт' });
    repo.create({ group_id: 1, name: 'Развлечения' });
    repo.create({ group_id: 1, name: 'Здоровье' });
  });

  afterEach(() => {
    db.close();
  });

  test('should find exact match (case-insensitive)', () => {
    const result = repo.findFuzzyMatch(1, 'Продукты');
    expect(result?.name).toBe('Продукты');

    const resultLower = repo.findFuzzyMatch(1, 'продукты');
    expect(resultLower?.name).toBe('Продукты');

    const resultUpper = repo.findFuzzyMatch(1, 'ПРОДУКТЫ');
    expect(resultUpper?.name).toBe('Продукты');
  });

  test('should handle extra spaces', () => {
    const result = repo.findFuzzyMatch(1, ' Продукты ');
    expect(result?.name).toBe('Продукты');
  });

  test('should find category containing input', () => {
    const result = repo.findFuzzyMatch(1, 'транс');
    expect(result?.name).toBe('Транспорт');
  });

  test('should find input containing category', () => {
    const result = repo.findFuzzyMatch(1, 'мой транспорт');
    expect(result?.name).toBe('Транспорт');
  });

  test('should return null for no match', () => {
    const result = repo.findFuzzyMatch(1, 'несуществующая');
    expect(result).toBeNull();
  });

  test('should return null for empty input', () => {
    const result = repo.findFuzzyMatch(1, '');
    expect(result).toBeNull();
  });

  test('should return null for non-existent group', () => {
    const result = repo.findFuzzyMatch(999, 'Продукты');
    expect(result).toBeNull();
  });

  test('should match with high similarity (above 0.9 threshold)', () => {
    // "Развлечения" (11 chars) vs "Развлечениа" (1 char diff) = 0.909 similarity
    const result = repo.findFuzzyMatch(1, 'Развлечениа');
    expect(result?.name).toBe('Развлечения');
  });

  test('should NOT match with low similarity (below 0.9 threshold)', () => {
    // "Продукты" (8 chars) vs "Продукта" (1 char diff) = 0.875 similarity
    const result = repo.findFuzzyMatch(1, 'Продукта');
    expect(result).toBeNull();
  });

  test('should only match categories from the same group', () => {
    // Create category for another group
    repo.create({ group_id: 2, name: 'Продукты' });
    
    const result = repo.findFuzzyMatch(2, 'Продукты');
    expect(result?.group_id).toBe(2);
  });
});
