// CLI runner for ZenPlugins — runs a bank plugin without the bot for manual testing.
// Note: uses in-memory SQLite — isFirstRun is always true, auth state does not persist between runs.
import { Database } from 'bun:sqlite'
import { createInterface } from 'node:readline'
import { mkdirSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createZenMoneyShim } from '../libs/zenmoney-shim'

const [pluginName, ...rest] = process.argv.slice(2)

if (!pluginName) {
  console.error('Usage: bun scripts/zen-run.ts <plugin-name> [--key value ...] [--from YYYY-MM-DD] [--env-prefix PREFIX]')
  console.error('Example: bun scripts/zen-run.ts apelsin-uz --env-prefix ZEN_TEST')
  console.error('         bun scripts/zen-run.ts apelsin-uz --phone 998901234567 --password Secret1')
  process.exit(1)
}

// Parse --key value pairs from remaining args
const flags: Record<string, string> = {}
for (let i = 0; i < rest.length; i += 2) {
  const raw = rest[i]
  if (!raw?.startsWith('--')) {
    console.error(`[zen-run] Expected --flag, got: "${raw}". All credentials must use --key value format.`)
    process.exit(1)
  }
  const key = raw.slice(2)
  const val = rest[i + 1]
  if (key && val !== undefined) flags[key] = val
}

if (rest.length % 2 !== 0) {
  console.error(`[zen-run] Flag "--${rest[rest.length - 1]?.replace(/^--/, '')}" has no value.`)
  process.exit(1)
}

// --env-prefix ZEN_TEST maps ZEN_TEST_PHONE → phone, ZEN_TEST_IS_RESIDENT → isResident, etc.
// Suffix is snake_case-converted to camelCase so plugin preference keys like isResident match.
if (flags['env-prefix']) {
  const prefix = flags['env-prefix'].toUpperCase() + '_'
  const toCamel = (s: string) => s.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v !== undefined) {
      const key = toCamel(k.slice(prefix.length))
      if (!(key in flags)) flags[key] = v
    }
  }
  delete flags['env-prefix']
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

// Log file: logs/zen-run/<plugin>-<timestamp>.log
// Intercept process.stdout.write + process.stderr.write — the only layer that reliably
// catches output from dynamically imported bundles that bind console at parse time.
const logDir = resolve(import.meta.dir, '../logs/zen-run')
mkdirSync(logDir, { recursive: true })
const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const logPath = resolve(logDir, `${pluginName}-${logTs}.log`)
const writeLog = (chunk: unknown) => {
  if (typeof chunk === 'string') appendFileSync(logPath, chunk)
  else if (chunk instanceof Uint8Array) appendFileSync(logPath, chunk)
}
const _stdout = process.stdout.write.bind(process.stdout)
const _stderr = process.stderr.write.bind(process.stderr)
process.stdout.write = (chunk: Parameters<typeof process.stdout.write>[0], ...rest: Parameters<typeof process.stdout.write>[1 | 2][]) => {
  writeLog(chunk); return _stdout(chunk, ...(rest as []))
}
process.stderr.write = (chunk: Parameters<typeof process.stderr.write>[0], ...rest: Parameters<typeof process.stderr.write>[1 | 2][]) => {
  writeLog(chunk); return _stderr(chunk, ...(rest as []))
}

console.error(`[zen-run] Log: ${logPath}`)

// Catch anything that escapes the main try/catch (e.g. errors inside dynamically loaded modules)
process.on('uncaughtException', (err) => {
  console.error('[zen-run] Uncaught exception:', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[zen-run] Unhandled rejection:', reason)
  process.exit(1)
})

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

try {
  const pluginModule = await import(pluginPath) as { scrape: (args: {
    preferences: Record<string, string>
    fromDate: Date
    toDate: Date
    isFirstRun: boolean
  }) => Promise<{ accounts: unknown[]; transactions: unknown[] }> }

  const result = await pluginModule.scrape({ preferences, fromDate, toDate, isFirstRun })
  console.log(JSON.stringify({ accounts: result.accounts, transactions: result.transactions }, null, 2))
  console.error(`[zen-run] Done: ${result.accounts.length} accounts, ${result.transactions.length} transactions`)
} catch (err) {
  console.error('[zen-run] Plugin error:', err)
  process.exit(1)
} finally {
  rl.close()
}
