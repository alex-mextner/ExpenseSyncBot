/**
 * Currency metadata: names, symbols, and common shortcuts for display and hints
 */
export interface CurrencyInfo {
  code: string;
  symbol: string;
  nameRu: string;
  nameEn: string;
  /** Common shortcuts users can type instead of the full code */
  shortcuts: string[];
}

export const CURRENCY_INFO: Record<string, CurrencyInfo> = {
  USD: {
    code: 'USD',
    symbol: '$',
    nameRu: 'Доллар США',
    nameEn: 'US Dollar',
    shortcuts: ['$', 'д', 'дол'],
  },
  EUR: { code: 'EUR', symbol: '€', nameRu: 'Евро', nameEn: 'Euro', shortcuts: ['€', 'е', 'евро'] },
  RUB: {
    code: 'RUB',
    symbol: '₽',
    nameRu: 'Российский рубль',
    nameEn: 'Russian Ruble',
    shortcuts: ['₽', 'р', 'руб'],
  },
  RSD: {
    code: 'RSD',
    symbol: 'RSD',
    nameRu: 'Сербский динар',
    nameEn: 'Serbian Dinar',
    shortcuts: ['дин', 'динар'],
  },
  GBP: {
    code: 'GBP',
    symbol: '£',
    nameRu: 'Фунт стерлингов',
    nameEn: 'British Pound',
    shortcuts: ['£', 'фунт'],
  },
  BYN: {
    code: 'BYN',
    symbol: 'Br',
    nameRu: 'Белорусский рубль',
    nameEn: 'Belarusian Ruble',
    shortcuts: ['бр', 'б', 'бел'],
  },
  CHF: {
    code: 'CHF',
    symbol: 'CHF',
    nameRu: 'Швейцарский франк',
    nameEn: 'Swiss Franc',
    shortcuts: ['франк'],
  },
  JPY: {
    code: 'JPY',
    symbol: '¥',
    nameRu: 'Японская иена',
    nameEn: 'Japanese Yen',
    shortcuts: ['¥', 'иена', 'иен'],
  },
  CNY: {
    code: 'CNY',
    symbol: '¥',
    nameRu: 'Китайский юань',
    nameEn: 'Chinese Yuan',
    shortcuts: ['юань', 'юаней'],
  },
  INR: {
    code: 'INR',
    symbol: '₹',
    nameRu: 'Индийская рупия',
    nameEn: 'Indian Rupee',
    shortcuts: ['₹', 'рупия'],
  },
  LKR: {
    code: 'LKR',
    symbol: 'LKR',
    nameRu: 'Шри-ланкийская рупия',
    nameEn: 'Sri Lankan Rupee',
    shortcuts: [],
  },
  AED: {
    code: 'AED',
    symbol: 'AED',
    nameRu: 'Дирхам ОАЭ',
    nameEn: 'UAE Dirham',
    shortcuts: ['дирхам'],
  },
  GEL: {
    code: 'GEL',
    symbol: '₾',
    nameRu: 'Грузинский лари',
    nameEn: 'Georgian Lari',
    shortcuts: ['лари'],
  },
  KZT: {
    code: 'KZT',
    symbol: '₸',
    nameRu: 'Казахстанский тенге',
    nameEn: 'Kazakhstani Tenge',
    shortcuts: ['тенге'],
  },
  AMD: {
    code: 'AMD',
    symbol: '֏',
    nameRu: 'Армянский драм',
    nameEn: 'Armenian Dram',
    shortcuts: ['драм'],
  },
  UAH: {
    code: 'UAH',
    symbol: '₴',
    nameRu: 'Украинская гривна',
    nameEn: 'Ukrainian Hryvnia',
    shortcuts: ['₴', 'грн', 'гривна'],
  },
  UZS: {
    code: 'UZS',
    symbol: 'UZS',
    nameRu: 'Узбекский сум',
    nameEn: 'Uzbekistani Som',
    shortcuts: ['сум'],
  },
  AZN: {
    code: 'AZN',
    symbol: '₼',
    nameRu: 'Азербайджанский манат',
    nameEn: 'Azerbaijani Manat',
    shortcuts: ['₼', 'манат'],
  },
  TRY: {
    code: 'TRY',
    symbol: '₺',
    nameRu: 'Турецкая лира',
    nameEn: 'Turkish Lira',
    shortcuts: ['₺', 'лира'],
  },
  ILS: {
    code: 'ILS',
    symbol: '₪',
    nameRu: 'Израильский шекель',
    nameEn: 'Israeli Shekel',
    shortcuts: ['₪', 'шекель'],
  },
  PLN: {
    code: 'PLN',
    symbol: 'zł',
    nameRu: 'Польский злотый',
    nameEn: 'Polish Zloty',
    shortcuts: ['zł', 'злотый'],
  },
  CZK: {
    code: 'CZK',
    symbol: 'Kč',
    nameRu: 'Чешская крона',
    nameEn: 'Czech Koruna',
    shortcuts: ['крона'],
  },
  HUF: {
    code: 'HUF',
    symbol: 'Ft',
    nameRu: 'Венгерский форинт',
    nameEn: 'Hungarian Forint',
    shortcuts: ['форинт'],
  },
  RON: {
    code: 'RON',
    symbol: 'lei',
    nameRu: 'Румынский лей',
    nameEn: 'Romanian Leu',
    shortcuts: ['лей'],
  },
  BGN: {
    code: 'BGN',
    symbol: 'лв',
    nameRu: 'Болгарский лев',
    nameEn: 'Bulgarian Lev',
    shortcuts: ['лев'],
  },
  HRK: {
    code: 'HRK',
    symbol: 'kn',
    nameRu: 'Хорватская куна',
    nameEn: 'Croatian Kuna',
    shortcuts: ['куна'],
  },
  MKD: {
    code: 'MKD',
    symbol: 'ден',
    nameRu: 'Македонский денар',
    nameEn: 'Macedonian Denar',
    shortcuts: ['денар'],
  },
  BAM: {
    code: 'BAM',
    symbol: 'KM',
    nameRu: 'Боснийская марка',
    nameEn: 'Bosnian Mark',
    shortcuts: ['марка'],
  },
  THB: { code: 'THB', symbol: '฿', nameRu: 'Тайский бат', nameEn: 'Thai Baht', shortcuts: ['бат'] },
  SGD: {
    code: 'SGD',
    symbol: 'S$',
    nameRu: 'Сингапурский доллар',
    nameEn: 'Singapore Dollar',
    shortcuts: [],
  },
  HKD: {
    code: 'HKD',
    symbol: 'HK$',
    nameRu: 'Гонконгский доллар',
    nameEn: 'Hong Kong Dollar',
    shortcuts: [],
  },
  KRW: {
    code: 'KRW',
    symbol: '₩',
    nameRu: 'Южнокорейская вона',
    nameEn: 'South Korean Won',
    shortcuts: ['₩', 'вона'],
  },
  BRL: {
    code: 'BRL',
    symbol: 'R$',
    nameRu: 'Бразильский реал',
    nameEn: 'Brazilian Real',
    shortcuts: ['реал'],
  },
  MXN: {
    code: 'MXN',
    symbol: 'MX$',
    nameRu: 'Мексиканское песо',
    nameEn: 'Mexican Peso',
    shortcuts: ['песо'],
  },
  CAD: {
    code: 'CAD',
    symbol: 'C$',
    nameRu: 'Канадский доллар',
    nameEn: 'Canadian Dollar',
    shortcuts: [],
  },
  AUD: {
    code: 'AUD',
    symbol: 'A$',
    nameRu: 'Австралийский доллар',
    nameEn: 'Australian Dollar',
    shortcuts: [],
  },
  NZD: {
    code: 'NZD',
    symbol: 'NZ$',
    nameRu: 'Новозеландский доллар',
    nameEn: 'New Zealand Dollar',
    shortcuts: [],
  },
  NOK: {
    code: 'NOK',
    symbol: 'kr',
    nameRu: 'Норвежская крона',
    nameEn: 'Norwegian Krone',
    shortcuts: [],
  },
  SEK: {
    code: 'SEK',
    symbol: 'kr',
    nameRu: 'Шведская крона',
    nameEn: 'Swedish Krona',
    shortcuts: [],
  },
  DKK: {
    code: 'DKK',
    symbol: 'kr',
    nameRu: 'Датская крона',
    nameEn: 'Danish Krone',
    shortcuts: [],
  },
  ZAR: {
    code: 'ZAR',
    symbol: 'R',
    nameRu: 'Южноафриканский рэнд',
    nameEn: 'South African Rand',
    shortcuts: ['рэнд'],
  },
  EGP: {
    code: 'EGP',
    symbol: 'E£',
    nameRu: 'Египетский фунт',
    nameEn: 'Egyptian Pound',
    shortcuts: [],
  },
  SAR: {
    code: 'SAR',
    symbol: 'SAR',
    nameRu: 'Саудовский риял',
    nameEn: 'Saudi Riyal',
    shortcuts: ['риял'],
  },
  QAR: {
    code: 'QAR',
    symbol: 'QAR',
    nameRu: 'Катарский риял',
    nameEn: 'Qatari Riyal',
    shortcuts: [],
  },
  IDR: {
    code: 'IDR',
    symbol: 'Rp',
    nameRu: 'Индонезийская рупия',
    nameEn: 'Indonesian Rupiah',
    shortcuts: [],
  },
  MYR: {
    code: 'MYR',
    symbol: 'RM',
    nameRu: 'Малайзийский ринггит',
    nameEn: 'Malaysian Ringgit',
    shortcuts: [],
  },
  VND: {
    code: 'VND',
    symbol: '₫',
    nameRu: 'Вьетнамский донг',
    nameEn: 'Vietnamese Dong',
    shortcuts: ['донг'],
  },
  PHP: {
    code: 'PHP',
    symbol: '₱',
    nameRu: 'Филиппинское песо',
    nameEn: 'Philippine Peso',
    shortcuts: [],
  },
  TWD: {
    code: 'TWD',
    symbol: 'NT$',
    nameRu: 'Тайваньский доллар',
    nameEn: 'Taiwan Dollar',
    shortcuts: [],
  },
  PKR: {
    code: 'PKR',
    symbol: 'PKR',
    nameRu: 'Пакистанская рупия',
    nameEn: 'Pakistani Rupee',
    shortcuts: [],
  },
  BDT: {
    code: 'BDT',
    symbol: '৳',
    nameRu: 'Бангладешская така',
    nameEn: 'Bangladeshi Taka',
    shortcuts: [],
  },
  NGN: {
    code: 'NGN',
    symbol: '₦',
    nameRu: 'Нигерийская найра',
    nameEn: 'Nigerian Naira',
    shortcuts: [],
  },
  ARS: {
    code: 'ARS',
    symbol: 'AR$',
    nameRu: 'Аргентинское песо',
    nameEn: 'Argentine Peso',
    shortcuts: [],
  },
  CLP: {
    code: 'CLP',
    symbol: 'CL$',
    nameRu: 'Чилийское песо',
    nameEn: 'Chilean Peso',
    shortcuts: [],
  },
  COP: {
    code: 'COP',
    symbol: 'CO$',
    nameRu: 'Колумбийское песо',
    nameEn: 'Colombian Peso',
    shortcuts: [],
  },
  PEN: {
    code: 'PEN',
    symbol: 'S/.',
    nameRu: 'Перуанский соль',
    nameEn: 'Peruvian Sol',
    shortcuts: [],
  },
};

/**
 * Validate whether a string is a known currency code (from CURRENCY_INFO or a valid ISO 4217 format)
 */
export function isValidCurrencyCode(code: string): boolean {
  const upper = code.toUpperCase();
  if (CURRENCY_INFO[upper]) return true;
  // Accept any 3-letter uppercase code as potentially valid ISO 4217
  return /^[A-Z]{3}$/.test(upper);
}

/**
 * Get display label for a currency code: "USD — $ Доллар США"
 */
export function getCurrencyLabel(code: string): string {
  const info = CURRENCY_INFO[code.toUpperCase()];
  if (!info) return code.toUpperCase();
  const parts = [info.code];
  if (info.symbol !== info.code) parts[0] = `${info.code} (${info.symbol})`;
  return `${parts[0]} — ${info.nameRu}`;
}

/**
 * Build a hint string showing how to write expenses in selected currencies
 */
export function buildCurrencyHints(enabledCurrencies: string[], defaultCurrency: string): string {
  const lines: string[] = [];

  lines.push(`Валюта по умолчанию — <b>${defaultCurrency}</b>. Её можно не писать:`);
  lines.push(`  <code>100 еда обед</code> = 100 ${defaultCurrency}`);
  lines.push('');

  lines.push('Как записывать другие валюты:');
  for (const code of enabledCurrencies) {
    if (code === defaultCurrency) continue;
    const info = CURRENCY_INFO[code];
    if (info) {
      const examples: string[] = [];
      if (info.symbol !== info.code) examples.push(`<code>100${info.symbol}</code>`);
      examples.push(`<code>100 ${info.code.toLowerCase()}</code>`);
      if (info.shortcuts.length > 0) {
        examples.push(`<code>100${info.shortcuts[0]}</code>`);
      }
      lines.push(`  ${code}: ${examples.join(', ')}`);
    } else {
      lines.push(`  ${code}: <code>100 ${code.toLowerCase()}</code>`);
    }
  }

  return lines.join('\n');
}

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

/** Internal calculation base: all expenses are stored as eur_amount, conversions go through EUR */
export const BASE_CURRENCY = 'EUR' as const satisfies CurrencyCode;

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
    '📋 Таблицу можно редактировать вручную. После правок запусти /sync чтобы бот подхватил изменения.\n\n' +
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
