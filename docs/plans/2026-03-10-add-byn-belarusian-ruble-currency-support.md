# Add BYN (Belarusian Ruble) currency support

Task #8

TITLE: Add BYN (Belarusian Ruble) currency support

FILES TO MODIFY:
- src/config/constants.ts: Add BYN to CURRENCY_ALIASES, SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS
- src/services/currency/converter.ts: Add BYN to FALLBACK_RATES, fetchExchangeRates, formatExchangeRatesForAI
- src/services/currency/parser.test.ts: Add test cases for BYN parsing

FILES TO CREATE:
- None

IMPLEMENTATION STEPS:
1. In src/config/constants.ts:
   - Add aliases to CURRENCY_ALIASES: 'byn', 'б', 'бр', 'бел', 'белорусский рубль', 'б rub', 'br'
   - Add 'BYN' to SUPPORTED_CURRENCIES array
   - Add BYN: 'Br' to CURRENCY_SYMBOLS

2. In src/services/currency/converter.ts:
   - Add BYN: 0.28 to FALLBACK_RATES (approx 3.5 BYN = 1 EUR)
   - Add BYN: 1 / (data.rates.BYN || 1) in fetchExchangeRates()
   - Add BYN to console.log output in formatExchangeRatesForAI

3. In src/services/currency/parser.test.ts:
   - Add test: "100 BYN food" parses correctly
   - Add test: "50б food" parses as BYN
   - Add test: "100 бр food" parses as BYN

RISKS/NOTES:
- BYN exchange rate is relatively stable (~3.5 BYN = 1 EUR as of 2025)
- API (open.er-api.com) should support BYN rate
- Short alias 'б' (Cyrillic) could conflict with Russian 'р' (RUB), but they're different letters
- 'Br' is the common symbol for Belarusian Ruble