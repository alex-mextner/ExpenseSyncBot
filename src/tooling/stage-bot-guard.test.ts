// Evaluates the `if:` guard of the stage-bot job (.github/workflows/stage-bot.yml) with
// GitHub's own expression engine against pull_request event payloads: the job runs PR code
// on the production home server, so which PRs reach it is a security property.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import { truthy } from '@actions/expressions/result';

const WORKFLOW = join(import.meta.dir, '../../.github/workflows/stage-bot.yml');
const REPO = 'alex-mextner/ExpenseSyncBot';

interface Account {
  login: string;
  type: 'User' | 'Bot';
}

const human: Account = { login: 'alex-mextner', type: 'User' };
const outsider: Account = { login: 'someone', type: 'User' };
const dependabot: Account = { login: 'dependabot[bot]', type: 'Bot' };
const renovate: Account = { login: 'renovate[bot]', type: 'Bot' };
const githubActions: Account = { login: 'github-actions[bot]', type: 'Bot' };

interface PullRequestEvent {
  action: 'opened' | 'reopened' | 'synchronize' | 'closed';
  headRepo: string;
  author: Account;
  sender: Account;
}

/** `value[key]` when `value` is an object that has `key`, otherwise undefined. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Reflect.get(value, key)
    : undefined;
}

async function stageBotCondition(): Promise<string> {
  const workflow: unknown = Bun.YAML.parse(await Bun.file(WORKFLOW).text());
  const condition = field(field(field(workflow, 'jobs'), 'stage-bot'), 'if');
  if (typeof condition !== 'string') throw new Error('stage-bot job has no if: condition');
  return condition;
}

function account(a: Account): data.Dictionary {
  const d = new data.Dictionary();
  d.add('login', new data.StringData(a.login));
  d.add('type', new data.StringData(a.type));
  return d;
}

/** The `github` context of a pull_request run, reduced to the fields the guard may read. */
function githubContext(event: PullRequestEvent): data.Dictionary {
  const repo = new data.Dictionary();
  repo.add('full_name', new data.StringData(event.headRepo));
  const head = new data.Dictionary();
  head.add('repo', repo);
  const pullRequest = new data.Dictionary();
  pullRequest.add('head', head);
  pullRequest.add('user', account(event.author));
  const payload = new data.Dictionary();
  payload.add('action', new data.StringData(event.action));
  payload.add('sender', account(event.sender));
  payload.add('pull_request', pullRequest);
  const github = new data.Dictionary();
  github.add('repository', new data.StringData(REPO));
  github.add('event_name', new data.StringData('pull_request'));
  github.add('actor', new data.StringData(event.sender.login));
  github.add('event', payload);
  const context = new data.Dictionary();
  context.add('github', github);
  return context;
}

async function stageBotRuns(event: PullRequestEvent): Promise<boolean> {
  const lexed = new Lexer(await stageBotCondition()).lex();
  const expression = new Parser(lexed.tokens, ['github'], []).parse();
  return truthy(new Evaluator(expression, githubContext(event)).evaluate());
}

describe('stage-bot job guard', () => {
  test.each([
    ['opened', human],
    ['reopened', human],
    ['synchronize', human],
    ['closed', human],
    // closing runs no PR code (teardown + restart from main), whoever closes it
    ['closed', githubActions],
  ] as const)('runs for a human same-repo PR: %s', async (action, sender) => {
    expect(await stageBotRuns({ action, headRepo: REPO, author: human, sender })).toBe(true);
  });

  test.each([
    ['opened', dependabot, dependabot],
    ['synchronize', dependabot, dependabot],
    ['reopened', dependabot, human],
    ['closed', dependabot, human],
    ['opened', renovate, renovate],
    ['opened', githubActions, githubActions],
  ] as const)('skips a bot-opened PR: %s', async (action, author, sender) => {
    expect(await stageBotRuns({ action, headRepo: REPO, author, sender })).toBe(false);
  });

  test('skips a bot push onto a human PR branch', async () => {
    expect(
      await stageBotRuns({
        action: 'synchronize',
        headRepo: REPO,
        author: human,
        sender: renovate,
      }),
    ).toBe(false);
  });

  test.each(['opened', 'synchronize', 'closed'] as const)('skips a fork PR: %s', async (action) => {
    expect(
      await stageBotRuns({
        action,
        headRepo: 'someone/ExpenseSyncBot',
        author: outsider,
        sender: outsider,
      }),
    ).toBe(false);
  });
});
