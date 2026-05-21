// CLI runner for ZenPlugins — runs a bank plugin without the bot for manual testing.
import { Database } from 'bun:sqlite'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { createZenMoneyShim } from '../libs/zenmoney-shim'

const [pluginName, ...rest] = process.argv.slice(2)

if (!pluginName) {
  console.error('Usage: bun scripts/zen-run.ts <plugin-name> [--key value ...] [--from YYYY-MM-DD]')
  console.error('Example: bun scripts/zen-run.ts apelsin-uz --phone 998901234567 --password Secret1')
  process.exit(1)
}

// Parse --key value pairs from remaining args
const flags: Record<string, string> = {}
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '')
  const val = rest[i + 1]
  if (key && val !== undefined) flags[key] = val
}

if (rest.length % 2 !== 0) {
  console.error(`[zen-run] Flag "--${rest[rest.length - 1]?.replace(/^--/, '')}" has no value.`)
  process.exit(1)
}

const fromDate = flags['from'] ? new Date(flags['from']) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

if (isNaN(fromDate.getTime())) {
  console.error(`[zen-run] Invalid --from date: "${flags['from']}". Use YYYY-MM-DD format.`)
  process.exit(1)
}
const toDate = new Date()

// Credentials: all flags except 'from' go to preferences
const preferences: Record<string, string> = { ...flags }
delete preferences['from']

// In-memory SQLite with the required table
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE bank_plugin_state (
    connection_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (connection_id, key)
  )
`)

// readline for OTP prompts
const rl = createInterface({ input: process.stdin, output: process.stderr })
const readLineImpl = (prompt: string): Promise<string> =>
  new Promise(resolve => rl.question(`\n[OTP] ${prompt}: `, resolve))

const shim = createZenMoneyShim(1, db, preferences, readLineImpl)
;(globalThis as unknown as Record<string, unknown>)['ZenMoney'] = shim

const pluginPath = resolve(
  import.meta.dir,
  '../src/services/bank/ZenPlugins/src/plugins',
  pluginName,
  'index.js',
)

const isFirstRun = !db.query('SELECT 1 FROM bank_plugin_state WHERE connection_id = 1').get()

console.error(`[zen-run] Loading plugin: ${pluginName}`)
console.error(`[zen-run] isFirstRun: ${isFirstRun}`)
console.error(`[zen-run] fromDate: ${fromDate.toISOString()}`)

const pluginModule = await import(pluginPath) as { scrape: (args: {
  preferences: Record<string, string>
  fromDate: Date
  toDate: Date
  isFirstRun: boolean
}) => Promise<{ accounts: unknown[]; transactions: unknown[] }> }

try {
  const result = await pluginModule.scrape({ preferences, fromDate, toDate, isFirstRun })
  console.log(JSON.stringify({ accounts: result.accounts, transactions: result.transactions }, null, 2))
  console.error(`[zen-run] Done: ${result.accounts.length} accounts, ${result.transactions.length} transactions`)
} catch (err) {
  console.error('[zen-run] Plugin error:', err)
  process.exit(1)
} finally {
  rl.close()
}
