/**
 * Diagnostic script: test category emoji resolution against real production data.
 *
 * For each unique expense category in the DB, shows whether it gets an exact
 * emoji match or needs HF semantic matching. When HF_TOKEN is set, actually
 * calls the model and displays the matched key + cosine score.
 *
 * Outputs a full table with: category, count, expected emoji/key (from the
 * expectations map below), actual result, and match/mismatch status.
 *
 * Usage (on server):
 *   bun run scripts/test-emoji-resolution.ts
 *   bun run scripts/test-emoji-resolution.ts --dry-run   # skip HF calls
 */
import { Database } from 'bun:sqlite';
import { InferenceClient } from '@huggingface/inference';
import {
  CATEGORY_EMOJIS,
  DEFAULT_CATEGORY_EMOJI,
  getCategoryEmoji,
} from '../src/config/category-emojis';

const SIMILARITY_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const SIMILARITY_THRESHOLD = 0.5;

// ──────────────────────────────────────────────────────────────────────
// Expectations table: category → { emoji, matchedKey } we expect the
// resolver to produce. For exact matches matchedKey equals the category
// itself. For HF matches it's the closest known key we anticipate.
// Add new entries here as real prod categories evolve.
// ──────────────────────────────────────────────────────────────────────
const EXPECTATIONS: Record<string, { emoji: string; key: string }> = {
  // Exact matches (category name exists verbatim in CATEGORY_EMOJIS)
  Продукты: { emoji: '🛒', key: 'Продукты' },
  Транспорт: { emoji: '🚗', key: 'Транспорт' },
  Здоровье: { emoji: '💊', key: 'Здоровье' },
  Развлечения: { emoji: '🎮', key: 'Развлечения' },
  Кафе: { emoji: '☕', key: 'Кафе' },
  Ресторан: { emoji: '🍽️', key: 'Ресторан' },
  Такси: { emoji: '🚕', key: 'Такси' },
  Одежда: { emoji: '👕', key: 'Одежда' },
  Подписки: { emoji: '🔄', key: 'Подписки' },
  Аптека: { emoji: '💊', key: 'Аптека' },
  Красота: { emoji: '💄', key: 'Красота' },
  Подарки: { emoji: '🎁', key: 'Подарки' },
  Коммуналка: { emoji: '💡', key: 'Коммуналка' },
  Бензин: { emoji: '⛽', key: 'Бензин' },
  Каршеринг: { emoji: '🚙', key: 'Каршеринг' },
  Алкоголь: { emoji: '🍷', key: 'Алкоголь' },
  Доставка: { emoji: '🛵', key: 'Доставка' },
  Образование: { emoji: '📚', key: 'Образование' },
  Фитнес: { emoji: '💪', key: 'Фитнес' },
  Путешествия: { emoji: '✈️', key: 'Путешествия' },
  'Без категории': { emoji: '💰', key: 'Без категории' },

  // HF semantic matches (category not in CATEGORY_EMOJIS, resolved via model)
  'Еда вне дома': { emoji: '🍔', key: 'Еда' },
  Настолки: { emoji: '🎯', key: 'Игры' },
  Стриминг: { emoji: '🔄', key: 'Подписки' },
  Маршрутка: { emoji: '🚌', key: 'Общественный транспорт' },
  Зубной: { emoji: '🦷', key: 'Стоматолог' },
  Уборка: { emoji: '🧹', key: 'Хозтовары' },
  Косметика: { emoji: '💄', key: 'Красота' },
  Бассейн: { emoji: '💪', key: 'Фитнес' },
  'Корм для кота': { emoji: '🐾', key: 'Питомцы' },
  Подкасты: { emoji: '🔄', key: 'Подписки' },
  Коворкинг: { emoji: '💼', key: 'Работа' },
  Самокат: { emoji: '🚗', key: 'Транспорт' },
  Витамины: { emoji: '💊', key: 'Аптека' },
  Кальян: { emoji: '🍻', key: 'Бар' },
  Цветы: { emoji: '🎁', key: 'Подарки' },
  Штрафы: { emoji: '🧾', key: 'Налоги' },
  Донаты: { emoji: '❤️', key: 'Благотворительность' },
};

// ──────────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');
const dbPath = process.env['DATABASE_PATH'] || './data/expenses.db';

const db = new Database(dbPath, { readonly: true });

interface CategoryRow {
  category: string;
  cnt: number;
}

const rows = db
  .query<CategoryRow, []>(
    'SELECT DISTINCT category, COUNT(*) as cnt FROM expenses GROUP BY category ORDER BY cnt DESC',
  )
  .all();

if (rows.length === 0) {
  console.log('\n  No expenses in DB.\n');
  process.exit(0);
}

const keys = Object.keys(CATEGORY_EMOJIS);
const token = process.env['HF_TOKEN'];
const client = token && !dryRun ? new InferenceClient(token) : null;

// ── Resolve every category ──────────────────────────────────────────

interface ResolvedCategory {
  category: string;
  count: number;
  method: 'exact' | 'hf' | 'default' | 'skip';
  emoji: string;
  matchedKey: string | null;
  score: number | null;
}

const results: ResolvedCategory[] = [];

for (const { category, cnt } of rows) {
  const exact = getCategoryEmoji(category);

  if (exact !== DEFAULT_CATEGORY_EMOJI) {
    results.push({
      category,
      count: cnt,
      method: 'exact',
      emoji: exact,
      matchedKey: category,
      score: null,
    });
    continue;
  }

  if (!client) {
    results.push({
      category,
      count: cnt,
      method: 'skip',
      emoji: DEFAULT_CATEGORY_EMOJI,
      matchedKey: null,
      score: null,
    });
    continue;
  }

  try {
    const scores = await client.sentenceSimilarity({
      model: SIMILARITY_MODEL,
      inputs: { source_sentence: category, sentences: keys },
    });

    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      if (typeof s === 'number' && s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore >= SIMILARITY_THRESHOLD) {
      const key = keys[bestIdx] ?? '';
      results.push({
        category,
        count: cnt,
        method: 'hf',
        emoji: CATEGORY_EMOJIS[key] ?? DEFAULT_CATEGORY_EMOJI,
        matchedKey: key,
        score: bestScore,
      });
    } else {
      results.push({
        category,
        count: cnt,
        method: 'default',
        emoji: DEFAULT_CATEGORY_EMOJI,
        matchedKey: null,
        score: bestScore,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ HF error for "${category}": ${msg}`);
    results.push({
      category,
      count: cnt,
      method: 'default',
      emoji: DEFAULT_CATEGORY_EMOJI,
      matchedKey: null,
      score: null,
    });
  }
}

db.close();

// ── Print full table ────────────────────────────────────────────────

const COL = {
  cat: 'Category',
  cnt: 'Count',
  method: 'Method',
  actual: 'Actual',
  key: 'Matched Key',
  score: 'Score',
  expected: 'Expected',
  status: 'Status',
};

// Calculate column widths
const catW = Math.max(COL.cat.length, ...results.map((r) => r.category.length));
const cntW = Math.max(COL.cnt.length, ...results.map((r) => String(r.count).length));
const methodW = Math.max(COL.method.length, 7);
const actualW = Math.max(COL.actual.length, 4);
const keyW = Math.max(COL.key.length, ...results.map((r) => (r.matchedKey ?? '—').length));
const scoreW = Math.max(COL.score.length, 5);
const expectedW = Math.max(COL.expected.length, 10);
const statusW = Math.max(COL.status.length, 4);

function pad(s: string, w: number): string {
  return s.padEnd(w);
}
function rpad(s: string, w: number): string {
  return s.padStart(w);
}

const sep = `${'─'.repeat(catW + 2)}┼${'─'.repeat(cntW + 2)}┼${'─'.repeat(methodW + 2)}┼${'─'.repeat(actualW + 2)}┼${'─'.repeat(keyW + 2)}┼${'─'.repeat(scoreW + 2)}┼${'─'.repeat(expectedW + 2)}┼${'─'.repeat(statusW + 2)}`;

console.log(`\n=== Emoji Resolution Report (${results.length} categories) ===\n`);

// Header
console.log(
  ` ${pad(COL.cat, catW)} │ ${rpad(COL.cnt, cntW)} │ ${pad(COL.method, methodW)} │ ${pad(COL.actual, actualW)} │ ${pad(COL.key, keyW)} │ ${rpad(COL.score, scoreW)} │ ${pad(COL.expected, expectedW)} │ ${pad(COL.status, statusW)} `,
);
console.log(sep);

let matchCount = 0;
let mismatchCount = 0;
let unknownCount = 0;

for (const r of results) {
  const exp = EXPECTATIONS[r.category];
  let expectedStr: string;
  let statusStr: string;

  if (!exp) {
    expectedStr = '?';
    statusStr = '—';
    unknownCount++;
  } else if (r.emoji === exp.emoji) {
    expectedStr = `${exp.emoji} ${exp.key}`;
    statusStr = '✅';
    matchCount++;
  } else {
    expectedStr = `${exp.emoji} ${exp.key}`;
    statusStr = '❌';
    mismatchCount++;
  }

  const scoreStr = r.score !== null ? r.score.toFixed(3) : '—';

  console.log(
    ` ${pad(r.category, catW)} │ ${rpad(String(r.count), cntW)} │ ${pad(r.method, methodW)} │ ${pad(r.emoji, actualW)} │ ${pad(r.matchedKey ?? '—', keyW)} │ ${rpad(scoreStr, scoreW)} │ ${pad(expectedStr, expectedW)} │ ${pad(statusStr, statusW)} `,
  );
}

// ── Summary ─────────────────────────────────────────────────────────

const exactCount = results.filter((r) => r.method === 'exact').length;
const hfCount = results.filter((r) => r.method === 'hf').length;
const defaultCount = results.filter((r) => r.method === 'default').length;
const skipCountVal = results.filter((r) => r.method === 'skip').length;

console.log(`\n=== Summary ===`);
console.log(`  Total categories: ${results.length}`);
console.log(`  Exact match:      ${exactCount}`);
if (client) {
  console.log(`  HF matched:       ${hfCount}`);
  console.log(`  HF miss (default):${defaultCount}`);
} else {
  console.log(`  Skipped (${dryRun ? 'dry-run' : 'no HF_TOKEN'}): ${skipCountVal}`);
}
console.log();
console.log(`  vs expectations:`);
console.log(`    ✅ Match:    ${matchCount}`);
console.log(`    ❌ Mismatch: ${mismatchCount}`);
console.log(`    — Unknown:   ${unknownCount} (not in expectations table)`);
console.log();
