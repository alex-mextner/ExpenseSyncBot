/**
 * Emoji mappings for common expense categories.
 * Category names in this project are user-defined per group, so this is just
 * a best-effort lookup for common Russian/English names. Unknown categories
 * fall back to the default emoji in getCategoryEmoji().
 *
 * Rule of thumb for what belongs here: realistic budget lines users actually
 * track (Каршеринг, Страховка, Мебель, Ветеринар). Not items or one-off
 * activities (Фрукты, Завтрак, Экскурсия) — those fall under broader
 * categories like "Продукты" or "Развлечения".
 */
export const CATEGORY_EMOJIS: Record<string, string> = {
  // Food & Dining
  Еда: '🍔',
  Продукты: '🛒',
  Кафе: '☕',
  Ресторан: '🍽️',
  Бар: '🍻',
  Кофе: '☕',
  Алкоголь: '🍷',
  Доставка: '🛵',
  Food: '🍔',
  Groceries: '🛒',
  Cafe: '☕',
  Restaurant: '🍽️',
  Bar: '🍻',
  Coffee: '☕',
  Alcohol: '🍷',
  Delivery: '🛵',

  // Transport
  Транспорт: '🚗',
  Такси: '🚕',
  Бензин: '⛽',
  Парковка: '🅿️',
  Авто: '🚗',
  Машина: '🚗',
  Автосервис: '🔧',
  Каршеринг: '🚙',
  Метро: '🚇',
  'Общественный транспорт': '🚌',
  Transport: '🚗',
  Taxi: '🚕',
  Gas: '⛽',
  Parking: '🅿️',
  Car: '🚗',
  CarService: '🔧',
  Carsharing: '🚙',
  Metro: '🚇',
  PublicTransport: '🚌',

  // Entertainment
  Развлечения: '🎮',
  Кино: '🎬',
  Игры: '🎯',
  Хобби: '🎨',
  Подписки: '🔄',
  Концерт: '🎤',
  Музыка: '🎵',
  Entertainment: '🎮',
  Movies: '🎬',
  Games: '🎯',
  Hobby: '🎨',
  Subscriptions: '🔄',
  Concert: '🎤',
  Music: '🎵',

  // Health
  Здоровье: '💊',
  Аптека: '💊',
  Врач: '⚕️',
  Стоматолог: '🦷',
  Спорт: '⚽',
  Фитнес: '💪',
  Health: '💊',
  Pharmacy: '💊',
  Doctor: '⚕️',
  Dentist: '🦷',
  Sport: '⚽',
  Fitness: '💪',
  Gym: '💪',

  // Shopping
  Одежда: '👕',
  Обувь: '👟',
  Покупки: '🛍️',
  Аксессуары: '👜',
  Clothes: '👕',
  Shoes: '👟',
  Shopping: '🛍️',
  Accessories: '👜',

  // Housing
  Жильё: '🏠',
  Жилье: '🏠',
  Дом: '🏠',
  Аренда: '🏡',
  Коммуналка: '💡',
  Ремонт: '🔧',
  Мебель: '🛋️',
  Хозтовары: '🧹',
  'Бытовая химия': '🧴',
  Housing: '🏠',
  Home: '🏠',
  Rent: '🏡',
  Utilities: '💡',
  Repair: '🔧',
  Furniture: '🛋️',
  Household: '🧹',

  // Personal
  Красота: '💄',
  Подарки: '🎁',
  Личное: '👤',
  Парикмахер: '💇',
  Салон: '💅',
  Beauty: '💄',
  Gifts: '🎁',
  Personal: '👤',
  Hairdresser: '💇',
  Salon: '💅',

  // Education
  Образование: '📚',
  Книги: '📖',
  Курсы: '🎓',
  Школа: '🏫',
  Университет: '🎓',
  Education: '📚',
  Books: '📖',
  Courses: '🎓',
  School: '🏫',
  University: '🎓',

  // Tech & Communication
  Техника: '💻',
  Гаджеты: '📱',
  Электроника: '🔌',
  Связь: '📱',
  Интернет: '🌐',
  Телефон: '📱',
  Tech: '💻',
  Gadgets: '📱',
  Electronics: '🔌',
  Mobile: '📱',
  Internet: '🌐',
  Phone: '📱',

  // Travel
  Путешествия: '✈️',
  Отель: '🏨',
  Travel: '✈️',
  Hotel: '🏨',

  // Family & Pets
  Дети: '👶',
  Семья: '👨‍👩‍👧',
  Игрушки: '🧸',
  Питомцы: '🐾',
  Ветеринар: '🐾',
  Kids: '👶',
  Family: '👨‍👩‍👧',
  Toys: '🧸',
  Pets: '🐾',
  Vet: '🐾',

  // Work & Finance
  Работа: '💼',
  Офис: '💼',
  Банк: '🏦',
  Налоги: '🧾',
  Страховка: '🛡️',
  Кредит: '💳',
  Инвестиции: '📈',
  Благотворительность: '❤️',
  Work: '💼',
  Office: '💼',
  Bank: '🏦',
  Taxes: '🧾',
  Insurance: '🛡️',
  Credit: '💳',
  Investments: '📈',
  Charity: '❤️',

  // Other
  Другое: '📦',
  Разное: '📦',
  'Без категории': '💰',
  Other: '📦',
  Misc: '📦',
  Uncategorized: '💰',
};

/** Default emoji returned when no match can be found. */
export const DEFAULT_CATEGORY_EMOJI = '💰';

/**
 * Look up emoji for a category name by exact (case-insensitive) match.
 * Returns null if no exact key matches — lets callers distinguish
 * "found" from "default fallback".
 */
function lookupExact(category: string): { emoji: string; key: string } | null {
  if (CATEGORY_EMOJIS[category]) {
    return { emoji: CATEGORY_EMOJIS[category], key: category };
  }

  const lowerCategory = category.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (key.toLowerCase() === lowerCategory) {
      return { emoji, key };
    }
  }

  return null;
}

/**
 * Synchronous emoji lookup by exact match. Falls back to the default emoji.
 * Used in hot paths (budget, sum commands) where async isn't practical.
 * For semantic fallback via HF, use resolveCategoryEmoji instead.
 */
export function getCategoryEmoji(category: string): string {
  return lookupExact(category)?.emoji ?? DEFAULT_CATEGORY_EMOJI;
}
