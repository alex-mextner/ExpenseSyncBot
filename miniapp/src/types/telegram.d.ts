// TypeScript declarations for Telegram Web App global
interface TelegramWebApp {
  initData: string;
  initDataUnsafe: Record<string, unknown>;
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
