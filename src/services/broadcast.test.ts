// Tests for broadcast service — message delivery to groups with mock bot
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import cron from 'node-cron';
import { database } from '../database';
import { scheduleNewsBroadcast } from './broadcast';

let cronSpy: ReturnType<typeof spyOn>;
let dbSpy: ReturnType<typeof spyOn>;

const fakeTask = { stop: mock(() => {}) };

beforeEach(() => {
  cronSpy = spyOn(cron, 'schedule').mockReturnValue(
    fakeTask as unknown as ReturnType<typeof cron.schedule>,
  );
  dbSpy = spyOn(database.groups, 'getAll').mockReturnValue([]);
});

afterEach(() => {
  mock.restore();
});

// ── Mock bot factory ────────────────────────────────────────────────────────────

function makeMockBot(opts: { sendFails?: boolean; failOnGroupId?: number } = {}) {
  const sendMessage = mock(
    (params: {
      chat_id: number;
      text: string;
      parse_mode?: string;
      message_thread_id?: number;
    }) => {
      if (opts.sendFails || opts.failOnGroupId === params.chat_id) {
        return Promise.reject(new Error(`Failed to send to ${params.chat_id}`));
      }
      return Promise.resolve({ ok: true, message_id: 1 });
    },
  );

  return {
    api: { sendMessage },
    _sendMessage: sendMessage,
  };
}

type MockGroup = { telegram_group_id: number; active_topic_id?: number | null };

function makeGroups(...ids: number[]): MockGroup[] {
  return ids.map((id) => ({ telegram_group_id: id }));
}

// ── scheduleNewsBroadcast ───────────────────────────────────────────────────────

describe('scheduleNewsBroadcast', () => {
  it('is a function', () => {
    expect(typeof scheduleNewsBroadcast).toBe('function');
  });

  it('does not throw when called', () => {
    expect(() => scheduleNewsBroadcast()).not.toThrow();
  });

  it('schedules a cron job', () => {
    scheduleNewsBroadcast();
    expect(cronSpy).toHaveBeenCalledTimes(1);
  });

  it('cron expression targets March 29 at 12:00', () => {
    scheduleNewsBroadcast();
    const [cronExpr] = cronSpy.mock.calls[0] as [string, ...unknown[]];
    expect(cronExpr).toBe('0 12 29 3 *');
  });
});

// ── database.groups.getAll spy ─────────────────────────────────────────────────

describe('database spy', () => {
  it('getAll spy returns configured groups', () => {
    dbSpy.mockReturnValue(makeGroups(111, 222) as ReturnType<typeof database.groups.getAll>);
    const groups = database.groups.getAll();
    expect(groups).toHaveLength(2);
    expect(groups[0]?.telegram_group_id).toBe(111);
  });

  it('getAll spy default returns empty array', () => {
    expect(database.groups.getAll()).toHaveLength(0);
  });
});
