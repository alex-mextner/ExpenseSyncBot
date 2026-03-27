// BANK_REGISTRY — maps registry keys to ZenPlugin imports and credential field definitions.
// Add new bank: add one entry here.

export interface ZenAccount {
  id: string;
  title: string;
  balance: number;
  currency: string;
  type?: 'checking' | 'savings' | 'credit';
}

export interface ZenTransaction {
  id: string;
  date: string;
  sum: number; // negative = debit/outgoing, positive = credit/incoming (ZenMoney convention)
  currency: string;
  merchant?: string;
  mcc?: number;
  comment?: string;
  account?: string;
}

export type ScrapeResult = {
  accounts: ZenAccount[];
  transactions: ZenTransaction[];
};

export type ScrapeFunction = (args: {
  preferences: Record<string, string>;
  fromDate: Date;
  toDate: Date;
}) => Promise<ScrapeResult>;

export type CredentialField =
  | string
  | { name: string; type: 'text' | 'password' | 'otp'; prompt: string };

export interface BankPlugin {
  name: string;
  plugin: () => Promise<{ scrape: ScrapeFunction }>;
  fields: CredentialField[];
}

// ZenPlugins are loaded via dynamic import with a runtime-constructed path so that
// TypeScript does not traverse into the submodule (which has incompatible tsconfig settings).
// The paths are correct relative to this file at runtime.
const pluginPath = (rel: string): string => new URL(rel, import.meta.url).pathname;

function loadPlugin(rel: string): Promise<{ scrape: ScrapeFunction }> {
  return import(/* @vite-ignore */ pluginPath(rel)) as Promise<{ scrape: ScrapeFunction }>;
}

export const BANK_REGISTRY: Record<string, BankPlugin> = {
  tbc: {
    name: 'TBC Bank',
    plugin: () => loadPlugin('./ZenPlugins/src/plugins/tbc-ge/index.ts'),
    fields: [
      { name: 'login', type: 'text', prompt: 'Логин TBC' },
      { name: 'password', type: 'password', prompt: 'Пароль TBC' },
    ],
  },
  kaspi: {
    name: 'Kaspi Bank',
    plugin: () => loadPlugin('./ZenPlugins/src/plugins/kaspi/index.ts'),
    // Kaspi uses PDF statement upload — no login/password required
    fields: [],
  },
};

export function getBankList(): { key: string; name: string }[] {
  return Object.entries(BANK_REGISTRY).map(([key, plugin]) => ({
    key,
    name: plugin.name,
  }));
}
