/**
 * Currency codes and their aliases
 */
export const CURRENCY_ALIASES: Record<string, string> = {
  // Dollar variants
  $: 'USD',
  д: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  usd: 'USD',
  усд: 'USD',
  дол: 'USD',
  доллар: 'USD',
  долларов: 'USD',
  доллара: 'USD',

  // Euro variants
  '€': 'EUR',
  е: 'EUR',
  euro: 'EUR',
  евро: 'EUR',
  eur: 'EUR',
  еур: 'EUR',

  // Ruble variants
  '₽': 'RUB',
  р: 'RUB',
  руб: 'RUB',
  рубль: 'RUB',
  рублей: 'RUB',
  рубля: 'RUB',
  rub: 'RUB',
  ruble: 'RUB',
  rubles: 'RUB',
  раб: 'RUB',

  // Serbian Dinar
  rsd: 'RSD',
  рсд: 'RSD',
  дин: 'RSD',
  динар: 'RSD',
  динара: 'RSD',
  динаров: 'RSD',

  // Pound
  '£': 'GBP',
  gbp: 'GBP',
  гбп: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  фунт: 'GBP',
  фунтов: 'GBP',
  фунта: 'GBP',

  // Belarusian Ruble
  byn: 'BYN',
  б: 'BYN',
  бр: 'BYN',
  бел: 'BYN',
  'белорусский рубль': 'BYN',
  'б rub': 'BYN',
  br: 'BYN',

  // Other common currencies
  chf: 'CHF',
  чф: 'CHF',
  шф: 'CHF',
  jpy: 'JPY',
  йпй: 'JPY',
  иена: 'JPY',
  иен: 'JPY',
  иены: 'JPY',
  cny: 'CNY',
  цни: 'CNY',
  юань: 'CNY',
  юаней: 'CNY',
  юаня: 'CNY',
  inr: 'INR',
  инр: 'INR',
  рупия: 'INR',
  рупий: 'INR',
  рупии: 'INR',

  // Sri Lankan Rupee
  lkr: 'LKR',
  лкр: 'LKR',

  // UAE Dirham
  aed: 'AED',
  аед: 'AED',
  дирхам: 'AED',
  дирхама: 'AED',
  дирхамов: 'AED',
};

/**
 * Supported currency codes
 */
export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'RUB',
  'RSD',
  'GBP',
  'BYN',
  'CHF',
  'JPY',
  'CNY',
  'INR',
  'LKR',
  'AED',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Currency symbols for display
 */
export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  EUR: '€',
  RUB: '₽',
  RSD: 'RSD',
  GBP: '£',
  BYN: 'Br',
  CHF: 'CHF',
  JPY: '¥',
  CNY: '¥',
  INR: '₹',
  LKR: 'LKR',
  AED: 'AED',
};

/**
 * Google API Scopes
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Default spreadsheet configuration
 */
export const SPREADSHEET_CONFIG = {
  sheetName: 'Expenses',
  headers: ['Дата', 'Категория', 'Комментарий'] as const,
  eurColumnHeader: 'EUR (calc)',
};

/**
 * Bot messages
 */
export const MESSAGES = {
  welcome:
    '👋 Привет! Я помогу тебе вести учет расходов в Google Таблице.\n\n' +
    'Для начала работы нужно:\n' +
    '1. Подключить Google аккаунт\n' +
    '2. Выбрать валюты для учета\n\n' +
    'Нажми /connect чтобы начать.',

  authSuccess: '✅ Google аккаунт подключен!\n\n' + 'Теперь выбери валюту по умолчанию:',

  setupComplete:
    '🎉 Настройка завершена!\n\n' +
    'Таблица создана: {spreadsheetUrl}\n\n' +
    'Теперь просто отправляй расходы в формате:\n' +
    '190 евро Алекс кулёма\n' +
    '100$ еда обед в ресторане\n' +
    '1900 RSD транспорт такси\n' +
    '10*3$ еда пицца за троих\n\n' +
    '/help — все возможности бота',

  expenseParsed:
    '💰 Расход распознан:\n' +
    '• Сумма: {amount} {currency}\n' +
    '• Категория: {category}\n' +
    '• Комментарий: {comment}',

  newCategoryDetected: '❓ Категория "{category}" новая.\n\n' + 'Что делать?',

  categoryAdded: '✅ Категория "{category}" добавлена',

  expenseSaved: '✅ Расход сохранен в таблицу',

  error: '❌ Произошла ошибка: {error}',

  invalidFormat:
    '❌ Не могу распознать формат.\n\n' +
    'Примеры правильного формата:\n' +
    '• 190 евро Алекс кулёма\n' +
    '• 100$ еда обед\n' +
    '• 1900 RSD транспорт такси\n' +
    '• 10*3$ еда пицца за троих',
};

/**
 * Inline keyboard texts
 */
export const KEYBOARD_TEXTS = {
  addNewCategory: '➕ Добавить новую категорию',
  selectExistingCategory: '📋 Выбрать из существующих',
  skip: '⏭️ Пропустить',
  cancel: '❌ Отмена',
  done: '✅ Готово',
  next: '✅ Далее',
};
