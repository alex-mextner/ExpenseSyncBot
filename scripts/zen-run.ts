// CLI runner for ZenPlugins — runs a bank plugin without the bot for manual testing.
// With --state-file, auth state persists between runs so myid/OTP only needed on first run.
import { Database } from 'bun:sqlite'
import { createInterface } from 'node:readline'
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createZenMoneyShim } from '../libs/zenmoney-shim'

const [pluginName, ...rest] = process.argv.slice(2)

if (!pluginName) {
  console.error('Usage: bun scripts/zen-run.ts <plugin-name> [--key value ...] [--from YYYY-MM-DD] [--env-prefix PREFIX]')
  console.error('         [--state-file /path/to/state.db]  persist auth state between runs')
  console.error('         [--picture /path/to/photo.jpg]    provide selfie for myid.uz verification')
  console.error('Example: bun scripts/zen-run.ts apelsin-uz --env-prefix ZEN_TEST')
  console.error('         bun scripts/zen-run.ts kapitalbank-uz --env-prefix ZEN_TEST --state-file /tmp/kapital.db --picture ~/selfie.jpg')
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

// --state-file: persist auth state between runs so myid/OTP only needed once.
// Without it, in-memory DB means isFirstRun is always true.
const stateFile = flags['state-file']
delete flags['state-file']

// --picture: path to a JPEG selfie for myid.uz face verification (kapitalbank-uz first run).
const picturePath = flags['picture']
delete flags['picture']

// Credentials: all remaining flags go to preferences
const preferences: Record<string, string> = { ...flags }
delete preferences['from']

const db = stateFile ? new Database(stateFile) : new Database(':memory:')
db.exec(`
  CREATE TABLE IF NOT EXISTS bank_plugin_state (
    connection_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (connection_id, key)
  )
`)

// Log file: logs/zen-run/<plugin>-<timestamp>.log
// Intercept at every level: process streams + console methods.
// console.debug (used by fetchJson for HTTP logs) bypasses process.stdout.write in Bun,
// so we override it explicitly. appendFileSync is synchronous — every write lands immediately.
const logDir = resolve(import.meta.dir, '../logs/zen-run')
mkdirSync(logDir, { recursive: true })
const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const logPath = resolve(logDir, `${pluginName}-${logTs}.log`)
const writeLog = (chunk: unknown) => {
  if (typeof chunk === 'string') appendFileSync(logPath, chunk)
  else if (chunk instanceof Uint8Array) appendFileSync(logPath, chunk)
}
const logArgs = (...args: unknown[]) =>
  appendFileSync(logPath, args.map(a => (typeof a === 'string' ? a : Bun.inspect(a))).join(' ') + '\n')

const _stdout = process.stdout.write.bind(process.stdout)
const _stderr = process.stderr.write.bind(process.stderr)
process.stdout.write = (chunk: Parameters<typeof process.stdout.write>[0], ...rest: Parameters<typeof process.stdout.write>[1 | 2][]) => {
  writeLog(chunk); return _stdout(chunk, ...(rest as []))
}
process.stderr.write = (chunk: Parameters<typeof process.stderr.write>[0], ...rest: Parameters<typeof process.stderr.write>[1 | 2][]) => {
  writeLog(chunk); return _stderr(chunk, ...(rest as []))
}
// Override console methods that Bun routes outside process.stdout.write
const _clog = console.log.bind(console)
const _cerr = console.error.bind(console)
const _cwarn = console.warn.bind(console)
const _cdebug = console.debug.bind(console)
const _cinfo = console.info.bind(console)
console.log = (...a) => { logArgs(...a); _clog(...a) }
console.error = (...a) => { logArgs(...a); _cerr(...a) }
console.warn = (...a) => { logArgs(...a); _cwarn(...a) }
console.debug = (...a) => { logArgs(...a); _cdebug(...a) }
console.info = (...a) => { logArgs(...a); _cinfo(...a) }

console.error(`[zen-run] Log: ${logPath}`)
if (stateFile) console.error(`[zen-run] State file: ${stateFile} (${existsSync(stateFile) ? 'existing' : 'new'})`)

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

// takePicture: read JPEG from --picture path if provided, otherwise fail with a clear message.
const takePictureImpl = picturePath
  ? async (_format: string): Promise<Blob> => {
      console.error(`[zen-run] Reading picture from: ${picturePath}`)
      const bytes = readFileSync(picturePath)
      return new Blob([bytes], { type: 'image/jpeg' })
    }
  : undefined

const shim = createZenMoneyShim(1, db, preferences, readLineImpl, takePictureImpl)
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
