// src/bot/bot-error-formatter.ts
// Translates typed service errors into user-friendly Telegram messages

import {
  AnthropicError,
  AppError,
  GoogleSheetsError,
  HuggingFaceError,
  NetworkError,
  OAuthError,
} from '../errors';

/**
 * Convert a typed service error into a short, user-friendly Russian message
 * suitable for sending as a Telegram bot reply.
 */
export function formatErrorForUser(error: unknown): string {
  if (error instanceof OAuthError) {
    return 'Авторизация истекла. Запусти /reconnect чтобы переподключить Google.';
  }
  if (error instanceof GoogleSheetsError) {
    return 'Не удалось обратиться к Google Таблицам. Попробуй ещё раз через минуту.';
  }
  if (error instanceof NetworkError) {
    return 'Нет соединения с сервисом. Проверь интернет и попробуй снова.';
  }
  if (error instanceof AnthropicError || error instanceof HuggingFaceError) {
    return 'AI-сервис временно недоступен. Попробуй позже.';
  }
  if (error instanceof AppError) {
    return 'Произошла ошибка. Попробуй ещё раз.';
  }
  if (error instanceof Error) {
    return 'Произошла непредвиденная ошибка.';
  }
  return 'Неизвестная ошибка.';
}
