/**
 * Shared setup for the telegram-stream test files (split from the former single telegram-stream.test.ts).
 * Importing this module registers the logger mock BEFORE telegram-stream is loaded: a hoisted static
 * import of the writer would create its logger from the real module, so log assertions would see nothing.
 * Every telegram-stream*.test.ts file must import this helper rather than telegram-stream itself.
 */
import { mock } from 'bun:test';
import { type Bot, TelegramError } from 'gramio';
import { createMockLogger } from '../../test-utils/mocks/logger';

export const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const streamModule = await import('./telegram-stream');
export const { isSkipSignal, NO_ANSWER_MESSAGE, TelegramStreamWriter } = streamModule;
export type TelegramStreamWriter = InstanceType<typeof TelegramStreamWriter>;

/**
 * Helper to construct TelegramError instances for tests.
 * GramIO constructor: new TelegramError({ ok, description, error_code, parameters }, method, params)
 */
export function makeTelegramError(
  description: string,
  errorCode: number,
  parameters: { retry_after?: number } = {},
): TelegramError<'editMessageText'> {
  return new TelegramError(
    { ok: false as const, description, error_code: errorCode, parameters },
    'editMessageText',
    // biome-ignore lint/suspicious/noExplicitAny: test stub — full API params not needed
    {} as any,
  );
}

/**
 * Testing private methods via bracket notation on a minimal instance.
 * The constructor requires a Bot, chatId -- we pass stubs since these
 * pure string methods don't touch the bot API.
 */
export function makeWriter(): TelegramStreamWriter {
  const fakeBot = {
    api: {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
      sendChatAction: () => Promise.resolve(),
      deleteMessage: () => Promise.resolve(),
      editMessageText: () => Promise.resolve(),
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub for Bot API
  } as any;
  return new TelegramStreamWriter(fakeBot, 123);
}

/**
 * Writer on a bot stub that records what reaches the screen: edits of the streamed message,
 * new messages (the placeholder and any extra chunks) and deletions.
 */
export function makeRecordingWriter() {
  const edits: string[] = [];
  const sends: Array<{ chat_id: number; text: string; parse_mode?: string }> = [];
  const deleted: number[] = [];
  const bot = {
    api: {
      sendMessage: (params: { chat_id: number; text: string; parse_mode?: string }) => {
        sends.push(params);
        return Promise.resolve({ message_id: sends.length });
      },
      sendChatAction: () => Promise.resolve(true),
      deleteMessage: (params: { message_id: number }) => {
        deleted.push(params.message_id);
        return Promise.resolve(true);
      },
      editMessageText: (params: { text: string }) => {
        edits.push(params.text);
        return Promise.resolve(true);
      },
    },
  };
  // Test stub: only the four API methods the writer calls exist on it.
  const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
  /** Extra answer chunks: HTML messages sent after the streamed one. */
  const chunks = () => sends.filter((s) => s.parse_mode === 'HTML').map((s) => s.text);
  return { writer, edits, sends, deleted, chunks };
}

export const WORK_LOG_OPEN = '<blockquote expandable>';
export const WORK_LOG_CLOSE = '</blockquote>';

/** Split a shown message into its work log (a leading expandable blockquote) and the answer. */
export function splitWorkLog(html: string): { log: string; body: string } {
  if (!html.startsWith(WORK_LOG_OPEN)) return { log: '', body: html };
  const end = html.indexOf(WORK_LOG_CLOSE) + WORK_LOG_CLOSE.length;
  return { log: html.slice(0, end), body: html.slice(end).trim() };
}

/** One finished tool round, the way the agent drives the writer. */
export function runToolRound(
  writer: TelegramStreamWriter,
  name: string,
  input: Record<string, unknown>,
  success = true,
): void {
  writer.setToolLabel(name, input);
  writer.markToolResult(success);
  writer.commitIntermediate();
}
