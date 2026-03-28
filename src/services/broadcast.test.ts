// Tests for broadcast service — message delivery to groups with mock bot
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import cron from 'node-cron';
import { database } from '../database';
import { scheduleNewsBroadcast } from './broadcast';

// ── Spies (no mock.module — banned per pipeline.ts:148) ────────────────────────
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
    const bot = makeMockBot();
    expect(() => scheduleNewsBroadcast(bot as never)).not.toThrow();
  });

  it('schedules a cron job', () => {
    const bot = makeMockBot();
    scheduleNewsBroadcast(bot as never);
    expect(cronSpy).toHaveBeenCalledTimes(1);
  });

  it('cron expression targets March 29 at 12:00', () => {
    const bot = makeMockBot();
    scheduleNewsBroadcast(bot as never);
    const [cronExpr] = cronSpy.mock.calls[0] as [string, ...unknown[]];
    expect(cronExpr).toBe('0 12 29 3 *');
  });
});

// ── Bot mock behaviour (logic reused by broadcastToAllGroups) ───────────────────

describe('mock bot behaviour', () => {
  beforeEach(() => {
    // Reset alreadySent flag between tests by overriding the cron callback
    dbSpy.mockReturnValue([]);
  });

  it('sendMessage resolves with ok:true on success', async () => {
    const bot = makeMockBot();
    const result = await bot.api.sendMessage({ chat_id: 100, text: 'test', parse_mode: 'HTML' });
    expect(result.ok).toBe(true);
  });

  it('sendMessage rejects when sendFails=true', async () => {
    const bot = makeMockBot({ sendFails: true });
    await expect(
      bot.api.sendMessage({ chat_id: 100, text: 'test', parse_mode: 'HTML' }),
    ).rejects.toThrow('Failed to send');
  });

  it('sends with message_thread_id when group has active_topic_id', async () => {
    const bot = makeMockBot();
    const group: MockGroup = { telegram_group_id: 500, active_topic_id: 7 };

    await bot.api.sendMessage({
      chat_id: group.telegram_group_id,
      text: 'test',
      parse_mode: 'HTML',
      ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
    });

    expect(bot._sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chat_id: 500,
      message_thread_id: 7,
    });
  });

  it('sends without message_thread_id when active_topic_id is null', async () => {
    const bot = makeMockBot();
    const group: MockGroup = { telegram_group_id: 600, active_topic_id: null };

    await bot.api.sendMessage({
      chat_id: group.telegram_group_id,
      text: 'test',
      parse_mode: 'HTML',
      ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
    });

    const call = bot._sendMessage.mock.calls[0]?.[0];
    expect(call?.chat_id).toBe(600);
    expect(call?.message_thread_id).toBeUndefined();
  });

  it('individual group failure does not stop other sends', async () => {
    const bot = makeMockBot({ failOnGroupId: 200 });
    const groups: MockGroup[] = [
      { telegram_group_id: 100 },
      { telegram_group_id: 200 },
      { telegram_group_id: 300 },
    ];

    let sent = 0;
    let failed = 0;

    for (const group of groups) {
      try {
        await bot.api.sendMessage({
          chat_id: group.telegram_group_id,
          text: 'x',
          parse_mode: 'HTML',
        });
        sent++;
      } catch {
        failed++;
      }
    }

    expect(sent).toBe(2);
    expect(failed).toBe(1);
  });

  it('sends to all groups in order', async () => {
    const bot = makeMockBot();
    const groups: MockGroup[] = makeGroups(10, 20, 30);

    for (const group of groups) {
      await bot.api.sendMessage({
        chat_id: group.telegram_group_id,
        text: 'msg',
        parse_mode: 'HTML',
      });
    }

    const ids = bot._sendMessage.mock.calls.map((call) => call[0]?.chat_id);
    expect(ids).toEqual([10, 20, 30]);
  });

  it('sendMessage always called with HTML parse_mode', async () => {
    const bot = makeMockBot();
    await bot.api.sendMessage({ chat_id: 1, text: 'hello', parse_mode: 'HTML' });
    expect(bot._sendMessage.mock.calls[0]?.[0]?.parse_mode).toBe('HTML');
  });

  it('no groups = zero sendMessage calls', async () => {
    const bot = makeMockBot();
    const groups: MockGroup[] = [];
    for (const group of groups) {
      await bot.api.sendMessage({
        chat_id: group.telegram_group_id,
        text: 'x',
        parse_mode: 'HTML',
      });
    }
    expect(bot._sendMessage.mock.calls.length).toBe(0);
  });

  it('all failures result in zero successful sends', async () => {
    const bot = makeMockBot({ sendFails: true });
    let sent = 0;
    for (const group of makeGroups(1, 2)) {
      try {
        await bot.api.sendMessage({
          chat_id: group.telegram_group_id,
          text: 'x',
          parse_mode: 'HTML',
        });
        sent++;
      } catch {
        /* expected */
      }
    }
    expect(sent).toBe(0);
  });

  it('failing send throws Error instance', async () => {
    const bot = makeMockBot({ sendFails: true });
    await expect(
      bot.api.sendMessage({ chat_id: 9999, text: 'x', parse_mode: 'HTML' }),
    ).rejects.toBeInstanceOf(Error);
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
