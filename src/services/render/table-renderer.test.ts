// Tests for table-renderer.ts — Playwright-based PNG rendering of markdown tables.
// Playwright is fully mocked — no real browser is launched.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// Shared state between tests — mutated per scenario to control browser behavior
interface BrowserState {
  html: string | null;
  viewport: { width: number; height: number } | null;
  rootFound: boolean;
  screenshotBytes: Uint8Array;
  throwOnSetContent: Error | null;
  throwOnScreenshot: Error | null;
  closeCalled: boolean;
  throwOnClose: Error | null;
}

const state: BrowserState = {
  html: null,
  viewport: null,
  rootFound: true,
  screenshotBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG magic
  throwOnSetContent: null,
  throwOnScreenshot: null,
  closeCalled: false,
  throwOnClose: null,
};

function resetState() {
  state.html = null;
  state.viewport = null;
  state.rootFound = true;
  state.screenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  state.throwOnSetContent = null;
  state.throwOnScreenshot = null;
  state.closeCalled = false;
  state.throwOnClose = null;
}

mock.module('playwright', () => ({
  chromium: {
    launch: async (_opts?: unknown) => ({
      newPage: async () => ({
        setViewportSize: async (vp: { width: number; height: number }) => {
          state.viewport = vp;
        },
        setContent: async (html: string, _opts?: unknown) => {
          if (state.throwOnSetContent) throw state.throwOnSetContent;
          state.html = html;
        },
        $: async (selector: string) => {
          if (selector !== '#root') return null;
          if (!state.rootFound) return null;
          return {
            screenshot: async (_opts?: unknown) => {
              if (state.throwOnScreenshot) throw state.throwOnScreenshot;
              return Buffer.from(state.screenshotBytes);
            },
          };
        },
      }),
      close: async () => {
        state.closeCalled = true;
        if (state.throwOnClose) throw state.throwOnClose;
      },
    }),
  },
}));

const { renderTableToPng } = await import('./table-renderer');

describe('renderTableToPng', () => {
  beforeEach(() => {
    resetState();
    logMock.error.mockReset();
    logMock.info.mockReset();
    logMock.warn.mockReset();
  });

  it('returns a PNG buffer for a simple markdown table', async () => {
    const result = await renderTableToPng({
      title: 'Expenses',
      markdown: '| A | B |\n|---|---|\n| 1 | 2 |',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    // PNG magic bytes
    expect(result[0]).toBe(0x89);
    expect(result[1]).toBe(0x50);
    expect(state.closeCalled).toBe(true);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('sets viewport to 1200x800', async () => {
    await renderTableToPng({
      title: 'T',
      markdown: '| A |\n|---|\n| 1 |',
    });

    expect(state.viewport).toEqual({ width: 1200, height: 800 });
  });

  it('embeds the title and caption into the rendered HTML', async () => {
    await renderTableToPng({
      title: 'Monthly report',
      markdown: '| col |\n|---|\n| val |',
      caption: 'Note: excludes taxes',
    });

    expect(state.html).not.toBeNull();
    expect(state.html).toContain('Monthly report');
    expect(state.html).toContain('Note: excludes taxes');
  });

  it('handles a table with empty cells', async () => {
    const result = await renderTableToPng({
      title: 'Sparse',
      markdown: '| A | B | C |\n|---|---|---|\n| 1 |   | 3 |\n|   | 2 |   |',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    // Rendered HTML should still contain a table
    expect(state.html).toContain('<table');
  });

  it('preserves unicode and emoji in the rendered HTML', async () => {
    await renderTableToPng({
      title: 'Категории 🇷🇸',
      markdown: '| Категория | Сумма |\n|---|---|\n| Кафе ☕ | 1 500 ₽ |\n| Метро 🚇 | 50 € |',
    });

    expect(state.html).toContain('Категории');
    expect(state.html).toContain('🇷🇸');
    expect(state.html).toContain('☕');
    expect(state.html).toContain('🚇');
    expect(state.html).toContain('Метро');
  });

  it('closes the browser even when screenshot succeeds (happy path cleanup)', async () => {
    await renderTableToPng({
      title: 'T',
      markdown: '| a |\n|---|\n| 1 |',
    });

    expect(state.closeCalled).toBe(true);
  });

  it('closes the browser even when render throws', async () => {
    state.throwOnScreenshot = new Error('screenshot failed');

    await expect(
      renderTableToPng({
        title: 'T',
        markdown: '| a |\n|---|\n| 1 |',
      }),
    ).rejects.toThrow('screenshot failed');

    expect(state.closeCalled).toBe(true);
  });

  it('throws descriptive error when #root is missing in rendered HTML', async () => {
    state.rootFound = false;

    await expect(
      renderTableToPng({
        title: 'T',
        markdown: '| a |\n|---|\n| 1 |',
      }),
    ).rejects.toThrow('Root element not found');

    // Browser still cleaned up via finally
    expect(state.closeCalled).toBe(true);
  });

  it('propagates setContent errors and still closes browser', async () => {
    state.throwOnSetContent = new Error('navigation timeout');

    await expect(
      renderTableToPng({
        title: 'T',
        markdown: '| a |\n|---|\n| 1 |',
      }),
    ).rejects.toThrow('navigation timeout');

    expect(state.closeCalled).toBe(true);
  });

  it('logs error but does not throw when browser.close() fails', async () => {
    state.throwOnClose = new Error('close hang');

    // Function should still resolve with the PNG even if close fails
    const result = await renderTableToPng({
      title: 'T',
      markdown: '| a |\n|---|\n| 1 |',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(logMock.error).toHaveBeenCalled();
    const call = logMock.error.mock.calls[0];
    expect(call).toBeDefined();
  });
});
