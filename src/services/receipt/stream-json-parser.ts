/** Incremental JSON parser that extracts complete AIReceiptItem objects from a growing AI response buffer */

import type { AIReceiptItem } from './ai-extractor';

export class StreamJsonParser {
  private buffer = '';
  private emittedCount = 0;

  /** Append new tokens from the AI stream, returns any newly completed items */
  push(chunk: string): AIReceiptItem[] {
    this.buffer += chunk;

    // Strip completed <think>...</think> blocks
    this.buffer = this.buffer.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Check for unclosed <think> block — only parse content before it
    const openThink = this.buffer.lastIndexOf('<think>');
    if (openThink >= 0) {
      const closeThink = this.buffer.indexOf('</think>', openThink);
      if (closeThink < 0) {
        const cleanPart = this.buffer.substring(0, openThink);
        const allItems = this.extractItems(cleanPart);
        const newItems = allItems.slice(this.emittedCount);
        this.emittedCount = allItems.length;
        return newItems;
      }
    }

    // Strip markdown code fences
    this.buffer = this.buffer.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '');

    // Fix decimal comma separators: 399,99 → 399.99 (only outside strings)
    this.buffer = this.fixDecimalCommas(this.buffer);

    const allItems = this.extractItems(this.buffer);
    const newItems = allItems.slice(this.emittedCount);
    this.emittedCount = allItems.length;
    return newItems;
  }

  /** Get all items extracted so far */
  getAllItems(): AIReceiptItem[] {
    return this.extractItems(this.buffer);
  }

  /** Extract currency code from the buffer (appears after items array) */
  getCurrency(): string | undefined {
    const match = this.buffer.match(/"currency"\s*:\s*"([A-Z]{3})"/);
    return match?.[1];
  }

  /**
   * Fix decimal comma separators in numeric contexts.
   * Converts patterns like 399,99 to 399.99 but avoids corrupting strings.
   */
  private fixDecimalCommas(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        result += ch;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        result += ch;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        result += ch;
        continue;
      }

      if (!inString && ch === ',') {
        // Check if this is a decimal comma: digit before and digit after
        const prevChar = i > 0 ? (text[i - 1] ?? '') : '';
        const nextChar = i < text.length - 1 ? (text[i + 1] ?? '') : '';
        if (prevChar !== '' && /\d/.test(prevChar) && nextChar !== '' && /\d/.test(nextChar)) {
          result += '.';
          continue;
        }
      }

      result += ch;
    }

    return result;
  }

  /** Extract all complete item objects from the given text */
  private extractItems(text: string): AIReceiptItem[] {
    const itemsKeyPos = text.indexOf('"items"');
    if (itemsKeyPos < 0) return [];

    const bracketStart = text.indexOf('[', itemsKeyPos);
    if (bracketStart < 0) return [];

    const items: AIReceiptItem[] = [];
    let i = bracketStart + 1;

    while (i < text.length) {
      const objStart = this.findNextObjectStart(text, i);
      if (objStart < 0) break;

      const objEnd = this.findMatchingBrace(text, objStart);
      if (objEnd < 0) break;

      const objStr = text.substring(objStart, objEnd + 1);
      try {
        const item = JSON.parse(objStr) as AIReceiptItem;
        if (item.name_ru && typeof item.total === 'number') {
          items.push(item);
        }
      } catch {
        // Malformed object, skip
      }

      i = objEnd + 1;
    }

    return items;
  }

  /** Find the next '{' that starts an object (skip whitespace and commas) */
  private findNextObjectStart(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') return i;
      if (ch === ']') return -1;
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') continue;
    }
    return -1;
  }

  /** Find matching '}' for '{' at pos, respecting string literals and nesting */
  private findMatchingBrace(text: string, pos: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = pos; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }

    return -1;
  }
}
