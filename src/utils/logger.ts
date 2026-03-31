// Pino logger factory — create module-specific child loggers via createLogger()
import pino from 'pino';

function getLogLevel(): string {
  if (process.env['LOG_LEVEL']) return process.env['LOG_LEVEL'];
  if (process.env.NODE_ENV === 'test') return 'silent';
  if (process.env.NODE_ENV === 'production') return 'info';
  return 'debug';
}

export const logger = pino({
  level: getLogLevel(),
  ...(process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }
    : {}),
});

export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}
