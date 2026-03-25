/**
 * AI-powered code review using Anthropic/GLM API.
 *
 * Replaced the old Claude CLI approach with direct API calls.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { getErrorMessage } from '../../utils/error';
import { createLogger } from '../../utils/logger.ts';
import { AI_BASE_URL, AI_MODEL } from '../ai/agent';

const logger = createLogger('codex-integration');

/**
 * Run code review using Anthropic/GLM API.
 */
export async function runCodexReview(diff: string): Promise<string> {
  if (!diff.trim()) {
    return 'No changes to review.';
  }

  if (!env.ANTHROPIC_API_KEY) {
    return 'Code review skipped: no AI API key configured.';
  }

  const maxDiffLength = 50000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? `${diff.slice(0, maxDiffLength)}\n\n[... diff truncated ...]`
      : diff;

  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: AI_BASE_URL,
  });

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Review this code diff. Focus on:
1. Bugs or logic errors
2. Security issues (path traversal, injection)
3. Missing error handling
4. TypeScript type safety
5. Performance concerns

Be concise. List issues as bullet points. If the code looks good, say so.

\`\`\`diff
${truncatedDiff}
\`\`\``,
        },
      ],
    });

    let review = '';
    for (const block of response.content) {
      if (block.type === 'text') review += block.text;
    }
    return review.trim() || 'No review comments.';
  } catch (error) {
    logger.error({ err: error }, '[REVIEW] Failed');
    return `Review failed: ${getErrorMessage(error)}`;
  }
}
