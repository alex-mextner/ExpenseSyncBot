/** OCR extractor — structured KIE extraction from receipt images via vision models */
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { InferenceClient } from '@huggingface/inference';
import type { ChatCompletionInputMessage } from '@huggingface/tasks';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('ocr-extractor');

const client = new InferenceClient(env.HF_TOKEN);

// ── Types ───────────────────────────────────────────────────────────────────

export interface OcrReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
}

export interface OcrExtractionResult {
  items: OcrReceiptItem[];
  store?: string;
  date?: string;
  currency?: string;
  total?: number;
}

// ── Model Fallback Chain ────────────────────────────────────────────────────

const KIE_JSON_SCHEMA = `{"items": [{"name": "item name", "quantity": 1, "price": 100.00, "total": 100.00}], "store": "store name", "date": "DD.MM.YYYY", "currency": "RSD", "total": 1234.56}`;

const OCR_MODELS = [
  {
    model: 'zai-org/GLM-OCR',
    provider: 'zai-org',
    name: 'GLM-OCR',
    systemPrompt: `Extract receipt items as JSON. Return ONLY valid JSON matching this schema:\n${KIE_JSON_SCHEMA}`,
    userPrompt: 'Extract all items from this receipt image.',
  },
  {
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    provider: undefined,
    name: 'Qwen2.5-VL-72B',
    systemPrompt: undefined,
    userPrompt: `You are a receipt scanner. Look at this receipt image and extract all line items.\nReturn ONLY a valid JSON object with this exact structure:\n${KIE_JSON_SCHEMA}\nDo not include any text outside the JSON object. Do not wrap in markdown code fences.`,
  },
] as const;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract structured receipt items from image using vision models.
 * Tries GLM-OCR (0.9B KIE) first, falls back to Qwen2.5-VL-72B.
 */
export async function extractFromImage(imageBuffer: Buffer): Promise<OcrExtractionResult> {
  const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
  let lastError: Error | null = null;

  for (const model of OCR_MODELS) {
    try {
      logger.info(`[OCR] Trying ${model.name} for structured extraction`);

      const messages: ChatCompletionInputMessage[] = [];

      if (model.systemPrompt) {
        messages.push({ role: 'system', content: model.systemPrompt });
      }

      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: model.userPrompt },
        ],
      });

      const response = await client.chatCompletion({
        ...(model.provider ? { provider: model.provider } : {}),
        model: model.model,
        messages,
        max_tokens: 4096,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error(`Empty response from ${model.name}`);

      const result = parseOcrResponse(content);
      logger.info(
        { model: model.name, itemCount: result.items.length },
        '[OCR] Structured extraction successful',
      );
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn({ err: lastError, model: model.name }, '[OCR] Model failed, trying next');
    }
  }

  throw new Error(`All OCR models failed: ${lastError?.message}`);
}

// ── Backward-compatible shims (remove after Tasks 3–5 update callers) ───────

/** @deprecated Use extractFromImage() instead. Kept temporarily for callers not yet migrated. */
export async function extractTextFromImageBuffer(imageBuffer: Buffer): Promise<string> {
  const result = await extractFromImage(imageBuffer);
  return formatResultAsText(result);
}

/** @deprecated Use extractFromImage() instead. Kept temporarily for callers not yet migrated. */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  return extractTextFromImageBuffer(imageBuffer);
}

/** Format structured result as plain text for backward compatibility */
function formatResultAsText(result: OcrExtractionResult): string {
  const lines: string[] = [];
  if (result.store) lines.push(`Store: ${result.store}`);
  if (result.date) lines.push(`Date: ${result.date}`);
  for (const item of result.items) {
    lines.push(`${item.name} x${item.quantity} — ${item.price} = ${item.total}`);
  }
  if (result.total !== undefined) lines.push(`Total: ${result.total}`);
  if (result.currency) lines.push(`Currency: ${result.currency}`);
  return lines.join('\n');
}

// ── Response Parser ─────────────────────────────────────────────────────────

/** Shape of a raw item from the vision model JSON response */
interface RawOcrItem {
  name?: string;
  quantity?: number;
  price?: number;
  total?: number;
}

/** Shape of the raw JSON response from vision models */
interface RawOcrResponse {
  items?: RawOcrItem[];
  store?: string;
  date?: string;
  currency?: string;
  total?: number;
}

/** Parse vision model response into structured OcrExtractionResult */
function parseOcrResponse(content: string): OcrExtractionResult {
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '');
  cleaned = cleaned.replace(/(\d),(\d)/g, '$1.$2');

  const parsed: RawOcrResponse = JSON.parse(cleaned);

  const items: OcrReceiptItem[] = (parsed.items || [])
    .filter((item) => item.name && typeof item.total === 'number')
    .map((item) => ({
      name: String(item.name),
      quantity: Number(item.quantity) || 1,
      price: Number(item.price) || Number(item.total),
      total: Number(item.total),
    }));

  if (items.length === 0) throw new Error('No items extracted from receipt');

  const result: OcrExtractionResult = { items };

  if (typeof parsed.store === 'string' && parsed.store) result.store = parsed.store;
  if (typeof parsed.date === 'string' && parsed.date) result.date = parsed.date;
  if (typeof parsed.currency === 'string' && parsed.currency) result.currency = parsed.currency;
  if (typeof parsed.total === 'number') result.total = parsed.total;

  return result;
}

// ── Legacy Cleanup ──────────────────────────────────────────────────────────

/**
 * Start periodic cleanup of old temp images.
 * Runs every 5 minutes and deletes files older than 5 minutes.
 */
export function startTempImageCleanup(): void {
  const CLEANUP_INTERVAL = 5 * 60 * 1000;
  const MAX_AGE = 5 * 60 * 1000;

  setInterval(async () => {
    try {
      const tempDir = path.join(process.cwd(), 'temp-images');

      let files: string[];
      try {
        files = await readdir(tempDir);
      } catch {
        return;
      }
      const now = Date.now();
      let deletedCount = 0;

      for (const file of files) {
        const filepath = path.join(tempDir, file);
        const stats = await stat(filepath);
        const age = now - stats.mtimeMs;

        if (age > MAX_AGE) {
          try {
            await unlink(filepath);
            deletedCount++;
          } catch (error) {
            logger.error({ err: error }, `[OCR_CLEANUP] Failed to delete old file ${file}`);
          }
        }
      }

      if (deletedCount > 0) {
        logger.info(`[OCR_CLEANUP] Deleted ${deletedCount} old temp image(s)`);
      }
    } catch (error) {
      logger.error({ err: error }, '[OCR_CLEANUP] Error during cleanup');
    }
  }, CLEANUP_INTERVAL);

  logger.info('[OCR_CLEANUP] Started periodic temp image cleanup (every 5 minutes)');
}
