// BANK_REGISTRY — auto-discovered from ZenPlugins preferences.xml at module load.
// No manual entries needed; adding a ZenPlugin subdirectory is enough.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ZenAccount {
  id: string;
  title: string;
  balance?: number | null;
  currency?: string;
  // ZenPlugins convention: currency code is stored in 'instrument'
  instrument?: string;
  type?: 'checking' | 'savings' | 'credit';
  syncIds?: string[];
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

export type CredentialField = {
  name: string;
  type: 'text' | 'password' | 'otp';
  prompt: string;
};

export interface BankPlugin {
  name: string;
  plugin: () => Promise<{ scrape: ScrapeFunction }>;
  /** Fields the wizard will prompt the user to fill in. */
  fields: CredentialField[];
  /** Auto-filled credential values (date, checkbox, ListPreference defaults). */
  defaults?: Record<string, string>;
}

// ZenPlugins are loaded via dynamic import with a runtime-constructed path so that
// TypeScript does not traverse into the submodule (which has incompatible tsconfig settings).
const pluginPath = (rel: string): string => new URL(rel, import.meta.url).pathname;

function loadPlugin(rel: string): Promise<{ scrape: ScrapeFunction }> {
  return import(/* @vite-ignore */ pluginPath(rel)) as Promise<{ scrape: ScrapeFunction }>;
}

// ─── Auto-discovery ───────────────────────────────────────────────────────────

const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ZenPlugins/src/plugins');

// Directories that are not real bank plugins (no preferences.xml or utility-only).
const SKIP_DIRS = new Set(['bootloader', 'example', 'faktura']);

// Two-letter ISO country codes used as suffixes in ZenPlugin directory names.
const COUNTRY_CODES = new Set([
  'ge',
  'by',
  'ua',
  'kz',
  'rs',
  'md',
  'tr',
  'ec',
  'am',
  'uz',
  'az',
  'vn',
]);

/** Converts a ZenPlugin directory name to a human-readable display name. */
function pluginDirToName(dir: string): string {
  const parts = dir.split('-');
  const last = parts[parts.length - 1] ?? '';
  const isCountryCode = last.length === 2 && COUNTRY_CODES.has(last) && parts.length > 1;

  const nameParts = isCountryCode ? parts.slice(0, -1) : parts;
  const country = isCountryCode ? last.toUpperCase() : null;

  // Short segments (≤4 chars) are treated as acronyms and uppercased.
  const name = nameParts
    .map((p) => (p.length <= 4 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');

  return country ? `${name} (${country})` : name;
}

function parsePreferencesXml(xml: string): {
  fields: CredentialField[];
  defaults: Record<string, string>;
} {
  const fields: CredentialField[] = [];
  const defaults: Record<string, string> = {};

  // Match EditTextPreference opening tags (attributes may span multiple lines).
  // [^>]* matches any char except >, including newlines, so no `s` flag needed.
  const editTextRe = /<EditTextPreference([^>]*?)(?:\/>|>)/g;

  for (const m of xml.matchAll(editTextRe)) {
    const attrs = m[1] ?? '';
    const key = /\bkey="([^"]+)"/.exec(attrs)?.[1];
    const title = /\btitle="([^"]+)"/.exec(attrs)?.[1];
    const inputType = /\binputType="([^"]+)"/.exec(attrs)?.[1] ?? 'text';
    const defaultValue = /\bdefaultValue="([^"]+)"/.exec(attrs)?.[1];
    const obligatory = /\bobligatory="true"/.test(attrs);

    if (!key) continue;

    // Auto-fill types — store as defaults, no user prompt.
    if (inputType === 'date' || inputType === 'checkbox') {
      defaults[key] = defaultValue ?? (inputType === 'date' ? '2020-01-01T00:00:00.000Z' : 'false');
      continue;
    }

    // Non-obligatory fields that have a default value — auto-fill silently.
    if (!obligatory && defaultValue !== undefined) {
      defaults[key] = defaultValue;
      continue;
    }

    const type: 'text' | 'password' =
      inputType === 'textPassword' || inputType === 'numberPassword' ? 'password' : 'text';

    fields.push({ name: key, type, prompt: title ?? key });
  }

  // ListPreference — always auto-fill with defaultValue.
  const listRe = /<ListPreference([^>]*?)(?:\/>|>)/g;
  for (const m of xml.matchAll(listRe)) {
    const attrs = m[1] ?? '';
    const key = /\bkey="([^"]+)"/.exec(attrs)?.[1];
    const defaultValue = /\bdefaultValue="([^"]+)"/.exec(attrs)?.[1];
    if (key) defaults[key] = defaultValue ?? 'true';
  }

  return { fields, defaults };
}

function buildRegistry(): Record<string, BankPlugin> {
  const registry: Record<string, BankPlugin> = {};

  let dirs: string[];
  try {
    dirs = readdirSync(PLUGINS_DIR);
  } catch {
    return registry;
  }

  for (const dir of dirs.sort()) {
    if (SKIP_DIRS.has(dir)) continue;

    const pluginDir = join(PLUGINS_DIR, dir);
    const prefsPath = join(pluginDir, 'preferences.xml');
    if (!existsSync(prefsPath)) continue;

    const indexTs = join(pluginDir, 'index.ts');
    const indexJs = join(pluginDir, 'index.js');
    const hasTs = existsSync(indexTs);
    const hasJs = existsSync(indexJs);
    if (!hasTs && !hasJs) continue;

    const relPath = hasTs
      ? `./ZenPlugins/src/plugins/${dir}/index.ts`
      : `./ZenPlugins/src/plugins/${dir}/index.js`;

    let xml: string;
    try {
      xml = readFileSync(prefsPath, 'utf-8');
    } catch {
      continue;
    }

    const { fields, defaults } = parsePreferencesXml(xml);

    registry[dir] = {
      name: pluginDirToName(dir),
      plugin: () => loadPlugin(relPath),
      fields,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    };
  }

  return registry;
}

export const BANK_REGISTRY: Record<string, BankPlugin> = buildRegistry();

export function getBankList(): { key: string; name: string }[] {
  return Object.entries(BANK_REGISTRY)
    .map(([key, plugin]) => ({ key, name: plugin.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds a bank plugin by exact key or by prefix match (e.g. 'tbc' → 'tbc-ge').
 * Returns [resolvedKey, plugin] or null. Used for backward compatibility with DB
 * rows that may store the old short bank_name before auto-discovery renamed keys.
 */
export function lookupBank(query: string): [string, BankPlugin] | null {
  const exact = BANK_REGISTRY[query];
  if (exact) return [query, exact];
  const key = Object.keys(BANK_REGISTRY).find((k) => k.startsWith(`${query}-`));
  const plugin = key ? BANK_REGISTRY[key] : undefined;
  if (key && plugin) return [key, plugin];
  return null;
}
