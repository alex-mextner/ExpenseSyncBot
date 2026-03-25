/**
 * Post-response validation: a lightweight LLM pass that checks
 * the agent's answer for hallucinations, missing tool calls, and data integrity.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('response-validator');

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_MAX_TOKENS = 256;

const VALIDATION_PROMPT = `You are a strict QA validator for a financial assistant bot.

Your job: check the assistant's response for problems. Be fast and decisive.

## AUTOMATIC REJECT reasons:
1. **No tool calls for data questions** — if the user asked about expenses, budgets, totals, or any financial data, the assistant MUST have called at least one tool. Answering from memory/context is NEVER acceptable.
2. **Hallucinated data** — numbers, dates, categories, or comments that don't appear in tool results.
3. **Invented links or sources** — any URL or reference not from tool output.
4. **Math done manually** — sums, conversions, or arithmetic not performed by the calculate tool (small counts like "3 operations" are OK).

## AUTOMATIC APPROVE:
- Greeting, help, or non-data conversational responses (no tools needed).
- Response correctly uses data from tool results with no fabrication.
- Assistant explicitly told the user that data is incomplete/unavailable.

Respond with EXACTLY one line:
APPROVE
or
REJECT: <short reason in the language of the user's message>`;

interface ValidationInput {
  userMessage: string;
  toolCalls: string[];
  response: string;
}

export type ValidationResult = { approved: true } | { approved: false; reason: string };

export async function validateResponse(
  apiKey: string,
  input: ValidationInput,
): Promise<ValidationResult> {
  const toolCallsSummary =
    input.toolCalls.length > 0 ? input.toolCalls.join(', ') : '(none — no tools were called)';

  const userContent = `USER MESSAGE: ${input.userMessage}

TOOL CALLS MADE: ${toolCallsSummary}

ASSISTANT RESPONSE (first 2000 chars):
${input.response.substring(0, 2000)}`;

  const anthropic = new Anthropic({
    apiKey,
    baseURL: env.AI_BASE_URL || undefined,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const result = await anthropic.messages.create(
      {
        model: env.AI_VALIDATION_MODEL,
        max_tokens: VALIDATION_MAX_TOKENS,
        system: VALIDATION_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      },
      { signal: controller.signal },
    );

    const text = result.content[0]?.type === 'text' ? result.content[0].text.trim() : '';

    logger.info(`[VALIDATOR] Result: ${text}`);

    if (text.startsWith('APPROVE')) {
      return { approved: true };
    }

    const reason = text.replace(/^REJECT:\s*/i, '').trim() || 'Validation failed';
    return { approved: false, reason };
  } catch (error) {
    // Validation failure should not block the response — approve by default
    logger.error({ err: error }, '[VALIDATOR] Validation pass failed, approving by default');
    return { approved: true };
  } finally {
    clearTimeout(timeout);
  }
}
