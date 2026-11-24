// Evaluate the real stage job condition against offline pull-request fixtures.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(
  new URL('../../.github/workflows/stage-bot.yml', import.meta.url),
  'utf8',
);
const stageJob = workflow.split('  stage-bot:\n')[1];
const expression = stageJob?.match(/^ {4}if: (.+)$/m)?.[1];
if (!expression || !/^[a-zA-Z_.\s=!&]+$/.test(expression))
  throw new Error('Unexpected stage job condition');
const condition = expression;

function shouldRunStage(draft: boolean, headRepo: string): unknown {
  return runInNewContext(
    condition,
    {
      github: {
        repository: 'owner/ExpenseSyncBot',
        event: { pull_request: { draft, head: { repo: { full_name: headRepo } } } },
      },
    },
    { timeout: 100 },
  );
}

test('a same-repository draft does not deploy or stop the stage bot', () => {
  expect(shouldRunStage(true, 'owner/ExpenseSyncBot')).toBe(false);
});
test('a ready same-repository PR retains the existing stage job behavior', () => {
  expect(shouldRunStage(false, 'owner/ExpenseSyncBot')).toBe(true);
});
test.each([true, false])('a fork PR stays excluded with draft=%s', (draft) => {
  expect(shouldRunStage(draft, 'other/ExpenseSyncBot')).toBe(false);
});
