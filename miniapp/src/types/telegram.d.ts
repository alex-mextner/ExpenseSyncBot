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

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: TelegramWebAppInitDataUnsafe;
  HapticFeedback: {
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  };
  close(): void;
  expand(): void;
  ready(): void;
}

interface Window {
  Telegram?: {
    WebApp: TelegramWebApp;
  };
}
