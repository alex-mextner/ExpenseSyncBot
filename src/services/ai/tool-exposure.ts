/**
 * Hybrid tool catalog (#203, step B; same env names and semantics as HyperCalendarBot).
 *
 * `AI_TOOL_SCHEMA_MODE`:
 * - `full` (default): every tool schema in every request.
 * - `hybrid`: a small always-on core (the tools real traffic uses) + a compact index of the rest;
 *   a model that needs an indexed tool calls `discover_tools` and gets its schema next round.
 * - `lazy`: nothing but `calculate` and `discover_tools` up front, everything else via the index.
 *
 * `AI_TOOL_SCHEMA_USER_IDS` limits a non-`full` mode to those Telegram user ids (a canary).
 *
 * The index is part of the mode-static prompt text (identical for every user in that mode), so the
 * prefix a provider caches stays byte-stable; only a round that discovers a tool changes `tools[]`.
 * Revealing a schema never executes anything: a tool called before its schema was revealed is
 * rejected (and revealed) instead of run on guessed arguments.
 */

import type OpenAI from 'openai';
import type { ToolSchemaMode } from './tool-schema-mode';
import { TOOL_DEFINITIONS } from './tools';
import type { ToolResult } from './types';

export const DISCOVERY_TOOL = 'discover_tools';

/** Tools every hybrid request carries a schema for: the ones traffic uses (prod trajectories, #203). */
export const HYBRID_CORE_TOOLS: readonly string[] = [
  'get_expenses',
  'get_budgets',
  'add_expense',
  'delete_expense',
  'calculate',
  'render_table',
  'set_custom_prompt',
  'get_bank_balances',
];

/** Lazy mode keeps only the calculator: rule 7 sends all arithmetic to it. */
const LAZY_CORE_TOOLS: readonly string[] = ['calculate'];

/** Discover calls one run may make before the tool refuses (a model looping on discovery). */
const MAX_DISCOVERY_CALLS = 6;

/** One line per tool that is not always-on in some mode: what it does, enough to decide to load it. */
export const TOOL_INDEX_LINES: Record<string, string> = {
  get_expenses: 'list or total expenses for a period/category',
  get_budgets: 'budget limits and spending progress',
  add_expense: 'record one or several expenses',
  delete_expense: 'delete expenses by id',
  calculate: 'any arithmetic or currency conversion',
  render_table: 'send a Markdown table as an image',
  set_custom_prompt: 'remember a note or rule for the group (the only memory)',
  get_bank_balances: 'balances of connected bank accounts',
  get_categories: 'list expense categories',
  get_group_settings: 'current group settings (currencies, spreadsheet, prompt)',
  get_exchange_rates: 'current exchange rates between supported currencies',
  set_budget: 'set or change category budget limits',
  delete_budget: 'delete category budgets for a month',
  sync_from_sheets: 'replace local expenses with the Google Sheets data',
  sync_budgets: 'pull budgets from the Google Sheets Budget tab',
  manage_category: 'create or delete expense categories',
  update_group_setting:
    'change default currency, enabled currencies, bank cards, custom prompt, topic',
  get_bank_transactions: 'bank transactions for a period',
  send_feedback: 'send feedback or a bug report to the bot admin',
  get_technical_analysis: 'spending trends, forecasts and unusual spikes',
  get_recurring_patterns: 'recurring expenses (rent, subscriptions) and their status',
  manage_recurring_pattern: 'pause, resume, dismiss or delete recurring patterns',
  find_missing_expenses: 'bank debits that are not recorded as expenses',
};

function toolName(tool: OpenAI.ChatCompletionTool): string {
  return tool.type === 'function' ? tool.function.name : tool.type;
}

function coreNames(mode: ToolSchemaMode): readonly string[] {
  return mode === 'hybrid' ? HYBRID_CORE_TOOLS : LAZY_CORE_TOOLS;
}

const DISCOVERY_DEFINITION: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: DISCOVERY_TOOL,
    description:
      'Load the parameter schemas of tools listed in the TOOL INDEX so you can call them in your next round. Pass every tool you need in ONE call. Not needed for tools whose schema is already loaded.',
    parameters: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of the indexed tools to load, e.g. ["update_group_setting"]',
        },
      },
      required: ['tools'],
    },
  },
};

/**
 * Mode-static prompt section listing the tools whose schema is not always loaded; empty in `full`
 * mode. The section only depends on the mode, never on the user or the clock.
 */
export function buildToolIndex(
  mode: ToolSchemaMode,
  catalog: readonly OpenAI.ChatCompletionTool[] = TOOL_DEFINITIONS,
): string {
  if (mode === 'full') return '';
  const core = new Set(coreNames(mode));
  const lines = catalog
    .map(toolName)
    .filter((name) => !core.has(name))
    .map((name) => `- ${name}: ${TOOL_INDEX_LINES[name] ?? name}`);
  return [
    '## TOOL INDEX',
    `Some tools have no parameter schema loaded yet. The tools below exist; to use one, FIRST call ${DISCOVERY_TOOL} with its name(s) (all you need in ONE call) — its schema is loaded for your next round. NEVER call an indexed tool before loading it.`,
    ...lines,
  ].join('\n');
}

/** Per-run exposure state: which schemas the model currently sees and what it may still load. */
export interface ToolExposure {
  readonly mode: ToolSchemaMode;
  /** The tool list a round sends: the always-on core first (stable order), then revealed tools in reveal order. */
  tools(): OpenAI.ChatCompletionTool[];
  isDiscovery(name: string): boolean;
  /** Runs a discover_tools call: reveals the named tools for the next round. Never executes a tool. */
  discover(input: Record<string, unknown>): ToolResult;
  /**
   * A call to a tool whose schema was never shown. A known tool is revealed for the next round and
   * the call is rejected (never run on guessed arguments); an unknown name or an exposed tool
   * returns null and takes the normal path.
   */
  rejectUnexposedCall(name: string): ToolResult | null;
}

export function createToolExposure(
  mode: ToolSchemaMode,
  catalog: readonly OpenAI.ChatCompletionTool[] = TOOL_DEFINITIONS,
): ToolExposure {
  const byName = new Map(catalog.map((tool) => [toolName(tool), tool] as const));
  const exposed: string[] =
    mode === 'full'
      ? catalog.map(toolName)
      : [DISCOVERY_TOOL, ...coreNames(mode).filter((name) => byName.has(name))];
  let discoveryCalls = 0;

  function reveal(name: string): 'revealed' | 'already' | 'unknown' {
    if (exposed.includes(name)) return 'already';
    if (!byName.has(name)) return 'unknown';
    exposed.push(name);
    return 'revealed';
  }

  return {
    mode,

    tools() {
      return exposed.flatMap((name) => {
        if (name === DISCOVERY_TOOL) return [DISCOVERY_DEFINITION];
        const tool = byName.get(name);
        return tool ? [tool] : [];
      });
    },

    isDiscovery(name) {
      return mode !== 'full' && name === DISCOVERY_TOOL;
    },

    discover(input) {
      discoveryCalls++;
      if (discoveryCalls > MAX_DISCOVERY_CALLS) {
        return {
          success: false,
          error: `${DISCOVERY_TOOL} limit reached: use the tools already loaded or say what is unavailable.`,
        };
      }
      const requested = input['tools'];
      if (
        !Array.isArray(requested) ||
        requested.length === 0 ||
        requested.length > 24 ||
        requested.some((name) => typeof name !== 'string')
      ) {
        return {
          success: false,
          error: `${DISCOVERY_TOOL} needs {"tools": ["name", ...]} with names from the TOOL INDEX.`,
        };
      }
      const revealed: string[] = [];
      const already: string[] = [];
      const unknown: string[] = [];
      for (const raw of requested) {
        const name = String(raw).trim();
        const outcome = reveal(name);
        if (outcome === 'revealed') revealed.push(name);
        else if (outcome === 'already') already.push(name);
        else unknown.push(name);
      }
      const parts: string[] = [];
      if (revealed.length > 0) {
        parts.push(`Loaded: ${revealed.join(', ')} — call them in your next round.`);
      }
      if (already.length > 0) parts.push(`Already loaded: ${already.join(', ')}.`);
      if (unknown.length > 0) parts.push(`Not in the index: ${unknown.join(', ')}.`);
      return { success: revealed.length + already.length > 0, output: parts.join(' ') };
    },

    rejectUnexposedCall(name) {
      if (mode === 'full' || exposed.includes(name) || !byName.has(name)) return null;
      reveal(name);
      return {
        success: false,
        error: `TOOL_SCHEMA_NOT_EXPOSED: ${name} had no schema loaded, so it was NOT run. Its schema is loaded now — call it again in your next round with valid parameters (no ${DISCOVERY_TOOL} needed).`,
      };
    },
  };
}
