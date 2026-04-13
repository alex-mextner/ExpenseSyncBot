// Tests for StatusWriter — typing indicator, "..." suffix, close/finalize/finalizeError lifecycle.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── Logger ──────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── telegram-sender stubs ───────────────────────────────────────────────
const mockSendMessage = mock(async () => ({ message_id: 42 }) as { message_id: number } | null);
const mockEditMessageText = mock(async () => undefined);
const mockDeleteMessage = mock(async () => undefined);
const mockSendChatAction = mock(async () => undefined);

mock.module('../bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
  editMessageText: mockEditMessageText,
  deleteMessage: mockDeleteMessage,
  sendChatAction: mockSendChatAction,
  withChatContext: mock(),
  initSender: mock(),
  sendDirect: mock(),
  sendDocumentDirect: mock(),
}));

const { StatusWriter } = await import('./status-writer');

// ── Helpers ─────────────────────────────────────────────────────────────
/** Flush microtasks so the constructor's sendMessage promise resolves */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('StatusWriter', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockEditMessageText.mockClear();
    mockDeleteMessage.mockClear();
    mockSendChatAction.mockClear();
    logMock.error.mockClear();
    logMock.warn.mockClear();
  });

  afterEach(() => {
    // Clear any lingering intervals from unclosed writers
    // (each test should close its writer, but just in case)
  });

  describe('constructor', () => {
    test('sends placeholder message on construction', async () => {
      const writer = new StatusWriter({ header: '🤖 Testing...' });
      await tick();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockSendMessage.mock.calls[0] as unknown as [string];
      expect(callArgs[0]).toBe('🤖 Testing...');

      await writer.close();
    });

    test('starts typing interval that sends chat actions', async () => {
      const writer = new StatusWriter({ header: '🤖 Test' });
      await tick();

      // Typing interval fires every 4s — use fake timer to verify
      expect(mockSendChatAction).not.toHaveBeenCalled();

      // Wait for the interval to fire (slightly over 4s)
      await new Promise((resolve) => setTimeout(resolve, 4100));
      expect(mockSendChatAction.mock.calls.length).toBeGreaterThanOrEqual(1);

      await writer.close();
    });
  });

  describe('append and "..." suffix', () => {
    test('formatDisplay adds "..." while writer is open (code mode)', async () => {
      const writer = new StatusWriter({ header: '📝 Header', mode: 'code' });
      await tick();

      // Force flush to capture display
      writer.append('some text');
      await writer.forceFlush();

      expect(mockEditMessageText).toHaveBeenCalled();
      const editArgs = mockEditMessageText.mock.calls[0] as unknown as [number, string];
      const displayText = editArgs[1];
      expect(displayText).toContain('some text...');
      expect(displayText).toContain('<code>');

      await writer.close();
    });

    test('formatDisplay adds "..." while writer is open (plain mode)', async () => {
      const writer = new StatusWriter({ header: '📝 Header', mode: 'plain' });
      await tick();

      writer.append('hello world');
      await writer.forceFlush();

      expect(mockEditMessageText).toHaveBeenCalled();
      const editArgs = mockEditMessageText.mock.calls[0] as unknown as [number, string];
      const displayText = editArgs[1];
      expect(displayText).toContain('hello world...');

      await writer.close();
    });

    test('does not append text after close', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.close();

      mockEditMessageText.mockClear();
      writer.append('ignored');
      await writer.forceFlush();

      // No edits should happen after close
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    test('deletes the status message', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.close();

      expect(mockDeleteMessage).toHaveBeenCalledWith(42);
    });

    test('stops typing interval', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.close();
      mockSendChatAction.mockClear();

      // Wait past the typing interval — no more calls should happen
      await new Promise((resolve) => setTimeout(resolve, 4200));
      expect(mockSendChatAction).not.toHaveBeenCalled();
    });

    test('is idempotent — second call is a no-op', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.close();
      await writer.close();

      expect(mockDeleteMessage).toHaveBeenCalledTimes(1);
    });

    test('skips delete when placeholder failed to send', async () => {
      mockSendMessage.mockImplementationOnce(async () => null);
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.close();

      expect(mockDeleteMessage).not.toHaveBeenCalled();
    });
  });

  describe('finalize', () => {
    test('edits message with final text and stops typing', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.finalize('Final result');

      expect(mockEditMessageText).toHaveBeenCalledWith(42, 'Final result', {
        throwOnError: true,
      });
    });

    test('stops typing interval on finalize', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.finalize('Done');
      mockSendChatAction.mockClear();

      await new Promise((resolve) => setTimeout(resolve, 4200));
      expect(mockSendChatAction).not.toHaveBeenCalled();
    });

    test('throws when placeholder was never sent', async () => {
      mockSendMessage.mockImplementationOnce(async () => null);
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await expect(writer.finalize('text')).rejects.toThrow('placeholder never sent');
    });

    test('no "..." in finalized output', async () => {
      const writer = new StatusWriter({ header: 'H', mode: 'plain' });
      await tick();

      writer.append('streaming text');
      // Don't flush mid-stream — go straight to finalize
      await writer.finalize('Clean final text');

      const editArgs = mockEditMessageText.mock.calls[0] as unknown as [number, string];
      // finalize replaces display entirely — no "..." appended
      expect(editArgs[1]).toBe('Clean final text');
      expect(editArgs[1]).not.toContain('...');
    });
  });

  describe('finalizeError', () => {
    test('preserves streamed content and appends error suffix', async () => {
      const writer = new StatusWriter({ header: '📊 Report', mode: 'plain' });
      await tick();

      writer.append('Partial analysis');
      await writer.finalizeError('<i>❌ Error</i>');

      expect(mockEditMessageText).toHaveBeenCalled();
      const lastCall = mockEditMessageText.mock.calls.at(-1) as unknown as [number, string];
      // Should contain header + body + error suffix
      expect(lastCall[1]).toContain('📊 Report');
      expect(lastCall[1]).toContain('Partial analysis');
      expect(lastCall[1]).toContain('❌ Error');
    });

    test('stops typing interval', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.finalizeError('err');
      mockSendChatAction.mockClear();

      await new Promise((resolve) => setTimeout(resolve, 4200));
      expect(mockSendChatAction).not.toHaveBeenCalled();
    });

    test('is a no-op if already closed', async () => {
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      await writer.close();
      mockEditMessageText.mockClear();

      await writer.finalizeError('err');

      expect(mockEditMessageText).not.toHaveBeenCalled();
    });

    test('handles missing placeholder gracefully', async () => {
      mockSendMessage.mockImplementationOnce(async () => null);
      const writer = new StatusWriter({ header: 'H' });
      await tick();

      // Should not throw — just a no-op
      await writer.finalizeError('err');

      expect(mockEditMessageText).not.toHaveBeenCalled();
      expect(logMock.error).not.toHaveBeenCalled();
    });
  });
});
