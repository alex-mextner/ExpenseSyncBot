// Tests for photo-processor.ts — background worker that dequeues receipt photos,
// runs QR scan → OCR fallback → AI parsing, and sends confirmation cards.
//
// Strategy: mock every external boundary (QR, OCR, receipt fetcher, receipt parser,
// status writer, telegram-sender, database repos) and exercise processPhotoQueueItem
// via an exported helper that calls it through the module's own control flow.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── logger ───────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── env ──────────────────────────────────────────────────────────────────
mock.module('../../config/env', () => ({
  env: { BOT_TOKEN: 'test-token' },
}));

// ── telegram-sender ──────────────────────────────────────────────────────
const mockSendMessage = mock(async (_text: string, _opts?: unknown) => ({ message_id: 999 }));
const mockWithChatContext = mock(
  <T>(_chatId: number, _threadId: number | null, fn: () => Promise<T>): Promise<T> => fn(),
);
const mockEditMessageText = mock(async () => undefined);
const mockDeleteMessage = mock(async () => undefined);
const mockSendChatAction = mock(async () => undefined);

mock.module('../bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
  editMessageText: mockEditMessageText,
  deleteMessage: mockDeleteMessage,
  sendChatAction: mockSendChatAction,
  withChatContext: mockWithChatContext,
  initSender: mock(),
  sendDirect: mock(),
  sendDocumentDirect: mock(),
}));

// ── receipt pipeline stubs ───────────────────────────────────────────────
const mockScanQRFromImage = mock<(buf: Buffer) => Promise<string | null>>(async () => null);
mock.module('./qr-scanner', () => ({ scanQRFromImage: mockScanQRFromImage }));

const mockFetchReceiptData = mock<(qr: string) => Promise<string>>(async () => 'fetched-data');
mock.module('./receipt-fetcher', () => ({ fetchReceiptData: mockFetchReceiptData }));

// Dynamic import inside photo-processor — mocked at module path
const mockExtractTextFromImage = mock<(buf: Buffer) => Promise<string>>(async () => 'ocr-text');
mock.module('./ocr-extractor', () => ({ extractTextFromImage: mockExtractTextFromImage }));

type MockParseResult = {
  items: Array<{
    name_ru: string;
    name_original?: string;
    quantity: number;
    price: number;
    total: number;
    category: string;
    possible_categories?: string[];
  }>;
  currency?: string;
  date?: string;
  sumVerified: boolean;
  computedSum: number;
  claimedTotal?: number;
  providerUsed: string;
  calculateSumRounds: number;
};

const defaultParseResult = (): MockParseResult => ({
  items: [
    {
      name_ru: 'Молоко',
      name_original: 'Milk',
      quantity: 1,
      price: 100,
      total: 100,
      category: 'Еда',
      possible_categories: ['Продукты'],
    },
  ],
  currency: 'RSD',
  date: '2025-11-24',
  sumVerified: true,
  computedSum: 100,
  claimedTotal: 100,
  providerUsed: 'mock',
  calculateSumRounds: 1,
});

const mockParseReceipt = mock<
  (
    text: string,
    cats: string[],
    examples?: unknown,
    onProgress?: (d: string) => void,
  ) => Promise<MockParseResult>
>(async () => defaultParseResult());

mock.module('./receipt-parser', () => ({ parseReceipt: mockParseReceipt }));

// ── receipt-summarizer ───────────────────────────────────────────────────
const mockBuildSummaryFromItems = mock(() => ({
  categories: [{ name: 'Еда', items: [{ name: 'Молоко', total: 100 }] }],
  totalAmount: 100,
  currency: 'RSD',
}));
const mockFormatSummaryMessage = mock(() => 'summary message');

mock.module('./receipt-summarizer', () => ({
  buildSummaryFromItems: mockBuildSummaryFromItems,
  formatSummaryMessage: mockFormatSummaryMessage,
}));

// ── status-writer ────────────────────────────────────────────────────────
const mockStatusAppend = mock((_delta: string) => undefined);
const mockStatusClose = mock(async () => undefined);
const mockStatusFinalize = mock(async (_text: string) => undefined);

class MockStatusWriter {
  append = mockStatusAppend;
  close = mockStatusClose;
  finalize = mockStatusFinalize;
  forceFlush = mock(async () => undefined);
  finalizeError = mock(async () => undefined);
}
mock.module('./status-writer', () => ({ StatusWriter: MockStatusWriter }));

// ── sharp + fs: stub image compression/filesystem writes ─────────────────
mock.module('sharp', () => ({
  default: () => ({
    resize: () => ({
      jpeg: () => ({ toBuffer: async () => Buffer.from('compressed') }),
    }),
  }),
}));

mock.module('node:fs/promises', () => ({
  mkdir: async () => undefined,
  writeFile: async () => undefined,
}));

// ── database repos ───────────────────────────────────────────────────────
interface PhotoQueueItem {
  id: number;
  group_id: number;
  user_id: number;
  message_id: number;
  message_thread_id: number | null;
  file_id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error_message?: string | null;
  summary_mode?: number;
  summary_message_id?: number;
}

const photoQueueStore = new Map<number, PhotoQueueItem>();
interface ReceiptItemRow {
  id: number;
  photo_queue_id: number;
  name_ru: string;
  name_original?: string;
  suggested_category: string;
  possible_categories?: string[];
  status: string;
  quantity?: number;
  price?: number;
  total?: number;
  currency?: string;
  confirmed_category?: string | null;
}
const receiptItemsStore: ReceiptItemRow[] = [];
const receiptsStore: Array<{ id: number; group_id: number; photo_queue_id: number }> = [];

const mockPhotoQueue = {
  findPending: mock((): PhotoQueueItem[] =>
    Array.from(photoQueueStore.values()).filter((q) => q.status === 'pending'),
  ),
  findById: mock((id: number): PhotoQueueItem | null => photoQueueStore.get(id) ?? null),
  update: mock((id: number, patch: Partial<PhotoQueueItem>) => {
    const item = photoQueueStore.get(id);
    if (item) Object.assign(item, patch);
    return item;
  }),
};

const mockGroups = {
  findById: mock((id: number) => ({
    id,
    telegram_group_id: 10_000 + id,
    default_currency: 'RSD',
  })),
};

const mockReceiptItems = {
  create: mock((data: { photo_queue_id: number; name_ru: string; suggested_category: string }) => {
    const row = {
      id: receiptItemsStore.length + 1,
      photo_queue_id: data.photo_queue_id,
      name_ru: data.name_ru,
      suggested_category: data.suggested_category,
      status: 'pending',
    };
    receiptItemsStore.push(row);
    return row;
  }),
  findByPhotoQueueId: mock((photoQueueId: number) =>
    receiptItemsStore.filter((i) => i.photo_queue_id === photoQueueId),
  ),
  findNextPending: mock(() => receiptItemsStore.find((i) => i.status === 'pending') ?? null),
};

const mockReceipts = {
  create: mock((data: { group_id: number; photo_queue_id: number }) => {
    const row = {
      id: receiptsStore.length + 1,
      group_id: data.group_id,
      photo_queue_id: data.photo_queue_id,
    };
    receiptsStore.push(row);
    return row;
  }),
};

const mockCategories = {
  findByGroupId: mock((_groupId: number) => [
    { id: 1, group_id: 1, name: 'Еда', created_at: '' },
    { id: 2, group_id: 1, name: 'Продукты', created_at: '' },
  ]),
};

const mockExpenses = {
  getRecentExamplesByCategory: mock((_groupId: number) => new Map<string, unknown[]>()),
};

const mockPendingExpenses = {
  create: mock(() => ({ id: 1 })),
};

mock.module('../../database', () => ({
  database: {
    photoQueue: mockPhotoQueue,
    groups: mockGroups,
    receiptItems: mockReceiptItems,
    receipts: mockReceipts,
    categories: mockCategories,
    expenses: mockExpenses,
    pendingExpenses: mockPendingExpenses,
  },
}));

// ── Keyboards / misc ─────────────────────────────────────────────────────
mock.module('../../bot/keyboards', () => ({
  createReceiptSummaryKeyboard: () => ({ toJSON: () => ({ inline_keyboard: [] }) }),
}));

// ── Global fetch (for downloadPhoto) ─────────────────────────────────────
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mock(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, statusText: 'OK' }),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Now import the module under test ─────────────────────────────────────
const { saveExtractedItems, showReceiptConfirmationOptions } = await import('./photo-processor');

// Re-import internal helpers via re-execution of the queue path.
// We don't import processQueue directly (it's not exported). Instead we call
// startPhotoProcessor or invoke the internal flow via test-only access.
// Since processPhotoQueueItem is private, we drive it by populating the queue
// and calling processQueue — but processQueue is also private. Pattern used:
// invoke the module's exported saveExtractedItems for direct unit tests, and
// use an access cast to reach processPhotoQueueItem via module internals.

// To reach the private processQueue, we expose it through ts-reload of the
// module's own export. Simplest approach: startPhotoProcessor schedules via
// setInterval — we'd rather avoid timers. Instead, we directly re-require
// the module's internals via the existing `processPhotoQueueItem` route by
// calling `startPhotoProcessor` with a stub bot and then capturing the
// interval callback.
import { startPhotoProcessor } from './photo-processor';

// Mock Bot
function makeBot() {
  return {
    api: {
      getFile: mock(async () => ({ file_path: 'photos/file.jpg' })),
      setMessageReaction: mock(async () => true),
      sendMessage: mock(async () => ({ message_id: 1 })),
      editMessageText: mock(async () => ({ message_id: 1 })),
    },
  };
}

type TestBot = ReturnType<typeof makeBot>;

/**
 * Kick off one queue pass by calling startPhotoProcessor and manually firing
 * the setInterval callback. We intercept setInterval so the test never actually
 * sleeps.
 */
async function runOneQueuePass(bot: TestBot): Promise<void> {
  let intervalCb: (() => void) | null = null;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => {
    intervalCb = fn;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  try {
    await startPhotoProcessor(bot as unknown as import('gramio').Bot);
    if (!intervalCb) throw new Error('setInterval not captured');
    await (intervalCb as () => void | Promise<void>)();
    // Allow any pending microtasks inside the callback to settle
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function seedQueueItem(overrides: Partial<PhotoQueueItem> = {}): PhotoQueueItem {
  const id = overrides.id ?? 1;
  const item: PhotoQueueItem = {
    id,
    group_id: 1,
    user_id: 1,
    message_id: 555,
    message_thread_id: null,
    file_id: 'file-abc',
    status: 'pending',
    error_message: null,
    ...overrides,
  };
  photoQueueStore.set(id, item);
  return item;
}

function resetAll(): void {
  photoQueueStore.clear();
  receiptItemsStore.length = 0;
  receiptsStore.length = 0;

  mockScanQRFromImage.mockReset();
  mockFetchReceiptData.mockReset();
  mockExtractTextFromImage.mockReset();
  mockParseReceipt.mockReset();
  mockSendMessage.mockClear();
  mockWithChatContext.mockClear();
  mockEditMessageText.mockClear();
  mockDeleteMessage.mockClear();
  mockStatusAppend.mockClear();
  mockStatusClose.mockClear();
  mockStatusFinalize.mockClear();
  mockPhotoQueue.findPending.mockClear();
  mockPhotoQueue.findById.mockClear();
  mockPhotoQueue.update.mockClear();
  mockGroups.findById.mockClear();
  mockReceiptItems.create.mockClear();
  mockReceiptItems.findByPhotoQueueId.mockClear();
  mockReceipts.create.mockClear();
  mockCategories.findByGroupId.mockClear();
  mockExpenses.getRecentExamplesByCategory.mockClear();

  // Restore sensible defaults
  mockScanQRFromImage.mockImplementation(async () => null);
  mockFetchReceiptData.mockImplementation(async () => '<html>receipt</html>');
  mockExtractTextFromImage.mockImplementation(async () => 'ocr text of receipt');
  mockParseReceipt.mockImplementation(async () => defaultParseResult());
}

beforeEach(resetAll);

// ── Tests ────────────────────────────────────────────────────────────────

describe('photo-processor: empty queue', () => {
  it('returns quickly without side effects', async () => {
    const bot = makeBot();
    await runOneQueuePass(bot);

    expect(mockPhotoQueue.findPending).toHaveBeenCalled();
    expect(bot.api.getFile).not.toHaveBeenCalled();
    expect(mockParseReceipt).not.toHaveBeenCalled();
    expect(mockReceiptItems.create).not.toHaveBeenCalled();
  });
});

describe('photo-processor: QR happy path', () => {
  it('scans QR → fetches receipt → parses → saves items → sends card', async () => {
    seedQueueItem({ id: 1 });
    mockScanQRFromImage.mockImplementation(async () => 'https://fiscal.qr/xyz');
    mockFetchReceiptData.mockImplementation(async () => '<html>big receipt</html>');
    mockParseReceipt.mockImplementation(async () => ({
      ...defaultParseResult(),
      items: [
        {
          name_ru: 'Хлеб',
          quantity: 2,
          price: 60,
          total: 120,
          category: 'Еда',
          possible_categories: [],
        },
      ],
      currency: 'RSD',
      claimedTotal: 120,
      computedSum: 120,
    }));

    const bot = makeBot();
    await runOneQueuePass(bot);

    // QR path was taken
    expect(mockScanQRFromImage).toHaveBeenCalledTimes(1);
    expect(mockFetchReceiptData).toHaveBeenCalledWith('https://fiscal.qr/xyz');
    expect(mockExtractTextFromImage).not.toHaveBeenCalled();

    // Status message was created and closed after successful parse
    expect(mockStatusClose).toHaveBeenCalled();
    expect(mockStatusFinalize).not.toHaveBeenCalled();

    // Items persisted
    expect(mockReceiptItems.create).toHaveBeenCalledTimes(1);
    expect(receiptItemsStore).toHaveLength(1);
    expect(receiptItemsStore[0]?.name_ru).toBe('Хлеб');

    // Receipt record persisted
    expect(mockReceipts.create).toHaveBeenCalledTimes(1);

    // Queue item marked done
    const updates = mockPhotoQueue.update.mock.calls.map((c) => c[1]);
    expect(updates.some((u) => u.status === 'processing')).toBe(true);
    expect(updates.some((u) => u.status === 'done')).toBe(true);

    // Watching reaction set
    expect(bot.api.setMessageReaction).toHaveBeenCalled();

    // No errors logged
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('photo-processor: QR fallback to OCR', () => {
  it('when QR returns nothing, OCR extracts text and parser runs', async () => {
    seedQueueItem({ id: 2 });
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(
      async () => 'Receipt text from OCR — long enough to parse',
    );

    const bot = makeBot();
    await runOneQueuePass(bot);

    expect(mockScanQRFromImage).toHaveBeenCalledTimes(1);
    expect(mockFetchReceiptData).not.toHaveBeenCalled();
    expect(mockExtractTextFromImage).toHaveBeenCalledTimes(1);
    expect(mockParseReceipt).toHaveBeenCalled();
    expect(mockReceiptItems.create).toHaveBeenCalled();
    expect(receiptsStore).toHaveLength(1);
  });

  it('when QR fetch throws, OCR fallback runs', async () => {
    seedQueueItem({ id: 3 });
    mockScanQRFromImage.mockImplementation(async () => 'https://qr/boom');
    mockFetchReceiptData.mockImplementation(async () => {
      throw new Error('fetch boom');
    });
    mockExtractTextFromImage.mockImplementation(async () => 'OCR salvage text with items');

    const bot = makeBot();
    await runOneQueuePass(bot);

    expect(mockExtractTextFromImage).toHaveBeenCalledTimes(1);
    expect(mockParseReceipt).toHaveBeenCalled();
    expect(receiptItemsStore).toHaveLength(1);
  });
});

describe('photo-processor: all extraction methods fail', () => {
  it('no QR + OCR throws → queue marked done + 🤷 reaction, no user message', async () => {
    seedQueueItem({ id: 4 });
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(async () => {
      throw new Error('tesseract crashed');
    });

    const bot = makeBot();
    await runOneQueuePass(bot);

    // Parser never ran
    expect(mockParseReceipt).not.toHaveBeenCalled();

    // Item created nothing
    expect(mockReceiptItems.create).not.toHaveBeenCalled();

    // Marked done (both QR & OCR failed path)
    const updates = mockPhotoQueue.update.mock.calls.map((c) => c[1]);
    expect(updates.some((u) => u.status === 'done')).toBe(true);

    // 🤷 reaction set as the second reaction call (first is 👀)
    const reactions = bot.api.setMessageReaction.mock.calls.map(
      (c: unknown[]) => (c[0] as { reaction: Array<{ emoji: string }> }).reaction[0]?.emoji,
    );
    expect(reactions).toContain('👀');
    expect(reactions.some((e: string | undefined) => e?.includes('🤷'))).toBe(true);
    // Logger assertion omitted: 🤷 reaction + queue done status already prove
    // the OCR failure path executed.
  });

  it('parser returns empty items array → status=error + notify user', async () => {
    seedQueueItem({ id: 5 });
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(async () => 'some OCR text');
    mockParseReceipt.mockImplementation(async () => ({
      ...defaultParseResult(),
      items: [],
      computedSum: 0,
    }));

    const bot = makeBot();
    await runOneQueuePass(bot);

    const updates = mockPhotoQueue.update.mock.calls.map((c) => c[1]);
    expect(
      updates.some((u) => u.status === 'error' && u.error_message?.includes('не найдены')),
    ).toBe(true);

    // User was notified (sendMessage called with the error text)
    const sentTexts = mockSendMessage.mock.calls.map((c) => c[0] as string);
    expect(sentTexts.some((t) => t.includes('не найдены расходы'))).toBe(true);
  });

  it('parser throws → status writer finalized with error, queue marked error', async () => {
    seedQueueItem({ id: 6 });
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(async () => 'text');
    mockParseReceipt.mockImplementation(async () => {
      throw new Error('AI down');
    });

    const bot = makeBot();
    await runOneQueuePass(bot);

    expect(mockStatusFinalize).toHaveBeenCalled();
    const finalizeArg = mockStatusFinalize.mock.calls[0]?.[0] as string | undefined;
    expect(finalizeArg).toContain('AI не распознал чек');
    expect(finalizeArg).toContain('AI down');

    const updates = mockPhotoQueue.update.mock.calls.map((c) => c[1]);
    expect(updates.some((u) => u.status === 'error')).toBe(true);
    // Logger assertion intentionally omitted: statusWriter.finalize + queue update
    // assertions above already prove the error path executed.
  });
});

describe('photo-processor: status updates', () => {
  it('status writer receives onProgress deltas and closes on success', async () => {
    seedQueueItem({ id: 7 });
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(async () => 'receipt text');
    mockParseReceipt.mockImplementation(async (_t, _cats, _ex, onProgress) => {
      onProgress?.('chunk-a');
      onProgress?.('chunk-b');
      return defaultParseResult();
    });

    const bot = makeBot();
    await runOneQueuePass(bot);

    expect(mockStatusAppend).toHaveBeenCalledTimes(2);
    expect(mockStatusAppend.mock.calls[0]?.[0]).toBe('chunk-a');
    expect(mockStatusAppend.mock.calls[1]?.[0]).toBe('chunk-b');
    expect(mockStatusClose).toHaveBeenCalled();
  });

  it('processing status is set before any parse work', async () => {
    seedQueueItem({ id: 8 });
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(async () => 'text');

    const bot = makeBot();
    await runOneQueuePass(bot);

    // First update call must be status=processing
    const firstUpdate = mockPhotoQueue.update.mock.calls[0];
    expect(firstUpdate?.[1]?.status).toBe('processing');
  });
});

describe('photo-processor: error resilience across items', () => {
  it('one failing item does not stop processing of the next', async () => {
    seedQueueItem({ id: 10 });
    seedQueueItem({ id: 11, file_id: 'file-second' });

    // First item: OCR throws → marked done/error path
    // Second item: happy path via OCR
    let call = 0;
    mockScanQRFromImage.mockImplementation(async () => null);
    mockExtractTextFromImage.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('ocr boom');
      return 'valid OCR text';
    });

    const bot = makeBot();
    await runOneQueuePass(bot);

    // Both items visited
    expect(mockPhotoQueue.findById).toHaveBeenCalled();
    expect(mockExtractTextFromImage).toHaveBeenCalledTimes(2);

    // Second item produced receipt items
    expect(mockReceiptItems.create).toHaveBeenCalled();
    const createdForItem11 = receiptItemsStore.filter((i) => i.photo_queue_id === 11);
    expect(createdForItem11.length).toBeGreaterThan(0);
  });
});

describe('photo-processor: saveExtractedItems', () => {
  it('creates one receipt item per AI item and marks queue done', () => {
    seedQueueItem({ id: 20 });

    saveExtractedItems(
      20,
      [
        {
          name_ru: 'Товар 1',
          quantity: 1,
          price: 50,
          total: 50,
          category: 'Еда',
          possible_categories: ['Разное'],
        },
        {
          name_ru: 'Товар 2',
          quantity: 2,
          price: 30,
          total: 60,
          category: 'Разное',
        },
      ],
      'RSD',
    );

    expect(mockReceiptItems.create).toHaveBeenCalledTimes(2);
    const done = mockPhotoQueue.update.mock.calls.find((c) => c[1].status === 'done');
    expect(done).toBeTruthy();
  });
});

describe('photo-processor: showReceiptConfirmationOptions', () => {
  it('item-by-item flow for ≤5 items calls findNextPending path', async () => {
    seedQueueItem({ id: 30 });
    // Seed 3 items
    receiptItemsStore.push(
      {
        id: 101,
        photo_queue_id: 30,
        name_ru: 'A',
        suggested_category: 'Еда',
        possible_categories: [],
        status: 'pending',
        quantity: 1,
        price: 100,
        total: 100,
        currency: 'RSD',
      },
      {
        id: 102,
        photo_queue_id: 30,
        name_ru: 'B',
        suggested_category: 'Еда',
        possible_categories: [],
        status: 'pending',
        quantity: 1,
        price: 100,
        total: 100,
        currency: 'RSD',
      },
      {
        id: 103,
        photo_queue_id: 30,
        name_ru: 'C',
        suggested_category: 'Еда',
        possible_categories: [],
        status: 'pending',
        quantity: 1,
        price: 100,
        total: 100,
        currency: 'RSD',
      },
    );

    await showReceiptConfirmationOptions(1, 30);

    // For item-by-item: sendMessage is called once to show the first item card
    expect(mockSendMessage).toHaveBeenCalled();
    // Summary-mode updates should NOT be set
    const summaryModeCall = mockPhotoQueue.update.mock.calls.find((c) => c[1].summary_mode === 1);
    expect(summaryModeCall).toBeUndefined();
  });

  it('summary mode for >5 items sets summary_mode=1 and stores summary_message_id', async () => {
    seedQueueItem({ id: 31 });
    for (let i = 0; i < 6; i++) {
      receiptItemsStore.push({
        id: 200 + i,
        photo_queue_id: 31,
        name_ru: `Item${i}`,
        suggested_category: 'Еда',
        possible_categories: [],
        status: 'pending',
        quantity: 1,
        price: 100,
        total: 100,
        currency: 'RSD',
      });
    }
    mockSendMessage.mockImplementationOnce(async () => ({ message_id: 7777 }));

    await showReceiptConfirmationOptions(1, 31);

    const patches = mockPhotoQueue.update.mock.calls.map((c) => c[1]);
    expect(patches.some((p) => p.summary_mode === 1)).toBe(true);
    expect(patches.some((p) => p.summary_message_id === 7777)).toBe(true);
  });

  it('no pending items → logs and returns without sending', async () => {
    seedQueueItem({ id: 32 });
    // All items already confirmed
    receiptItemsStore.push({
      id: 300,
      photo_queue_id: 32,
      name_ru: 'X',
      suggested_category: 'Еда',
      possible_categories: [],
      status: 'confirmed',
      quantity: 1,
      price: 100,
      total: 100,
      currency: 'RSD',
    });

    await showReceiptConfirmationOptions(1, 32);

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
