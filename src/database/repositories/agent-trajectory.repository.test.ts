// Tests for AgentTrajectoryRepository — run + round rows, cascade, outcome check, follow-up marking

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import {
  AgentTrajectoryRepository,
  type CreateAgentTrajectoryData,
} from './agent-trajectory.repository';

let db: Database;
let repo: AgentTrajectoryRepository;
let groupId: number;
let otherGroupId: number;

const NOW = 1_760_000_000_000;

interface TrajectoryRow {
  id: number;
  group_id: number;
  started_at: number;
  finished_at: number;
  outcome: string;
  error_kind: string | null;
  is_mention: number;
  tool_rounds: number;
  tool_calls: number;
  nudges: number;
  handoffs: number;
  providers: string;
  answer_provider: string | null;
  finalize_reason: string | null;
  follow_up_after_ms: number | null;
}

interface RoundRow {
  trajectory_id: number;
  round: number;
  provider: string;
  elapsed_ms: number;
  calls: string;
  decision: string;
  reason: string | null;
}

function insertGroup(telegramId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
      )
      .run(telegramId).lastInsertRowid,
  );
}

function makeRun(overrides: Partial<CreateAgentTrajectoryData> = {}): CreateAgentTrajectoryData {
  return {
    groupId,
    startedAt: NOW - 20_000,
    finishedAt: NOW,
    outcome: 'answered',
    errorKind: null,
    isMention: true,
    toolCalls: 2,
    nudges: 1,
    handoffs: 1,
    providers: ['Groq (gpt-oss-120b)', 'z.ai (glm-5.1)'],
    answerProvider: 'z.ai (glm-5.1)',
    finalizeReason: null,
    rounds: [
      {
        round: 1,
        provider: 'Groq (gpt-oss-120b)',
        elapsedMs: 3_000,
        calls: [{ tool: 'calculate', argsHash: 'a1', resultHash: 'r1', isError: false }],
        decision: 'nudge',
        reason: 'cheap_tool_streak',
      },
      {
        round: 2,
        provider: 'z.ai (glm-5.1)',
        elapsedMs: 9_000,
        calls: [{ tool: 'get_expenses', argsHash: 'a2', resultHash: 'r2', isError: true }],
        decision: 'continue',
        reason: null,
      },
    ],
    ...overrides,
  };
}

function trajectory(id: number): TrajectoryRow | null {
  return db.query<TrajectoryRow, [number]>('SELECT * FROM agent_trajectories WHERE id = ?').get(id);
}

beforeAll(() => {
  db = createTestDb();
  repo = new AgentTrajectoryRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec('DELETE FROM agent_trajectories; DELETE FROM groups;');
  groupId = insertGroup(300100);
  otherGroupId = insertGroup(300200);
});

describe('AgentTrajectoryRepository', () => {
  describe('create', () => {
    it('stores the run and its rounds', () => {
      const id = repo.create(makeRun());

      expect(trajectory(id)).toEqual({
        id,
        group_id: groupId,
        started_at: NOW - 20_000,
        finished_at: NOW,
        outcome: 'answered',
        error_kind: null,
        is_mention: 1,
        tool_rounds: 2,
        tool_calls: 2,
        nudges: 1,
        handoffs: 1,
        providers: '["Groq (gpt-oss-120b)","z.ai (glm-5.1)"]',
        answer_provider: 'z.ai (glm-5.1)',
        finalize_reason: null,
        follow_up_after_ms: null,
      });
      const rounds = db
        .query<RoundRow, [number]>(
          'SELECT trajectory_id, round, provider, elapsed_ms, calls, decision, reason FROM agent_trajectory_rounds WHERE trajectory_id = ? ORDER BY round',
        )
        .all(id);
      expect(rounds).toHaveLength(2);
      expect(rounds[0]).toMatchObject({
        round: 1,
        provider: 'Groq (gpt-oss-120b)',
        elapsed_ms: 3_000,
        decision: 'nudge',
        reason: 'cheap_tool_streak',
      });
      expect(JSON.parse(rounds[1]?.calls ?? '')).toEqual([
        { tool: 'get_expenses', argsHash: 'a2', resultHash: 'r2', isError: true },
      ]);
    });

    it('stores a run without tool rounds', () => {
      const id = repo.create(makeRun({ rounds: [], toolCalls: 0, nudges: 0, handoffs: 0 }));
      expect(trajectory(id)?.tool_rounds).toBe(0);
    });

    it('rejects an unknown outcome and writes nothing', () => {
      const bad = makeRun({ outcome: 'answered' });
      Object.assign(bad, { outcome: 'maybe' });
      expect(() => repo.create(bad)).toThrow();
      expect(db.query('SELECT COUNT(*) AS n FROM agent_trajectory_rounds').get()).toEqual({ n: 0 });
    });

    it('is removed with its group', () => {
      const id = repo.create(makeRun());
      db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
      expect(trajectory(id)).toBeNull();
      expect(db.query('SELECT COUNT(*) AS n FROM agent_trajectory_rounds').get()).toEqual({ n: 0 });
    });
  });

  describe('markFollowUp', () => {
    it("records the gap on the group's run that ended less than 5 minutes ago", () => {
      const id = repo.create(makeRun({ finishedAt: NOW - 120_000 }));
      repo.markFollowUp(groupId, NOW);
      expect(trajectory(id)?.follow_up_after_ms).toBe(120_000);
    });

    it('leaves a run that ended more than 5 minutes ago', () => {
      const id = repo.create(makeRun({ finishedAt: NOW - 360_000 }));
      repo.markFollowUp(groupId, NOW);
      expect(trajectory(id)?.follow_up_after_ms).toBeNull();
    });

    it('marks only the latest run and never overwrites an earlier mark', () => {
      const older = repo.create(makeRun({ finishedAt: NOW - 200_000 }));
      const latest = repo.create(makeRun({ finishedAt: NOW - 100_000 }));
      repo.markFollowUp(groupId, NOW);
      repo.markFollowUp(groupId, NOW + 30_000);
      expect(trajectory(older)?.follow_up_after_ms).toBeNull();
      expect(trajectory(latest)?.follow_up_after_ms).toBe(100_000);
    });

    it('ignores runs of other groups', () => {
      const id = repo.create(makeRun({ groupId: otherGroupId, finishedAt: NOW - 60_000 }));
      repo.markFollowUp(groupId, NOW);
      expect(trajectory(id)?.follow_up_after_ms).toBeNull();
    });
  });
});
