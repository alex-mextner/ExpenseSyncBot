/** Tests for per-spreadsheet write queue that prevents EUR formula race conditions */
import { describe, expect, test } from 'bun:test';
import { enqueueSheetWrite } from './sheets';

describe('enqueueSheetWrite', () => {
  test('serializes writes to the same spreadsheet', async () => {
    const order: number[] = [];

    const p1 = enqueueSheetWrite('sheet-A', async () => {
      await Bun.sleep(50);
      order.push(1);
    });

    const p2 = enqueueSheetWrite('sheet-A', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test('allows parallel writes to different spreadsheets', async () => {
    const order: string[] = [];

    const p1 = enqueueSheetWrite('sheet-X', async () => {
      await Bun.sleep(50);
      order.push('X');
    });

    const p2 = enqueueSheetWrite('sheet-Y', async () => {
      order.push('Y');
    });

    await Promise.all([p1, p2]);
    // Y should complete before X since they run in parallel and Y has no delay
    expect(order).toEqual(['Y', 'X']);
  });

  test('continues executing after a failed write', async () => {
    const order: number[] = [];

    const p1 = enqueueSheetWrite('sheet-fail', async () => {
      order.push(1);
      throw new Error('write failed');
    });

    const p2 = enqueueSheetWrite('sheet-fail', async () => {
      order.push(2);
    });

    // p1 should reject but p2 should still run
    try {
      await p1;
    } catch (e) {
      expect((e as Error).message).toBe('write failed');
    }
    await p2;
    expect(order).toEqual([1, 2]);
  });

  test('serializes many concurrent writes in order', async () => {
    const order: number[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 10; i++) {
      const idx = i;
      promises.push(
        enqueueSheetWrite('sheet-many', async () => {
          // Small random delay to prove serialization works
          await Bun.sleep(Math.random() * 5);
          order.push(idx);
        }),
      );
    }

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
