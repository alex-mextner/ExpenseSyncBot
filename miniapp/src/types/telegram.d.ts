// TypeScript declarations for Telegram Web App global
interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramWebAppChat {
  id: number;
  type: 'group' | 'supergroup' | 'channel';
  title: string;
  username?: string;
}

interface TelegramWebAppInitDataUnsafe {
  user?: TelegramWebAppUser;
  chat?: TelegramWebAppChat;
  start_param?: string;
  auth_date?: number;
  hash?: string;
}

interface ScanQrPopupParams {
  /** Text displayed under the 'Scan QR' heading, 0-64 characters */
  text?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: TelegramWebAppInitDataUnsafe;
  version: string;
  platform: string;
  HapticFeedback: {
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  };
  /** Open native QR scanner. Callback receives decoded text; return true to close popup. */
  showScanQrPopup(params: ScanQrPopupParams, callback: (text: string) => boolean | void): void;
  /** Programmatically close the native QR scanner popup */
  closeScanQrPopup(): void;
  close(): void;
  expand(): void;
  ready(): void;
  onEvent(eventType: string, callback: () => void): void;
  offEvent(eventType: string, callback: () => void): void;
}

interface Window {
  Telegram?: {
    WebApp: TelegramWebApp;
  };
}
