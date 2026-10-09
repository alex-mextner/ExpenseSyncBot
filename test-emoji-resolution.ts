/** Self-contained prod diagnostic — inlines CATEGORY_EMOJIS from the PR branch
 *  so it can run against the prod DB without checking out the branch. */
import { Database } from 'bun:sqlite';
import { InferenceClient } from '@huggingface/inference';

const SIMILARITY_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const SIMILARITY_THRESHOLD = 0.5;

const CATEGORY_EMOJIS: Record<string, string> = {
  // Food & Dining
  Еда: '🍔', Продукты: '🛒', Кафе: '☕', Ресторан: '🍽️', Бар: '🍻', Кофе: '☕', Алкоголь: '🍷', Доставка: '🛵',
  Food: '🍔', Groceries: '🛒', Cafe: '☕', Restaurant: '🍽️', Bar: '🍻', Coffee: '☕', Alcohol: '🍷', Delivery: '🛵',
  // Transport
  Транспорт: '🚗', Такси: '🚕', Бензин: '⛽', Парковка: '🅿️', Авто: '🚗', Машина: '🚗', Автосервис: '🔧',
  Каршеринг: '🚙', Метро: '🚇', 'Общественный транспорт': '🚌',
  Transport: '🚗', Taxi: '🚕', Gas: '⛽', Parking: '🅿️', Car: '🚗', CarService: '🔧', Carsharing: '🚙',
  Metro: '🚇', PublicTransport: '🚌',
  // Entertainment
  Развлечения: '🎮', Кино: '🎬', Игры: '🎯', Хобби: '🎨', Подписки: '🔄', Концерт: '🎤', Музыка: '🎵',
  Entertainment: '🎮', Movies: '🎬', Games: '🎯', Hobby: '🎨', Subscriptions: '🔄', Concert: '🎤', Music: '🎵',
  // Health
  Здоровье: '💊', Аптека: '💊', Врач: '⚕️', Стоматолог: '🦷', Спорт: '⚽', Фитнес: '💪',
  Health: '💊', Pharmacy: '💊', Doctor: '⚕️', Dentist: '🦷', Sport: '⚽', Fitness: '💪', Gym: '💪',
  // Shopping
  Одежда: '👕', Обувь: '👟', Покупки: '🛍️', Аксессуары: '👜',
  Clothes: '👕', Shoes: '👟', Shopping: '🛍️', Accessories: '👜',
  // Housing
  Жильё: '🏠', Жилье: '🏠', Дом: '🏠', Аренда: '🏡', Коммуналка: '💡', Ремонт: '🔧', Мебель: '🛋️',
  Хозтовары: '🧹', 'Бытовая химия': '🧴',
  Housing: '🏠', Home: '🏠', Rent: '🏡', Utilities: '💡', Repair: '🔧', Furniture: '🛋️', Household: '🧹',
  // Personal
  Красота: '💄', Подарки: '🎁', Личное: '👤', Парикмахер: '💇', Салон: '💅',
  Beauty: '💄', Gifts: '🎁', Personal: '👤', Hairdresser: '💇', Salon: '💅',
  // Education
  Образование: '📚', Книги: '📖', Курсы: '🎓', Школа: '🏫', Университет: '🎓',
  Education: '📚', Books: '📖', Courses: '🎓', School: '🏫', University: '🎓',
  // Tech
  Техника: '💻', Гаджеты: '📱', Электроника: '🔌', Связь: '📱', Интернет: '🌐', Телефон: '📱',
  Tech: '💻', Gadgets: '📱', Electronics: '🔌', Mobile: '📱', Internet: '🌐', Phone: '📱',
  // Travel
  Путешествия: '✈️', Отель: '🏨', Travel: '✈️', Hotel: '🏨',
  // Family & Pets
  Дети: '👶', Семья: '👨‍👩‍👧', Игрушки: '🧸', Питомцы: '🐾', Ветеринар: '🐾',
  Kids: '👶', Family: '👨‍👩‍👧', Toys: '🧸', Pets: '🐾', Vet: '🐾',
  // Work & Finance
  Работа: '💼', Офис: '💼', Банк: '🏦', Налоги: '🧾', Страховка: '🛡️', Кредит: '💳', Инвестиции: '📈',
  Благотворительность: '❤️',
  Work: '💼', Office: '💼', Bank: '🏦', Taxes: '🧾', Insurance: '🛡️', Credit: '💳', Investments: '📈', Charity: '❤️',
  // Other
  Другое: '📦', Разное: '📦', 'Без категории': '💰', Other: '📦', Misc: '📦', Uncategorized: '💰',
};

const DEFAULT_CATEGORY_EMOJI = '💰';

function lookupExact(category: string): string | null {
  if (CATEGORY_EMOJIS[category]) return CATEGORY_EMOJIS[category];
  const lower = category.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (key.toLowerCase() === lower) return emoji;
  }
  return null;
}

const dryRun = process.argv.includes('--dry-run');
const dbPath = process.env['DATABASE_PATH'] || '/var/www/ExpenseSyncBot/data/expenses.db';
const db = new Database(dbPath, { readonly: true });

interface Row { category: string; cnt: number; }
const rows = db.query<Row, []>(
  'SELECT DISTINCT category, COUNT(*) as cnt FROM expenses GROUP BY category ORDER BY cnt DESC',
).all();

if (rows.length === 0) {
  console.log('\n  No expenses in DB.\n');
  process.exit(0);
}

const keys = Object.keys(CATEGORY_EMOJIS);
const token = process.env['HF_TOKEN'];
const client = token && !dryRun ? new InferenceClient(token) : null;

interface Resolved {
  category: string; count: number;
  method: 'exact' | 'hf' | 'default' | 'skip';
  emoji: string; matchedKey: string | null; score: number | null;
}

const results: Resolved[] = [];

for (const { category, cnt } of rows) {
  const exact = lookupExact(category);
  if (exact) {
    results.push({ category, count: cnt, method: 'exact', emoji: exact, matchedKey: category, score: null });
    continue;
  }
  if (!client) {
    results.push({ category, count: cnt, method: 'skip', emoji: DEFAULT_CATEGORY_EMOJI, matchedKey: null, score: null });
    continue;
  }
  try {
    const scores = await client.sentenceSimilarity({
      model: SIMILARITY_MODEL,
      inputs: { source_sentence: category, sentences: keys },
    });
    let bestIdx = -1, bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      if (typeof s === 'number' && s > bestScore) { bestScore = s; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestScore >= SIMILARITY_THRESHOLD) {
      const key = keys[bestIdx] ?? '';
      results.push({ category, count: cnt, method: 'hf', emoji: CATEGORY_EMOJIS[key] ?? DEFAULT_CATEGORY_EMOJI, matchedKey: key, score: bestScore });
    } else {
      results.push({ category, count: cnt, method: 'default', emoji: DEFAULT_CATEGORY_EMOJI, matchedKey: null, score: bestScore });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ HF error for "${category}": ${msg}`);
    results.push({ category, count: cnt, method: 'default', emoji: DEFAULT_CATEGORY_EMOJI, matchedKey: null, score: null });
  }
}
db.close();

const catW = Math.max(8, ...results.map((r) => [...r.category].length));
const cntW = Math.max(5, ...results.map((r) => String(r.count).length));

console.log(`\n=== Emoji Resolution Report (${results.length} categories from prod) ===\n`);
console.log(` ${'Category'.padEnd(catW)} │ ${'Count'.padStart(cntW)} │ Method  │ Actual │ Matched Key              │ Score `);
console.log(`${'─'.repeat(catW + 2)}┼${'─'.repeat(cntW + 2)}┼─────────┼────────┼──────────────────────────┼───────`);

for (const r of results) {
  const catPad = [...r.category].length < catW ? r.category + ' '.repeat(catW - [...r.category].length) : r.category;
  const scoreStr = r.score !== null ? r.score.toFixed(3) : '—';
  console.log(` ${catPad} │ ${String(r.count).padStart(cntW)} │ ${r.method.padEnd(7)} │ ${r.emoji.padEnd(6)} │ ${(r.matchedKey ?? '—').padEnd(24)} │ ${scoreStr.padStart(5)} `);
}

const exactN = results.filter((r) => r.method === 'exact').length;
const hfN = results.filter((r) => r.method === 'hf').length;
const defaultN = results.filter((r) => r.method === 'default').length;
const skipN = results.filter((r) => r.method === 'skip').length;

console.log(`\n=== Summary ===`);
console.log(`  Total:       ${results.length}`);
console.log(`  Exact:       ${exactN}`);
if (client) {
  console.log(`  HF matched:  ${hfN}`);
  console.log(`  HF miss:     ${defaultN}`);
} else {
  console.log(`  Skipped:     ${skipN} (${dryRun ? 'dry-run' : 'no HF_TOKEN'})`);
}
console.log();
