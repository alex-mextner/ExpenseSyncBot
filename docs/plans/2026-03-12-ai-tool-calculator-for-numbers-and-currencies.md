# AI Tool Calculator for Numbers and Currencies

Task #7

Теперь у меня достаточно информации для составления плана.

TITLE: AI Tool Calculator for Numbers and Currencies

FILES TO MODIFY:
- src/services/ai/tools.ts: Add TOOL_DEFINITIONS entry for 'calculate' tool
- src/services/ai/tool-executor.ts: Add case 'calculate' in switch statement, implement executeCalculate function
- src/services/ai/agent.ts: Update system prompt to instruct AI to use calculate tool

FILES TO CREATE:
- src/services/currency/calculator.ts: Core calculator logic (parse expression, evaluate, convert currencies)
- src/services/currency/calculator.test.ts: Unit tests for calculator

IMPLEMENTATION STEPS:
1. Create src/services/currency/calculator.ts with:
   - parseExpression(): parse "100USD+50EUR", "(10USD+20EUR)*2", "100USD" into tokens
   - evaluate(): recursive descent parser with operator precedence and parentheses
   - convertToCurrency(): convert result to target currency using existing convertCurrency()
   - Supported currencies from CurrencyCode type (USD, EUR, RUB, RSD, GBP, BYN, CHF, JPY, CNY, INR, LKR, AED)
   - Format: strictly <NUM><CURR> (e.g. 100USD, 50EUR), no spaces between number and code
   - Round to 2 decimal places

2. Create src/services/currency/calculator.test.ts with tests for:
   - Pure arithmetic: "10+20*3", "(10+5)*2"
   - Single currency: "100USD"
   - Mixed currencies: "100USD+50EUR", "100USD+5000RUB"
   - Conversion: "100USD" with target_currency="EUR"
   - Complex: "(100USD+50EUR)*2", "100USD/3"
   - Error cases: invalid format, unknown currency, division by zero

3. Modify src/services/ai/tools.ts:
   - Add 'calculate' tool definition with input schema:
     - expression (string, required): expression with numbers/currencies and operators
     - target_currency (string, optional): currency code to convert result to
   - Description emphasizes: "ALWAYS use this tool for ANY calculation. NEVER calculate mentally or intuitively."

4. Modify src/services/ai/tool-executor.ts:
   - Add case 'calculate' in executeTool switch
   - Implement executeCalculate function calling calculator module
   - Return formatted result with currency or error message

5. Modify src/services/ai/agent.ts:
   - Update buildSystemPrompt() to add rule about using calculate tool for all arithmetic and currency operations

RISKS/NOTES:
- Expression parsing must be safe (no eval) - use existing tokenizer pattern from parser.ts
- Exchange rates from converter.ts use cached rates with 24h TTL
- Division by zero and overflow must return clear errors
- Target currency is optional - if not specified, use first currency in expression or EUR as default