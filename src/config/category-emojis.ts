/**
 * Emoji mappings for common expense categories
 * Used in budget and expense displays
 */
export const CATEGORY_EMOJIS: Record<string, string> = {
  // Food & Dining
  Еда: '🍔',
  Продукты: '🛒',
  Ресторан: '🍽️',
  Кафе: '☕',
  Food: '🍔',
  Groceries: '🛒',
  Restaurant: '🍽️',
  Cafe: '☕',

  // Transportation
  Транспорт: '🚗',
  Такси: '🚕',
  Бензин: '⛽',
  Парковка: '🅿️',
  Transport: '🚗',
  Taxi: '🚕',
  Gas: '⛽',
  Parking: '🅿️',

  // Entertainment
  Развлечения: '🎮',
  Кино: '🎬',
  Игры: '🎯',
  Entertainment: '🎮',
  Movies: '🎬',
  Games: '🎯',

  // Health
  Здоровье: '💊',
  Аптека: '💊',
  Врач: '⚕️',
  Спорт: '⚽',
  Health: '💊',
  Pharmacy: '💊',
  Doctor: '⚕️',
  Sport: '⚽',
  Gym: '💪',

  // Shopping
  Одежда: '👕',
  Обувь: '👟',
  Покупки: '🛍️',
  Clothes: '👕',
  Shoes: '👟',
  Shopping: '🛍️',

  // Housing
  Жилье: '🏠',
  Аренда: '🏡',
  Коммуналка: '🔌',
  Ремонт: '🔧',
  Housing: '🏠',
  Rent: '🏡',
  Utilities: '🔌',
  Repair: '🔧',

  // Personal
  Личное: '👤',
  Подарки: '🎁',
  Красота: '💄',
  Personal: '👤',
  Gifts: '🎁',
  Beauty: '💄',

  // Education
  Образование: '📚',
  Книги: '📖',
  Курсы: '🎓',
  Education: '📚',
  Books: '📖',
  Courses: '🎓',

  // Technology
  Техника: '💻',
  Гаджеты: '📱',
  Софт: '💿',
  Tech: '💻',
  Gadgets: '📱',
  Software: '💿',

  // Travel
  Путешествия: '✈️',
  Отель: '🏨',
  Билеты: '🎫',
  Travel: '✈️',
  Hotel: '🏨',
  Tickets: '🎫',

  // Family & Kids
  Дети: '👶',
  Семья: '👨‍👩‍👧',
  Kids: '👶',
  Family: '👨‍👩‍👧',

  // Pets
  Питомцы: '🐾',
  Pets: '🐾',

  // Other
  Другое: '📦',
  Разное: '📦',
  Other: '📦',
  Misc: '📦',
};

/**
 * Get emoji for category name (case-insensitive)
 * Returns default emoji if category not found
 */
export function getCategoryEmoji(category: string): string {
  // Try exact match first
  if (CATEGORY_EMOJIS[category]) {
    return CATEGORY_EMOJIS[category];
  }

  // Try case-insensitive match
  const lowerCategory = category.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (key.toLowerCase() === lowerCategory) {
      return emoji;
    }
  }

  // Default emoji for unknown categories
  return '💰';
}
