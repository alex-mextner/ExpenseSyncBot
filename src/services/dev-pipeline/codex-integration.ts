/** AI-powered code review via shared completion utility */
import { env } from '../../config/env';
import { getErrorMessage } from '../../utils/error';
import { createLogger } from '../../utils/logger.ts';
import { aiComplete, stripThinkingTags } from '../ai/completion';

const logger = createLogger('codex-integration');

/**
 * Run code review on a git diff.
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

  try {
    const { text } = await aiComplete({
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
      maxTokens: 4096,
    });

    const cleaned = stripThinkingTags(text);
    return cleaned || 'No review comments.';
  } catch (error) {
    logger.error({ err: error }, '[REVIEW] Failed');
    return `Review failed: ${getErrorMessage(error)}`;
  }
}
