// Mock logger factory for test assertions — verify expected logs, catch unexpected ones
import { mock } from 'bun:test';

type MockFn = ReturnType<typeof mock>;

export interface MockLogger {
  trace: MockFn;
  debug: MockFn;
  info: MockFn;
  warn: MockFn;
  error: MockFn;
  fatal: MockFn;
  child: MockFn;
}

/**
 * Create a mock logger with spyable methods.
 * Use with mock.module to replace createLogger in tests.
 *
 * Usage:
 *   const logMock = createMockLogger();
 *   mock.module('../../utils/logger', () => ({
 *     createLogger: () => logMock,
 *     logger: logMock,
 *   }));
 *
 * Assertions:
 *   expect(logMock.error).toHaveBeenCalled();               // error-path test
 *   expect(logMock.error).not.toHaveBeenCalled();            // happy-path test
 *   expect(logMock.warn).toHaveBeenCalledWith('expected');    // specific message
 */
export function createMockLogger(): MockLogger {
  const mockLogger: MockLogger = {
    trace: mock(),
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
    fatal: mock(),
    child: mock(),
  };
  // child() returns the same mock logger (flat hierarchy in tests)
  mockLogger.child.mockReturnValue(mockLogger);
  return mockLogger;
}
