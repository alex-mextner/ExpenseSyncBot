/**
 * Re-point existing groups' Mini App menu buttons at the current MINIAPP_URL.
 *
 * /connect sets a per-chat `web_app` menu button with `${MINIAPP_URL}?groupId=<chatId>`
 * (see setMiniAppMenuButton in src/bot/commands/connect.ts). Telegram stores that URL,
 * so after MINIAPP_URL moves to a new host, existing groups keep opening the old one
 * until the button is set again. Run this once after updating MINIAPP_URL in .env.
 *
 * Only chats whose current menu button is already a `web_app` button are touched, so
 * groups that never finished /connect don't get a button they never had.
 *
 * Dry run by default (reads current buttons only); pass --apply to call setChatMenuButton.
 *
 * Prod:  cd /var/www/ExpenseSyncBot && bun run scripts/update-menu-buttons.ts [--apply]
 * Stage: cd /var/www/ExpenseSyncBot-stage && \
 *        bun --no-env-file --env-file=.env /var/www/ExpenseSyncBot/scripts/update-menu-buttons.ts [--apply]
 *   (--no-env-file matters: without it Bun also loads the prod .env from the script's project dir.)
 */

import { Database } from 'bun:sqlite';

const APPLY = process.argv.includes('--apply');

const botToken = process.env['BOT_TOKEN'];
const miniAppUrl = process.env['MINIAPP_URL'];
const databasePath = process.env['DATABASE_PATH'] || './data/expenses.db';

if (!botToken || !miniAppUrl) {
  console.error('BOT_TOKEN and MINIAPP_URL must be set (load the bot .env).');
  process.exit(1);
}

/** Calls a Bot API method; returns `result` on success, otherwise an error description. */
async function callBotApi(
  method: string,
  params: object,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === 'object' && 'ok' in body && body.ok === true && 'result' in body) {
      return { ok: true, result: body.result };
    }
    const description =
      body && typeof body === 'object' && 'description' in body ? String(body.description) : `HTTP ${response.status}`;
    return { ok: false, error: description };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const db = new Database(databasePath, { readonly: true });
const chatIds = db
  .query<{ telegram_group_id: number }, []>('SELECT telegram_group_id FROM groups ORDER BY id')
  .all()
  .map((row) => row.telegram_group_id);
db.close();

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${chatIds.length} groups from ${databasePath}, url ${miniAppUrl}`);

let updated = 0;
let skipped = 0;
let failed = 0;
for (const chatId of chatIds) {
  const url = `${miniAppUrl}?groupId=${chatId}`;
  // Telegram allows ~30 requests/second per bot; at most two calls per 100 ms stays well under.
  await Bun.sleep(100);

  const current = await callBotApi('getChatMenuButton', { chat_id: chatId });
  if (!current.ok) {
    // Groups the bot was removed from, or that migrated to a supergroup, fail here.
    failed++;
    console.warn(`failed ${chatId}: ${current.error}`);
    continue;
  }
  const button = current.result;
  if (!button || typeof button !== 'object' || !('type' in button) || button.type !== 'web_app') {
    skipped++;
    continue;
  }
  const currentUrl =
    'web_app' in button && button.web_app && typeof button.web_app === 'object' && 'url' in button.web_app
      ? String(button.web_app.url)
      : '?';
  // Keep whatever label the chat has; /connect uses 'Расходы'.
  const text = 'text' in button && typeof button.text === 'string' ? button.text : 'Расходы';
  if (currentUrl === url) {
    skipped++;
    continue;
  }
  if (!APPLY) {
    updated++;
    console.log(`would set ${chatId}: ${currentUrl} → ${url}`);
    continue;
  }

  const set = await callBotApi('setChatMenuButton', {
    chat_id: chatId,
    menu_button: { type: 'web_app', text, web_app: { url } },
  });
  if (set.ok) {
    updated++;
    console.log(`set ${chatId}: ${currentUrl} → ${url}`);
  } else {
    failed++;
    console.warn(`failed ${chatId}: ${set.error}`);
  }
}

console.log(
  `${APPLY ? 'updated' : 'would update'}: ${updated}, skipped (no web_app button / already current): ${skipped}, failed: ${failed}`,
);
if (failed > 0) process.exitCode = 1;
