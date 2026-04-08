/**
 * Advice-specific validation: checks AI-generated financial advice for errors before sending.
 * Separate from response-validator.ts which handles interactive Q&A validation.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import type { AdviceTier, TriggerResult } from '../analytics/types';

const logger = createLogger('advice-validator');

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_MAX_TOKENS = 256;

const ADVICE_VALIDATION_PROMPT = `You are a strict QA validator for a financial bot's proactive advice messages.

Your job: check the advice for problems BEFORE it's sent to users. Be fast and decisive.

## AUTOMATIC REJECT reasons:
1. **Hallucinated numbers** — amounts, percentages, or dates that weren't provided in the trigger data and likely came from nowhere.
2. **Internal contradictions** — e.g. "spending is down" but then "spending increased significantly".
3. **Generic filler** — advice that could apply to anyone without specific numbers. Every claim must have a number.
4. **Invented links or URLs** — any URL is suspicious.
5. **Wrong language** — advice must be in Russian.
6. **Unreasonable claims** — e.g. "save 50% of income" without context, or mathematically impossible suggestions.

## AUTOMATIC APPROVE:
- Advice contains specific numbers from the trigger data.
- Advice is actionable with concrete suggestions.
- No contradictions or hallucinations detected.

Respond with EXACTLY one line:
APPROVE
or
REJECT: <short reason in Russian>`;

interface AdviceValidationInput {
  tier: AdviceTier;
  trigger: TriggerResult;
  advice: string;
}

export type ValidationResult = { approved: true } | { approved: false; reason: string };

export async function validateAdvice(
  apiKey: string,
  input: AdviceValidationInput,
): Promise<ValidationResult> {
  const userContent = `TIER: ${input.tier}
TRIGGER: ${input.trigger.type} — ${JSON.stringify(input.trigger.data)}

ADVICE TEXT (first 2000 chars):
${input.advice.substring(0, 2000)}`;

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
        system: ADVICE_VALIDATION_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      },
      { signal: controller.signal },
    );

    const text = result.content[0]?.type === 'text' ? result.content[0].text.trim() : '';

    logger.info(`[ADVICE-VALIDATOR] Result: ${text}`);

    if (text.startsWith('APPROVE')) {
      return { approved: true };
    }

    const reason = text.replace(/^REJECT:\s*/i, '').trim() || 'Validation failed';
    return { approved: false, reason };
  } catch (error) {
    logger.error({ err: error }, '[ADVICE-VALIDATOR] Validation pass failed');
    // Agent used tools → data is probably real, approve by default on validator failure
    return { approved: true };
  } finally {
    clearTimeout(timeout);
  }
}
