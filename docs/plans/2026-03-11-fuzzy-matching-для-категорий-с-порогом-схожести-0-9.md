# Fuzzy matching для категорий с порогом схожести 0.9

Task #6

Посмотрю на тесты fuzzy-search, чтобы понять текущую структуру:Теперь я понимаю архитектуру. Нужно добавить Levenshtein distance для fuzzy matching с порогом 0.9.

TITLE: Fuzzy matching для категорий с порогом схожести 0.9

FILES TO MODIFY:
- src/utils/fuzzy-search.ts: добавить levenshteinDistance, calculateSimilarity, обновить findBestCategoryMatch с fuzzy matching
- src/database/repositories/category.repository.ts: добавить метод findFuzzyMatch для поиска категории с fuzzy matching

FILES TO CREATE:
- src/utils/fuzzy-search.test.ts: тесты для levenshteinDistance и fuzzy matching

IMPLEMENTATION STEPS:
1. Добавить функцию levenshteinDistance(a, b) в fuzzy-search.ts (классический алгоритм Левенштейна)
2. Добавить функцию calculateSimilarity(a, b) = 1 - distance/max(len(a),len(b)), возвращает 0-1
3. Обновить findBestCategoryMatch: добавить fuzzy matching с порогом 0.9 (примерно 1 ошибка на 10 символов)
4. Написать тесты: точное совпадение, опечатка в 1 символ, разный регистр, пробелы, нет матча
5. Добавить метод CategoryRepository.findFuzzyMatch(groupId, name) - использует findBestCategoryMatch
6. В message.handler.ts:464 и ai-extractor.ts:193 уже используют findBestCategoryMatch - изменений не требуется

RISKS/NOTES:
- Порог 0.9 строгий: "Продукты" vs "Продукты" = 1.0, vs "ПродуктЫ" (опечатка) = 0.89 (не пройдет), vs "Продукты " (лишний пробел) = 0.9 (пройдет после trim)
- Сначала normalize: trim + lowercase, потом сравнение
- Короткие категории (2-3 буквы) будут требовать точного совпадения