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
  /** Fractional digits for original-currency amounts; defaults to two. */
  decimalPlaces?: number;
}

export const CURRENCY_INFO: Record<string, CurrencyInfo> = {
  USD: {
    code: 'USD',
    symbol: '$',
    nameRu: 'Доллар США',
    nameEn: 'US Dollar',
    shortcuts: ['д', 'дол'],
  },
  EUR: { code: 'EUR', symbol: '€', nameRu: 'Евро', nameEn: 'Euro', shortcuts: ['е', 'евро'] },
  RUB: {
    code: 'RUB',
    symbol: '₽',
    nameRu: 'Российский рубль',
    nameEn: 'Russian Ruble',
    shortcuts: ['р', 'руб'],
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
    shortcuts: ['фунт'],
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
    shortcuts: ['иена', 'иен'],
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
    shortcuts: ['рупия'],
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
  OMR: {
    code: 'OMR',
    symbol: 'OMR',
    nameRu: 'Оманский риал',
    nameEn: 'Omani Rial',
    shortcuts: ['оманский риал', 'RO'],
    decimalPlaces: 3,
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
    shortcuts: ['грн', 'гривна'],
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
    shortcuts: ['манат'],
  },
  TRY: {
    code: 'TRY',
    symbol: '₺',
    nameRu: 'Турецкая лира',
    nameEn: 'Turkish Lira',
    shortcuts: ['лира', 'TL'],
  },
  ILS: {
    code: 'ILS',
    symbol: '₪',
    nameRu: 'Израильский шекель',
    nameEn: 'Israeli Shekel',
    shortcuts: ['шекель'],
  },
  PLN: {
    code: 'PLN',
    symbol: 'zł',
    nameRu: 'Польский злотый',
    nameEn: 'Polish Zloty',
    shortcuts: ['злотый'],
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
    shortcuts: ['вона'],
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
  KHR: {
    code: 'KHR',
    symbol: '៛',
    nameRu: 'Камбоджийский риель',
    nameEn: 'Cambodian Riel',
    shortcuts: ['риель'],
  },
  MYR: {
    code: 'MYR',
    symbol: 'RM',
    nameRu: 'Малайзийский ринггит',
    nameEn: 'Malaysian Ringgit',
    shortcuts: ['ринггит'],
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
 * Get currency symbol for display. Uses CURRENCY_INFO, falls back to the code itself.
 */
export function getCurrencySymbol(code: string): string {
  const info = CURRENCY_INFO[code.toUpperCase()];
  return info ? info.symbol : code;
}

/** Decimal places used for amounts in their own currency (OMR has 1,000 baisa). */
export function getCurrencyPrecision(code: string): number {
  return CURRENCY_INFO[code.toUpperCase()]?.decimalPlaces ?? 2;
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

  // GEL — unambiguous names, local spelling, and symbols
  gel: 'GEL',
  гел: 'GEL',
  '₾': 'GEL',
  lari: 'GEL',
  laris: 'GEL',
  'georgian lari': 'GEL',
  'georgian laris': 'GEL',
  лари: 'GEL',
  'грузинский лари': 'GEL',
  'грузинского лари': 'GEL',
  'грузинскому лари': 'GEL',
  'грузинским лари': 'GEL',
  'грузинском лари': 'GEL',
  'грузинские лари': 'GEL',
  'грузинских лари': 'GEL',
  'грузинскими лари': 'GEL',
  ლარი: 'GEL',
  ლარის: 'GEL',
  'ქართული ლარი': 'GEL',

  // OMR — unambiguous names, local spelling, and symbols
  omr: 'OMR',
  омр: 'OMR',
  ro: 'OMR',
  'r.o.': 'OMR',
  'r.o': 'OMR',
  'р.о.': 'OMR',
  'omani rial': 'OMR',
  'omani rials': 'OMR',
  'rial omani': 'OMR',
  'rials omani': 'OMR',
  'omani riyal': 'OMR',
  'omani riyals': 'OMR',
  'оманский риал': 'OMR',
  'оманского риала': 'OMR',
  'оманскому риалу': 'OMR',
  'оманским риалом': 'OMR',
  'оманском риале': 'OMR',
  'оманские риалы': 'OMR',
  'оманских риалов': 'OMR',
  'оманским риалам': 'OMR',
  'оманскими риалами': 'OMR',
  'оманских риалах': 'OMR',
  'риал омана': 'OMR',
  'риала омана': 'OMR',
  'риалов омана': 'OMR',
  'риалы омана': 'OMR',
  'риалу омана': 'OMR',
  'риалом омана': 'OMR',
  'риалами омана': 'OMR',
  'риалах омана': 'OMR',
  'ر.ع.': 'OMR',
  'ر.ع': 'OMR',
  'ريال عماني': 'OMR',
  'ريالات عمانية': 'OMR',
  'الريال العماني': 'OMR',
  'الريالات العمانية': 'OMR',
  '⃄': 'OMR',

  // THB — unambiguous names, local spelling, and symbols
  thb: 'THB',
  тхб: 'THB',
  '฿': 'THB',
  baht: 'THB',
  bahts: 'THB',
  'thai baht': 'THB',
  'thai bahts': 'THB',
  бат: 'THB',
  бата: 'THB',
  батов: 'THB',
  баты: 'THB',
  бату: 'THB',
  батом: 'THB',
  бате: 'THB',
  батам: 'THB',
  батами: 'THB',
  батах: 'THB',
  บาท: 'THB',
  บาทไทย: 'THB',
  'тайский бат': 'THB',
  'тайского бата': 'THB',
  'тайскому бату': 'THB',
  'тайским батом': 'THB',
  'тайском бате': 'THB',
  'тайские баты': 'THB',
  'тайских батов': 'THB',
  'тайским батам': 'THB',
  'тайскими батами': 'THB',
  'тайских батах': 'THB',
  'таиландский бат': 'THB',
  'таиландского бата': 'THB',
  'таиландскому бату': 'THB',
  'таиландским батом': 'THB',
  'таиландском бате': 'THB',
  'таиландские баты': 'THB',
  'таиландских батов': 'THB',
  'таиландским батам': 'THB',
  'таиландскими батами': 'THB',
  'таиландских батах': 'THB',
  'тайландский бат': 'THB',
  'тайландского бата': 'THB',
  'тайландскому бату': 'THB',
  'тайландским батом': 'THB',
  'тайландском бате': 'THB',
  'тайландские баты': 'THB',
  'тайландских батов': 'THB',
  'тайландским батам': 'THB',
  'тайландскими батами': 'THB',
  'тайландских батах': 'THB',

  // MYR — codes, symbols, and qualified/local names
  myr: 'MYR',
  rm: 'MYR',
  мйр: 'MYR',
  ringgit: 'MYR',
  ringgits: 'MYR',
  'malaysian ringgit': 'MYR',
  'malaysian ringgits': 'MYR',
  'ringgit malaysia': 'MYR',
  ринггит: 'MYR',
  ринггита: 'MYR',
  ринггитов: 'MYR',
  ринггиты: 'MYR',
  ринггиту: 'MYR',
  ринггитом: 'MYR',
  ринггите: 'MYR',
  ринггитам: 'MYR',
  ринггитами: 'MYR',
  ринггитах: 'MYR',
  'малайзийский ринггит': 'MYR',
  'малайзийского ринггита': 'MYR',
  'малайзийскому ринггиту': 'MYR',
  'малайзийским ринггитом': 'MYR',
  'малайзийском ринггите': 'MYR',
  'малайзийские ринггиты': 'MYR',
  'малайзийских ринггитов': 'MYR',
  'малайзийским ринггитам': 'MYR',
  'малайзийскими ринггитами': 'MYR',
  'малайзийских ринггитах': 'MYR',
  'малазийский ринггит': 'MYR',
  'малазийского ринггита': 'MYR',
  'малазийскому ринггиту': 'MYR',
  'малазийским ринггитом': 'MYR',
  'малазийском ринггите': 'MYR',
  'малазийские ринггиты': 'MYR',
  'малазийских ринггитов': 'MYR',
  'малазийским ринггитам': 'MYR',
  'малазийскими ринггитами': 'MYR',
  'малазийских ринггитах': 'MYR',
  рингит: 'MYR',
  рингита: 'MYR',
  рингитов: 'MYR',
  рингиты: 'MYR',
  рингиту: 'MYR',
  рингитом: 'MYR',
  рингите: 'MYR',
  рингитам: 'MYR',
  рингитами: 'MYR',
  рингитах: 'MYR',
  'малайзийский рингит': 'MYR',
  'малайзийского рингита': 'MYR',
  'малайзийскому рингиту': 'MYR',
  'малайзийским рингитом': 'MYR',
  'малайзийском рингите': 'MYR',
  'малайзийские рингиты': 'MYR',
  'малайзийских рингитов': 'MYR',
  'малайзийским рингитам': 'MYR',
  'малайзийскими рингитами': 'MYR',
  'малайзийских рингитах': 'MYR',
  'малазийский рингит': 'MYR',
  'малазийского рингита': 'MYR',
  'малазийскому рингиту': 'MYR',
  'малазийским рингитом': 'MYR',
  'малазийском рингите': 'MYR',
  'малазийские рингиты': 'MYR',
  'малазийских рингитов': 'MYR',
  'малазийским рингитам': 'MYR',
  'малазийскими рингитами': 'MYR',
  'малазийских рингитах': 'MYR',

  // KHR — codes, symbols, and qualified/local names
  khr: 'KHR',
  кхр: 'KHR',
  '៛': 'KHR',
  riel: 'KHR',
  riels: 'KHR',
  'cambodian riel': 'KHR',
  'cambodian riels': 'KHR',
  'khmer riel': 'KHR',
  'khmer riels': 'KHR',
  រៀល: 'KHR',
  риель: 'KHR',
  риеля: 'KHR',
  риелю: 'KHR',
  риелем: 'KHR',
  риеле: 'KHR',
  риели: 'KHR',
  риелей: 'KHR',
  риелям: 'KHR',
  риелями: 'KHR',
  риелях: 'KHR',
  'камбоджийский риель': 'KHR',
  'камбоджийского риеля': 'KHR',
  'камбоджийскому риелю': 'KHR',
  'камбоджийским риелем': 'KHR',
  'камбоджийском риеле': 'KHR',
  'камбоджийские риели': 'KHR',
  'камбоджийских риелей': 'KHR',
  'камбоджийским риелям': 'KHR',
  'камбоджийскими риелями': 'KHR',
  'камбоджийских риелях': 'KHR',
  'риель камбоджи': 'KHR',
  'риеля камбоджи': 'KHR',
  'риелю камбоджи': 'KHR',
  'риелем камбоджи': 'KHR',
  'риеле камбоджи': 'KHR',
  'риели камбоджи': 'KHR',
  'риелей камбоджи': 'KHR',
  'риелям камбоджи': 'KHR',
  'риелями камбоджи': 'KHR',
  'риелях камбоджи': 'KHR',
  риэль: 'KHR',
  риэля: 'KHR',
  риэлю: 'KHR',
  риэлем: 'KHR',
  риэле: 'KHR',
  риэли: 'KHR',
  риэлей: 'KHR',
  риэлям: 'KHR',
  риэлями: 'KHR',
  риэлях: 'KHR',
  'камбоджийский риэль': 'KHR',
  'камбоджийского риэля': 'KHR',
  'камбоджийскому риэлю': 'KHR',
  'камбоджийским риэлем': 'KHR',
  'камбоджийском риэле': 'KHR',
  'камбоджийские риэли': 'KHR',
  'камбоджийских риэлей': 'KHR',
  'камбоджийским риэлям': 'KHR',
  'камбоджийскими риэлями': 'KHR',
  'камбоджийских риэлях': 'KHR',
  'риэль камбоджи': 'KHR',
  'риэля камбоджи': 'KHR',
  'риэлю камбоджи': 'KHR',
  'риэлем камбоджи': 'KHR',
  'риэле камбоджи': 'KHR',
  'риэли камбоджи': 'KHR',
  'риэлей камбоджи': 'KHR',
  'риэлям камбоджи': 'KHR',
  'риэлями камбоджи': 'KHR',
  'риэлях камбоджи': 'KHR',

  // TRY — codes, symbols, and qualified/local names
  try: 'TRY',
  tl: 'TRY',
  тл: 'TRY',
  '₺': 'TRY',
  lira: 'TRY',
  liras: 'TRY',
  'turkish lira': 'TRY',
  'turkish liras': 'TRY',
  'türk lirası': 'TRY',
  'türk lirasi': 'TRY',
  'turk lirasi': 'TRY',
  лира: 'TRY',
  лиры: 'TRY',
  лире: 'TRY',
  лиру: 'TRY',
  лирой: 'TRY',
  лирою: 'TRY',
  лир: 'TRY',
  лирам: 'TRY',
  лирами: 'TRY',
  лирах: 'TRY',
  'турецкая лира': 'TRY',
  'турецкой лиры': 'TRY',
  'турецкой лире': 'TRY',
  'турецкой лирой': 'TRY',
  'турецкой лирою': 'TRY',
  'турецкую лиру': 'TRY',
  'турецкие лиры': 'TRY',
  'турецких лир': 'TRY',
  'турецких лирах': 'TRY',
  'турецким лирам': 'TRY',
  'турецкими лирами': 'TRY',

  // Egyptian Pound
  egp: 'EGP',
  егп: 'EGP',
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
  'EGP',
  'GEL',
  'OMR',
  'THB',
  'MYR',
  'KHR',
  'TRY',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** True for the built-in codes — the ones with reliable EUR rates. */
export function isSupportedCurrency(code: string): code is CurrencyCode {
  return SUPPORTED_CURRENCIES.some((c) => c === code);
}

/** Internal calculation base: all expenses are stored as eur_amount, conversions go through EUR */
export const BASE_CURRENCY = 'EUR' as const satisfies CurrencyCode;

/**
 * Google API Scopes.
 *
 * `drive.file` is a non-sensitive scope that grants access only to files the
 * app itself creates. Because the bot creates every spreadsheet it touches,
 * this single scope covers both Sheets read/write and Drive operations
 * (copy/list/update) — the broader `spreadsheets` scope is not needed.
 */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

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

  authSuccess: '✅ Google аккаунт подключен!',

  setupComplete:
    '🎉 Настройка завершена!\n\n' +
    'Таблица создана: {spreadsheetUrl}\n\n' +
    'Теперь просто отправляй расходы в формате:\n' +
    '190 евро Алекс кулёма\n' +
    '100$ еда обед в ресторане\n' +
    '1900 RSD транспорт такси\n' +
    '10*3$ еда пицца за троих\n\n' +
    '📋 Таблицу можно редактировать вручную.\n\n' +
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
