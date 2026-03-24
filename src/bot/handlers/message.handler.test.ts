// Tests for sheet write error tracking in message handler

import { describe, expect, it } from 'bun:test';
import { getSheetWriteErrorMessage, resetSheetWriteFailures } from './message.handler';

describe('getSheetWriteErrorMessage', () => {
  it('returns simple retry message on first failure', () => {
    resetSheetWriteFailures(999);
    const msg = getSheetWriteErrorMessage(999);
    expect(msg).toContain('Попробуй ещё раз');
    expect(msg).not.toContain('/reconnect');
  });

  it('suggests /reconnect on second consecutive failure', () => {
    resetSheetWriteFailures(998);
    getSheetWriteErrorMessage(998);
    const msg = getSheetWriteErrorMessage(998);
    expect(msg).toContain('/reconnect');
  });

  it('suggests /reconnect on third+ consecutive failure', () => {
    resetSheetWriteFailures(997);
    getSheetWriteErrorMessage(997);
    getSheetWriteErrorMessage(997);
    const msg = getSheetWriteErrorMessage(997);
    expect(msg).toContain('/reconnect');
  });

  it('resets counter after resetSheetWriteFailures', () => {
    resetSheetWriteFailures(996);
    getSheetWriteErrorMessage(996);
    getSheetWriteErrorMessage(996);
    resetSheetWriteFailures(996);
    const msg = getSheetWriteErrorMessage(996);
    expect(msg).toContain('Попробуй ещё раз');
    expect(msg).not.toContain('/reconnect');
  });

  it('tracks failures independently per group', () => {
    resetSheetWriteFailures(100);
    resetSheetWriteFailures(200);
    getSheetWriteErrorMessage(100);
    getSheetWriteErrorMessage(100);
    const msg100 = getSheetWriteErrorMessage(100);
    const msg200 = getSheetWriteErrorMessage(200);
    expect(msg100).toContain('/reconnect');
    expect(msg200).not.toContain('/reconnect');
  });
});
