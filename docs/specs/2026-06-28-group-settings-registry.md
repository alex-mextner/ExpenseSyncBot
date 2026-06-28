# Group Settings Registry

Date: 2026-06-28
Branch: `feat/group-settings-registry`

## Problem

A user asked the AI bot to "change the group's default currency to Egyptian pounds" and the
bot replied it could not — there was no tool for changing group settings. Separately, the
`/settings` command was read-only: it displayed the config and offered a single bank-cards
toggle, nothing else was editable.

The owner's requirement:

1. The AI must be able to change **any** group setting.
2. It must be **architecturally impossible** to add a group setting that the AI (and the
   `/settings` menu) cannot change.
3. `/settings` must become a real editable menu.

All of this must be built around **one** settings registry that is the source of truth for
both the AI tool and the `/settings` UI, so the two can never drift.

## Design

### The registry — `src/services/settings/group-settings-registry.ts`

A `GroupSettingDef` describes one user-configurable group setting:

- `key` — the `UpdateGroupData` column it writes.
- `emoji`, `labelRu` — display metadata.
- `kind` — discriminator: `'currency' | 'currency_multi' | 'toggle' | 'topic' | 'text'`.
- `aiValueHint` — tells the AI what value string to pass.
- `formatValue(group)` — renders the current stored value for display.
- `parse(raw, group)` — robustly parses an LLM/user-supplied string into the typed value, or
  returns a Russian error.
- `apply(group, value)` — persists via `database.groups.update`, plus any side effects.

`GroupSettingDef` is a **discriminated union** of one concrete interface per `kind`, each
pinning `parse`/`apply` to a specific value type (`CurrencyCode`, `CurrencyCode[]`,
`number`, `number | null`, `string | null`). The single shared mutation entry point is:

```ts
applyGroupSetting(def, group, raw): Promise<{ ok: true } | { ok: false; error: string }>
```

It `switch`es on `def.kind`, which narrows `def` to a concrete variant so `parse` and
`apply` stay correlated on the same value type `V` — no `any`, no `as unknown as`.

The five registered settings:

| key | kind | notes |
|-----|------|-------|
| `default_currency` | currency | restricted to `SUPPORTED_CURRENCIES` (they have reliable EUR rates); `apply` also keeps the new code in `enabled_currencies`. |
| `enabled_currencies` | currency_multi | accepts any valid ISO-format code (onboarding parity with custom currencies); always keeps the default currency in the set; dedupes. |
| `custom_prompt` | text | free text; `clear`/`сброс`/empty → `null`. |
| `active_topic_id` | topic | integer, or `clear`/`сброс`/empty → `null`. |
| `bank_cards_enabled` | toggle | `on/off`, `1/0`, `true/false`, `вкл/выкл`, … |

### Enforcement — adding a column can't bypass the registry

Three layers make it a compile error (and a CI runtime error) to add a group setting that
isn't reachable by the AI and the menu:

1. `ALL_UPDATE_KEYS satisfies Record<keyof UpdateGroupData, true>` — an exhaustive map of
   every `UpdateGroupData` key. Adding a column to `UpdateGroupData` without listing it here
   fails to compile.
2. `EditableGroupSettingKey = Exclude<keyof UpdateGroupData, SYSTEM_GROUP_FIELDS[number]>` —
   every update key is either a system field or an editable setting.
3. `GROUP_SETTINGS: { [K in EditableGroupSettingKey]: <def with key K> }` — every editable
   key must have a matching, correctly-typed definition, or it fails to compile.

A runtime test (`group-settings-registry.test.ts`) re-asserts
`Object.keys(GROUP_SETTINGS)` equals `keys(ALL_UPDATE_KEYS)` minus `SYSTEM_GROUP_FIELDS`,
so even a type-system workaround turns CI red. **The guard test fails the moment a new
`UpdateGroupData` column is added without classifying it as either a system field or a
registry-backed setting.**

System fields (`SYSTEM_GROUP_FIELDS`): `title`, `invite_link`, `google_refresh_token`,
`spreadsheet_id`, `bank_panel_summary_message_id`, `oauth_client`.

### AI tool — `update_group_setting`

`tools.ts` defines a single generic tool whose `setting` enum and per-setting value hints
are generated from `GROUP_SETTINGS` (so they never drift). `tool-executor.ts`
`executeUpdateGroupSetting` looks up the registry entry, runs `applyGroupSetting`, and
returns a Russian success/error summary. `executeGetGroupSettings` renders every registry
setting via `formatValue`. The agent system prompt states the AI can change any group
setting and must never deflect to `/settings`.

### Editable `/settings` menu

`buildSettingsView` renders one line per registry setting plus a read-only spreadsheet
line. The keyboard exposes an action per setting; `handleSettingsCallback` routes
`settings:*` callbacks (`edit`, `medit`, `set`, `mtog`, `back`, legacy `bankcards`) through
**the same** `applyGroupSetting` path the AI uses. `callback_data` uses short latin registry
keys + currency codes only (never raw Cyrillic labels), staying within Telegram's 64-byte
limit.

## Decisions / limitations

- `default_currency` is intentionally restricted to `SUPPORTED_CURRENCIES`; a default
  without a built-in EUR rate would break aggregate display (`convertCurrency`). EGP was
  added to `SUPPORTED_CURRENCIES` to satisfy the headline use case.
- Free-text entry (`custom_prompt`) and topic selection (`active_topic_id`) are set by the
  AI tool or existing flows (`/topic`); the menu offers only a "clear/reset" action for them.
- The multi-currency picker sources custom currencies from the enabled set, mirroring the
  onboarding picker (`createCurrencyKeyboard`): unchecking a custom code removes its button.
  Re-adding one is done via `update_group_setting` or `/connect`. A stateful in-menu
  custom-code entry flow was left out of scope.
