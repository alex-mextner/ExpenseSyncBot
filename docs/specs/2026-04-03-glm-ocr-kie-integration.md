# GLM-OCR KIE Integration

**Date:** 2026-04-03
**Status:** Approved

## Problem

HuggingFace Inference credits ($2/month PRO limit) exhausted in 3 days from OCR pipeline:
- Qwen2.5-VL-72B (72B params) for OCR — expensive, general-purpose VLM
- DeepSeek-R1/V3 for text→JSON extraction — receives raw OCR text, error-prone parsing

## Solution

Replace Qwen2.5-VL-72B with GLM-OCR (0.9B) as primary OCR model. Use KIE (Key Information Extraction) to get structured JSON directly from the image, instead of raw text.

### Benchmarks

| Model | Params | OmniDocBench v1.5 |
|-------|--------|-------------------|
| GLM-OCR | 0.9B | 94.62 (#1) |
| Qwen2.5-VL-72B | 72B | 87.02 |

GLM-OCR: 80x smaller, 7.6 points higher on document understanding.

## Architecture

### Photo receipt pipeline (changed)

```
Photo → GLM-OCR KIE (structured JSON) → DeepSeek (categorize + translate)
         ↓ fail
        Qwen2.5-VL-72B KIE (structured JSON) → DeepSeek (categorize + translate)
         ↓ fail
        throw
```

### QR receipt pipeline (unchanged)

```
QR → fetch HTML → extractExpensesFromReceipt(text) → DeepSeek (full parse + categorize)
```

## Data Types

### OCR output (new)

```typescript
interface OcrReceiptItem {
  name: string;        // original name from receipt
  quantity: number;
  price: number;
  total: number;
}

interface OcrExtractionResult {
  items: OcrReceiptItem[];
  store?: string;
  date?: string;
  currency?: string;
  total?: number;
}
```

### AI enrichment output (existing, reused)

```typescript
interface AIReceiptItem {
  name_ru: string;
  name_original?: string;
  quantity: number;
  price: number;
  total: number;
  category: string;
  possible_categories?: string[];
}
```

## File Changes

### `src/services/receipt/ocr-extractor.ts` — rewrite

- Remove temp file / URL approach, use base64 only
- Add `OCR_MODELS` fallback chain: GLM-OCR (primary), Qwen2.5-VL-72B (fallback)
- GLM-OCR prompt: KIE JSON schema (recommended model format)
- Qwen prompt: verbose English with same JSON schema
- Both return `OcrExtractionResult`
- Exported functions: `extractFromImage(buffer): Promise<OcrExtractionResult>`, keep `extractTextFromImageBuffer` for miniapp compat (returns same type, rename later)
- `startTempImageCleanup()` — keep as-is (harmless)

### `src/services/receipt/ai-extractor.ts` — add function

- New `enrichExtractedItems(ocrResult, existingCategories, categoryExamples)` function
- Input: `OcrExtractionResult` (structured items from OCR)
- DeepSeek prompt: simplified — items already parsed, just needs `name_ru`, `category`, `possible_categories`
- Fewer tokens, better accuracy (structured input vs raw OCR text)
- Existing `extractExpensesFromReceipt` stays for QR/HTML path

### `src/services/receipt/photo-processor.ts` — update calls

- Photo path: `extractFromImage()` → `enrichExtractedItems()` instead of `extractTextFromImage()` → `extractExpensesFromReceipt()`
- QR path: unchanged
- Graceful degradation: if DeepSeek fails but OCR succeeded, use raw items with `category: "Разное"` and `name_ru: name`

### `src/web/miniapp-api.ts` — update call

- `extractTextFromImageBuffer` → new function returning `OcrExtractionResult`
- Adapt downstream code to use structured result

## Fallback Strategy

```
GLM-OCR KIE → success → structured JSON
     ↓ fail
Qwen2.5-VL-72B KIE → success → structured JSON
     ↓ fail
throw OCR error

Structured JSON → enrichExtractedItems (DeepSeek) → full AIReceiptItem[]
     ↓ fail
Use OCR items as-is: name→name_ru, category="Разное", no possible_categories
```

The final fallback ensures users see receipt items even if DeepSeek is down — prices and quantities are already extracted by OCR.

## Testing

- `ocr-extractor.test.ts`: mock HF client, test fallback chain, JSON parsing, invalid response handling
- `ai-extractor.test.ts`: test `enrichExtractedItems` — categorization, translation, fallback to raw items
- Existing tests: update for new return types
- No real network calls in tests

## Out of Scope

- Replacing DeepSeek with GLM-5V-Turbo for categorization
- Self-hosting GLM-OCR (stays on HF Inference)
- Changing QR/HTML pipeline
