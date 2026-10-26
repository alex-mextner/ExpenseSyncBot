// Mini App API handler: HMAC initData validation and routing for /api/* endpoints
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import { type CurrencyCode, isValidCurrencyCode } from '../config/constants.ts';
import { env } from '../config/env.ts';
import { database } from '../database/index.ts';
import { sendDocumentDirect } from '../services/bank/telegram-sender.ts';
import { convertCurrency } from '../services/currency/converter.ts';
import { getExpenseRecorder } from '../services/expense-recorder.ts';
import { extractTextFromImageBuffer } from '../services/receipt/ocr-extractor.ts';
import { fetchReceiptData } from '../services/receipt/receipt-fetcher.ts';
import { type ParseResult, parseReceipt } from '../services/receipt/receipt-parser.ts';
import { createLogger } from '../utils/logger.ts';
import { emitForGroup, subscribeGroup } from './sse-emitter.ts';

const logger = createLogger('miniapp-api');

/** One-hour window for initData freshness (HMAC still validates authenticity) */
const INIT_DATA_TTL_SECONDS = 60 * 60;

/** Compute HMAC-SHA256 and return hex digest */
function hmacSha256(data: string, key: Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Validate Telegram WebApp initData and extract the authenticated Telegram user ID.
 * Returns the user ID on success, or null on failure.
 */
function validateInitData(rawInitData: string): number | null {
  const params = new URLSearchParams(rawInitData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  const expectedHash = hmacSha256(dataCheckString, secretKey);

  if (hash !== expectedHash) return null;

  const authDate = params.get('auth_date');
  if (!authDate) return null;

  const age = Math.floor(Date.now() / 1000) - parseInt(authDate, 10);
  if (age > INIT_DATA_TTL_SECONDS) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw) as { id?: number };
    if (typeof user.id !== 'number') return null;
    return user.id;
  } catch {
    return null;
  }
}

/**
 * Resolve a (telegramGroupId, telegramUserId) pair to internal DB ids.
 *
 * Steps:
 * 1. Find the group by `telegram_group_id`. If missing, return `{ ok: false,
 *    code: 'group_missing' }` — the group was never `/connect`-ed.
 * 2. Find the user by `telegram_id`. If missing, **create** it linked to the
 *    group — this covers the first-open-Mini-App flow where the user has a
 *    valid Telegram identity (HMAC-signed initData) but has never sent a
 *    message to the bot (so `message.handler` never ran). Creating the user
 *    here is safe: the Telegram signature guarantees the identity.
 * 3. If the user exists but belongs to a different group, update its
 *    `group_id` to the current one — matches the behaviour of
 *    `message.handler` and `callback.handler::ensureUserInGroup`.
 */
type GroupResolution =
  | { ok: true; internalGroupId: number; internalUserId: number }
  | { ok: false; code: 'group_missing' | 'not_member' };

function resolveGroupAndEnsureUser(
  telegramGroupId: number,
  telegramUserId: number,
): GroupResolution {
  const group = database.groups.findByTelegramGroupId(telegramGroupId);
  if (!group) {
    return { ok: false, code: 'group_missing' };
  }

  // Check that the user has interacted with the bot inside THIS group at
  // least once (any command, message, or callback creates a group_members
  // entry via trackMembership / requireGroup guard). Without this check,
  // anyone with valid Telegram initData could supply an arbitrary groupId
  // and gain access to someone else's group.
  let user = database.users.findByTelegramId(telegramUserId);
  const isMember =
    (user && user.group_id === group.id) ||
    database.groupMembers.isMember(telegramUserId, group.id);

  if (!isMember) {
    logger.warn(
      { telegramUserId, telegramGroupId, internalGroupId: group.id },
      'Auth rejected: user is not a member of this group',
    );
    return { ok: false, code: 'not_member' };
  }

  // Membership verified — ensure user row exists and is linked to this group
  if (!user) {
    logger.info(
      { telegramUserId, internalGroupId: group.id },
      'Auto-creating user on Mini App first open',
    );
    user = database.users.create({
      telegram_id: telegramUserId,
      group_id: group.id,
    });
  } else if (user.group_id !== group.id) {
    logger.info(
      { telegramUserId, from: user.group_id, to: group.id },
      'Updating user group_id from Mini App auth',
    );
    database.users.update(telegramUserId, { group_id: group.id });
    const refreshed = database.users.findByTelegramId(telegramUserId);
    if (refreshed) user = refreshed;
  }

  return { ok: true, internalGroupId: group.id, internalUserId: user.id };
}

/** Build CORS headers for a given allowed origin */
function buildCorsHeaders(corsOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
  };
}

/** JSON error response with CORS headers */
function errorResponse(
  status: number,
  error: string,
  code: string,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export type ValidContext = {
  ok: true;
  userId: number;
  internalUserId: number;
  groupId: number;
  internalGroupId: number;
  corsHeaders: Record<string, string>;
};

export type InvalidContext = {
  ok: false;
  response: Response;
};

/**
 * Validate initData and resolve group membership.
 * Reusable by route handlers added in later tasks.
 * groupId must be provided as a query param or in the request body by the caller
 * before invoking this function.
 */
export async function validateAndResolveContext(
  req: Request,
  corsOrigin: string,
  telegramGroupId: number,
): Promise<ValidContext | InvalidContext> {
  const corsHeaders = buildCorsHeaders(corsOrigin);

  const rawInitData = req.headers.get('X-Telegram-Init-Data') ?? undefined;
  if (!rawInitData) {
    logger.warn({ telegramGroupId }, 'Auth rejected: missing X-Telegram-Init-Data header');
    return {
      ok: false,
      response: errorResponse(
        401,
        'Missing X-Telegram-Init-Data header',
        'INVALID_INIT_DATA',
        corsHeaders,
      ),
    };
  }

  // Early expiry check: return INIT_DATA_EXPIRED code specifically (validateInitData returns null without distinction)
  const params = new URLSearchParams(rawInitData);
  const authDate = params.get('auth_date');
  if (authDate) {
    const age = Math.floor(Date.now() / 1000) - parseInt(authDate, 10);
    if (age > INIT_DATA_TTL_SECONDS) {
      logger.warn(
        { telegramGroupId, ageSec: age, ttl: INIT_DATA_TTL_SECONDS },
        'Auth rejected: initData expired',
      );
      return {
        ok: false,
        response: errorResponse(401, 'initData expired', 'INIT_DATA_EXPIRED', corsHeaders),
      };
    }
  }

  const userId = validateInitData(rawInitData);
  if (userId === null) {
    logger.warn(
      { telegramGroupId },
      'Auth rejected: invalid initData (HMAC mismatch or malformed)',
    );
    return {
      ok: false,
      response: errorResponse(401, 'Invalid initData', 'INVALID_INIT_DATA', corsHeaders),
    };
  }

  // HMAC verified → Telegram identity is trusted. Resolve the group and
  // auto-create the user row if this is the first time we see them.
  const resolution = resolveGroupAndEnsureUser(telegramGroupId, userId);
  if (!resolution.ok) {
    const message =
      resolution.code === 'not_member'
        ? 'Not a member of this group — send a message in the group first'
        : 'Group not configured — run /connect in the group first';
    logger.warn({ userId, telegramGroupId, code: resolution.code }, `Auth rejected: ${message}`);
    return {
      ok: false,
      response: errorResponse(403, message, 'FORBIDDEN_GROUP', corsHeaders),
    };
  }

  return {
    ok: true,
    userId,
    internalUserId: resolution.internalUserId,
    groupId: telegramGroupId,
    internalGroupId: resolution.internalGroupId,
    corsHeaders,
  };
}

type CorsHeaders = Record<string, string>;

/** Everything a route handler needs from the dispatcher. */
interface RouteArgs {
  req: Request;
  url: URL;
  corsOrigin: string;
  corsHeaders: CorsHeaders;
}

type RouteHandler = (args: RouteArgs) => Promise<Response>;

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; response: Response };

/** 200 JSON response with CORS headers */
function jsonResponse(body: unknown, corsHeaders: CorsHeaders): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

/** Read the `groupId` query param (GET-style routes and receipt scan/OCR). */
function parseQueryGroupId(url: URL, corsHeaders: CorsHeaders): ParseOutcome<number> {
  const groupIdParam = url.searchParams.get('groupId');
  const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
  if (Number.isNaN(telegramGroupId)) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'Missing or invalid groupId query param',
        'BAD_REQUEST',
        corsHeaders,
      ),
    };
  }
  return { ok: true, value: telegramGroupId };
}

/** Read `groupId` from an already-parsed JSON body (POST/PUT routes). */
function parseBodyGroupId(groupId: unknown, corsHeaders: CorsHeaders): ParseOutcome<number> {
  const telegramGroupId = typeof groupId === 'number' ? groupId : Number.NaN;
  if (Number.isNaN(telegramGroupId)) {
    return {
      ok: false,
      response: errorResponse(400, 'Missing or invalid groupId', 'BAD_REQUEST', corsHeaders),
    };
  }
  return { ok: true, value: telegramGroupId };
}

/** Parse a JSON request body; a malformed body becomes a 400 response. */
async function parseJsonBody<T>(
  req: Request,
  failureLogMessage: string,
  corsHeaders: CorsHeaders,
): Promise<ParseOutcome<T>> {
  try {
    return { ok: true, value: (await req.json()) as T };
  } catch (parseError) {
    logger.warn({ err: parseError }, failureLogMessage);
    return {
      ok: false,
      response: errorResponse(400, 'Invalid JSON body', 'BAD_REQUEST', corsHeaders),
    };
  }
}

/** Parse receipt text using the group's category names */
async function parseReceiptForGroup(text: string, internalGroupId: number): Promise<ParseResult> {
  const categoryNames = database.categories.findByGroupId(internalGroupId).map((c) => c.name);
  return parseReceipt(text, categoryNames);
}

/** Client-facing receipt payload (items plus optional currency/date) */
function buildReceiptPayload(result: ParseResult) {
  const items = result.items.map((item) => ({
    name: item.name_ru,
    qty: item.quantity,
    price: item.price,
    total: item.total,
    category: item.category,
  }));
  return {
    items,
    ...(result.currency !== undefined ? { currency: result.currency } : {}),
    ...(result.date !== undefined ? { date: result.date } : {}),
  };
}

function logReceiptParsed(
  userId: number,
  result: ParseResult,
  itemCount: number,
  message: string,
): void {
  logger.info(
    { userId, itemCount, verified: result.sumVerified, rounds: result.calculateSumRounds },
    message,
  );
}

// ── POST /api/receipt/scan ───────────────────────────────────────────────────

async function handleReceiptScan({ req, url, corsOrigin, corsHeaders }: RouteArgs) {
  const group = parseQueryGroupId(url, corsHeaders);
  if (!group.ok) return group.response;
  const telegramGroupId = group.value;

  const parsedBody = await parseJsonBody<{ qr?: unknown }>(
    req,
    'Failed to parse request body',
    corsHeaders,
  );
  if (!parsedBody.ok) return parsedBody.response;

  const { qr } = parsedBody.value;
  if (typeof qr !== 'string' || qr.trim() === '') {
    return errorResponse(400, 'Missing required field: qr', 'BAD_REQUEST', corsHeaders);
  }

  const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
  if (!ctx.ok) return ctx.response;

  logger.info(
    { userId: ctx.userId, groupId: telegramGroupId, qrLength: qr.length },
    'Receipt QR scan started',
  );

  try {
    const html = await fetchReceiptData(qr);
    const result = await parseReceiptForGroup(html, ctx.internalGroupId);
    const payload = buildReceiptPayload(result);
    logReceiptParsed(ctx.userId, result, payload.items.length, 'Receipt QR scan completed');
    return jsonResponse(payload, ctx.corsHeaders);
  } catch (err) {
    logger.error({ err, userId: ctx.userId, groupId: telegramGroupId }, 'Receipt scan failed');
    notifyScanFailure('QR scan', qr, err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
    return errorResponse(500, 'Receipt scan failed', 'SCAN_FAILED', corsHeaders);
  }
}

// ── POST /api/receipt/ocr ────────────────────────────────────────────────────

const OCR_MAX_BYTES = 2 * 1024 * 1024;

/** Extract and validate the uploaded `image` field (JPEG, <= 2 MB). */
async function readOcrImage(req: Request, corsHeaders: CorsHeaders): Promise<ParseOutcome<Blob>> {
  let imageBlob: Blob;
  try {
    const formData = await req.formData();
    const field = formData.get('image');
    if (!field || !(field instanceof Blob)) {
      return {
        ok: false,
        response: errorResponse(400, 'Missing required field: image', 'BAD_REQUEST', corsHeaders),
      };
    }
    imageBlob = field;
  } catch (parseError) {
    logger.warn({ err: parseError }, 'Failed to parse multipart form data');
    return {
      ok: false,
      response: errorResponse(400, 'Invalid multipart form data', 'BAD_REQUEST', corsHeaders),
    };
  }

  if (imageBlob.type !== 'image/jpeg') {
    return {
      ok: false,
      response: errorResponse(
        415,
        'Only image/jpeg is accepted',
        'UNSUPPORTED_MEDIA_TYPE',
        corsHeaders,
      ),
    };
  }

  if (imageBlob.size > OCR_MAX_BYTES) {
    return {
      ok: false,
      response: errorResponse(413, 'Image exceeds 2 MB limit', 'PAYLOAD_TOO_LARGE', corsHeaders),
    };
  }

  return { ok: true, value: imageBlob };
}

/** Upload image to Telegram to get a file_id for later use in the confirm step */
async function uploadReceiptImage(image: Buffer, chatId: number): Promise<string | null> {
  const tgFormData = new FormData();
  tgFormData.append('document', new File([image], 'receipt.jpg', { type: 'image/jpeg' }));
  tgFormData.append('chat_id', String(chatId));

  try {
    const telegramResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: tgFormData,
    });
    const tgResult = (await telegramResp.json()) as {
      ok: boolean;
      result?: { document?: { file_id: string } };
    };
    return tgResult.result?.document?.file_id ?? null;
  } catch (tgError) {
    logger.warn(
      { err: tgError },
      '[OCR] Failed to upload receipt to Telegram, continuing without file_id',
    );
    return null;
  }
}

async function compressReceiptImage(imageBlob: Blob): Promise<Buffer> {
  const rawBuffer = Buffer.from(await imageBlob.arrayBuffer());
  return sharp(rawBuffer)
    .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function handleReceiptOcr({ req, url, corsOrigin, corsHeaders }: RouteArgs) {
  const group = parseQueryGroupId(url, corsHeaders);
  if (!group.ok) return group.response;
  const telegramGroupId = group.value;

  // Authenticate before consuming the request body to avoid processing untrusted uploads
  const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
  if (!ctx.ok) return ctx.response;

  logger.info({ userId: ctx.userId, groupId: telegramGroupId }, 'Receipt OCR upload started');

  const image = await readOcrImage(req, ctx.corsHeaders);
  if (!image.ok) return image.response;

  try {
    const compressedBuffer = await compressReceiptImage(image.value);
    const ocrText = await extractTextFromImageBuffer(compressedBuffer);
    const result = await parseReceiptForGroup(ocrText, ctx.internalGroupId);
    const fileId = await uploadReceiptImage(compressedBuffer, ctx.groupId);

    const payload = buildReceiptPayload(result);
    logReceiptParsed(ctx.userId, result, payload.items.length, 'Receipt OCR completed');
    return jsonResponse({ ...payload, file_id: fileId }, ctx.corsHeaders);
  } catch (err) {
    logger.error({ err, userId: ctx.userId, groupId: telegramGroupId }, 'OCR processing failed');
    notifyScanFailure('OCR', '[image upload]', err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
    return errorResponse(500, 'OCR processing failed', 'OCR_FAILED', corsHeaders);
  }
}

// ── POST /api/receipt/confirm ────────────────────────────────────────────────

/** Expected shape of each receipt item from the Mini App client */
interface ConfirmItemInput {
  name?: unknown;
  total?: unknown;
  category?: unknown;
  currency?: unknown;
  qty?: unknown;
  price?: unknown;
}

function isValidConfirmItem(item: ConfirmItemInput): boolean {
  return (
    typeof item.name === 'string' &&
    typeof item.total === 'number' &&
    Number.isFinite(item.total) &&
    item.total > 0 &&
    typeof item.category === 'string' &&
    typeof item.currency === 'string' &&
    isValidCurrencyCode(item.currency)
  );
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Receipt date (one for the whole receipt, not per item). Fall back to today. */
function resolveReceiptDate(rawDate: unknown): string {
  return typeof rawDate === 'string' && ISO_DATE_RE.test(rawDate)
    ? rawDate
    : new Date().toISOString().slice(0, 10);
}

/** Notify SSE subscribers; a failing emit must never fail the confirm. */
function emitExpenseAdded(internalGroupId: number): void {
  try {
    emitForGroup(internalGroupId, 'expense_added');
  } catch (emitError) {
    logger.warn({ err: emitError }, 'SSE emit failed, continuing');
  }
}

async function handleReceiptConfirm({ req, corsOrigin, corsHeaders }: RouteArgs) {
  const parsedBody = await parseJsonBody<{
    groupId?: unknown;
    fileId?: unknown;
    date?: unknown;
    expenses?: unknown;
  }>(req, 'Failed to parse confirm request body', corsHeaders);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;

  const group = parseBodyGroupId(body.groupId, corsHeaders);
  if (!group.ok) return group.response;
  const telegramGroupId = group.value;

  if (!Array.isArray(body.expenses) || body.expenses.length === 0) {
    return errorResponse(400, 'Missing or empty expenses array', 'BAD_REQUEST', corsHeaders);
  }

  const itemInputs = body.expenses as ConfirmItemInput[];
  if (!itemInputs.every(isValidConfirmItem)) {
    return errorResponse(
      400,
      'Each item must have name (string), total (positive finite number), category (string), currency (valid ISO code)',
      'BAD_REQUEST',
      corsHeaders,
    );
  }

  const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
  if (!ctx.ok) return ctx.response;

  const fileId = typeof body.fileId === 'string' ? body.fileId : null;
  const date = resolveReceiptDate(body.date);

  logger.info(
    {
      userId: ctx.userId,
      groupId: telegramGroupId,
      itemCount: itemInputs.length,
      date,
      hasFileId: fileId !== null,
    },
    'Receipt confirm started',
  );

  try {
    const recorder = getExpenseRecorder();
    const result = await recorder.recordReceipt(ctx.internalGroupId, ctx.internalUserId, {
      date,
      receiptFileId: fileId,
      items: itemInputs.map((item) => ({
        name: item.name as string,
        quantity: typeof item.qty === 'number' && item.qty > 0 ? item.qty : 1,
        price: typeof item.price === 'number' ? item.price : (item.total as number),
        total: item.total as number,
        currency: item.currency as CurrencyCode,
        category: item.category as string,
      })),
    });

    emitExpenseAdded(ctx.internalGroupId);

    logger.info(
      {
        userId: ctx.userId,
        created: result.expenses.length,
        categories: result.categoriesAffected.length,
      },
      'Receipt confirm completed',
    );

    return jsonResponse({ created: result.expenses.length }, ctx.corsHeaders);
  } catch (err) {
    logger.error({ err, userId: ctx.userId, groupId: telegramGroupId }, 'Receipt confirm failed');
    return errorResponse(500, 'Failed to save expenses', 'CONFIRM_FAILED', corsHeaders);
  }
}

// ── GET /api/analytics ───────────────────────────────────────────────────────

/** Row returned by the per-category aggregation query */
interface CategoryRow {
  category: string;
  total: number;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

async function handleAnalytics({ req, url, corsOrigin, corsHeaders }: RouteArgs) {
  const parsedGroup = parseQueryGroupId(url, corsHeaders);
  if (!parsedGroup.ok) return parsedGroup.response;

  const ctx = await validateAndResolveContext(req, corsOrigin, parsedGroup.value);
  if (!ctx.ok) return ctx.response;

  const periodParam = url.searchParams.get('period');
  const period =
    periodParam && /^\d{4}-\d{2}$/.test(periodParam)
      ? periodParam
      : new Date().toISOString().slice(0, 7);

  const group = database.groups.findById(ctx.internalGroupId);
  if (!group) {
    return errorResponse(500, 'Group not found', 'INTERNAL_ERROR', corsHeaders);
  }

  const rows = database.queryAll<CategoryRow>(
    `SELECT category, SUM(eur_amount) as total
       FROM expenses
       WHERE group_id = ? AND date LIKE ?
       GROUP BY category`,
    ctx.internalGroupId,
    `${period}-%`,
  );

  const defaultCurrency = group.default_currency as CurrencyCode;

  let totalEur = 0;
  const byCategory: Record<string, number> = {};

  for (const row of rows) {
    totalEur += row.total;
    byCategory[row.category] = roundCents(convertCurrency(row.total, 'EUR', defaultCurrency));
  }

  const totalInDefault = roundCents(convertCurrency(totalEur, 'EUR', defaultCurrency));

  return jsonResponse(
    {
      period,
      defaultCurrency,
      income: 0,
      expenses: totalInDefault,
      balance: -totalInDefault,
      savings: 0,
      byCategory,
    },
    ctx.corsHeaders,
  );
}

// ── GET /api/dashboard ───────────────────────────────────────────────────────

/** Row shape from dashboard_widgets table */
interface DashboardRow {
  config: string;
  updated_at: string;
}

function parseWidgetsConfig(config: string): unknown[] {
  try {
    return JSON.parse(config) as unknown[];
  } catch {
    return [];
  }
}

async function handleDashboardGet({ req, url, corsOrigin, corsHeaders }: RouteArgs) {
  const group = parseQueryGroupId(url, corsHeaders);
  if (!group.ok) return group.response;

  const ctx = await validateAndResolveContext(req, corsOrigin, group.value);
  if (!ctx.ok) return ctx.response;

  const row = database.queryOne<DashboardRow>(
    'SELECT config, updated_at FROM dashboard_widgets WHERE group_id = ? AND user_id = ?',
    ctx.internalGroupId,
    ctx.internalUserId,
  );

  if (!row) {
    return jsonResponse({ widgets: [], updatedAt: null }, ctx.corsHeaders);
  }

  return jsonResponse(
    { widgets: parseWidgetsConfig(row.config), updatedAt: row.updated_at },
    ctx.corsHeaders,
  );
}

// ── PUT /api/dashboard ───────────────────────────────────────────────────────

/** Row shape for conflict check */
interface DashboardUpdatedAtRow {
  updated_at: string;
}

/**
 * Upsert the user's dashboard config. SELECT + UPDATE/INSERT must be atomic to
 * prevent lost updates under concurrent writes. Returns true on conflict
 * (client's updatedAt is stale), in which case nothing is written.
 */
function saveDashboardConfig(
  ctx: ValidContext,
  configJson: string,
  clientUpdatedAt: string | null,
  newUpdatedAt: string,
): boolean {
  return database.transaction(() => {
    const row = database.queryOne<DashboardUpdatedAtRow>(
      'SELECT updated_at FROM dashboard_widgets WHERE group_id = ? AND user_id = ?',
      ctx.internalGroupId,
      ctx.internalUserId,
    );

    if (row && clientUpdatedAt !== null && row.updated_at !== clientUpdatedAt) {
      return true; // conflict
    }

    if (row) {
      database.exec(
        'UPDATE dashboard_widgets SET config = ?, updated_at = ? WHERE group_id = ? AND user_id = ?',
        configJson,
        newUpdatedAt,
        ctx.internalGroupId,
        ctx.internalUserId,
      );
    } else {
      database.exec(
        'INSERT INTO dashboard_widgets (group_id, user_id, config, updated_at) VALUES (?, ?, ?, ?)',
        ctx.internalGroupId,
        ctx.internalUserId,
        configJson,
        newUpdatedAt,
      );
    }
    return false;
  });
}

async function handleDashboardPut({ req, corsOrigin, corsHeaders }: RouteArgs) {
  const parsedBody = await parseJsonBody<{
    groupId?: unknown;
    widgets?: unknown;
    updatedAt?: unknown;
  }>(req, 'Failed to parse dashboard PUT body', corsHeaders);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;

  const group = parseBodyGroupId(body.groupId, corsHeaders);
  if (!group.ok) return group.response;

  const ctx = await validateAndResolveContext(req, corsOrigin, group.value);
  if (!ctx.ok) return ctx.response;

  const clientUpdatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : null;
  const newUpdatedAt = new Date().toISOString();
  const configJson = JSON.stringify(Array.isArray(body.widgets) ? body.widgets : []);

  if (saveDashboardConfig(ctx, configJson, clientUpdatedAt, newUpdatedAt)) {
    return errorResponse(
      409,
      'Dashboard was modified by another client',
      'CONFLICT',
      ctx.corsHeaders,
    );
  }

  return jsonResponse({ ok: true, updatedAt: newUpdatedAt }, ctx.corsHeaders);
}

// ── GET /api/dashboard/events (SSE) ──────────────────────────────────────────

const SSE_PING = 'event: ping\ndata: {}\n\n';

/** SSE stream for a group: initial ping, then a keep-alive ping every 30 s. */
function createGroupEventStream(internalGroupId: number): ReadableStream {
  let unsub: (() => void) | null = null;
  let pingInterval: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (msg: string) => {
        try {
          controller.enqueue(encoder.encode(msg));
        } catch {
          // controller may be closed already — ignore
        }
      };

      unsub = subscribeGroup(internalGroupId, send);

      // Send an initial ping so client knows the connection is alive
      send(SSE_PING);

      pingInterval = setInterval(() => {
        send(SSE_PING);
      }, 30_000);
    },
    cancel() {
      if (unsub) unsub();
      clearInterval(pingInterval);
    },
  });
}

async function handleDashboardEvents({ req, url, corsOrigin, corsHeaders }: RouteArgs) {
  const group = parseQueryGroupId(url, corsHeaders);
  if (!group.ok) return group.response;

  // EventSource doesn't support custom headers — initData comes as query param
  const initData = url.searchParams.get('initData') ?? '';
  const syntheticReq = new Request(req.url, {
    headers: { ...Object.fromEntries(req.headers), 'X-Telegram-Init-Data': initData },
  });

  const ctx = await validateAndResolveContext(syntheticReq, corsOrigin, group.value);
  if (!ctx.ok) return ctx.response;

  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...ctx.corsHeaders,
  };

  return new Response(createGroupEventStream(ctx.internalGroupId), {
    status: 200,
    headers: sseHeaders,
  });
}

// ── GET /api/user/groups ─────────────────────────────────────────────────────
// Returns groups the authenticated user belongs to (no groupId required)

/** initData-only authentication (no group resolution) for /api/user/groups. */
function authenticateUserOnly(req: Request, corsHeaders: CorsHeaders): ParseOutcome<number> {
  const rawInitData = req.headers.get('X-Telegram-Init-Data') ?? undefined;
  if (!rawInitData) {
    logger.warn('Auth rejected: missing X-Telegram-Init-Data header (user/groups)');
    return {
      ok: false,
      response: errorResponse(
        401,
        'Missing X-Telegram-Init-Data header',
        'INVALID_INIT_DATA',
        corsHeaders,
      ),
    };
  }

  // Early expiry check with specific code for frontend session recovery
  const groupsAuthDate = new URLSearchParams(rawInitData).get('auth_date');
  if (groupsAuthDate) {
    const age = Math.floor(Date.now() / 1000) - parseInt(groupsAuthDate, 10);
    if (age > INIT_DATA_TTL_SECONDS) {
      logger.warn(
        { ageSec: age, ttl: INIT_DATA_TTL_SECONDS },
        'Auth rejected: initData expired (user/groups)',
      );
      return {
        ok: false,
        response: errorResponse(401, 'initData expired', 'INIT_DATA_EXPIRED', corsHeaders),
      };
    }
  }

  const userId = validateInitData(rawInitData);
  if (userId === null) {
    logger.warn('Auth rejected: invalid initData (user/groups)');
    return {
      ok: false,
      response: errorResponse(401, 'Invalid initData', 'INVALID_INIT_DATA', corsHeaders),
    };
  }

  return { ok: true, value: userId };
}

async function handleUserGroups({ req, corsHeaders }: RouteArgs) {
  const auth = authenticateUserOnly(req, corsHeaders);
  if (!auth.ok) return auth.response;

  const user = database.users.findByTelegramId(auth.value);
  if (!user || !user.group_id) {
    return jsonResponse({ groups: [], botUsername: env.BOT_USERNAME }, corsHeaders);
  }

  const group = database.groups.findById(user.group_id);
  const groups = group ? [{ telegramGroupId: group.telegram_group_id }] : [];

  return jsonResponse({ groups, botUsername: env.BOT_USERNAME }, corsHeaders);
}

/** Route table keyed by "METHOD /path" */
const ROUTES: Readonly<Record<string, RouteHandler>> = {
  'POST /api/receipt/scan': handleReceiptScan,
  'POST /api/receipt/ocr': handleReceiptOcr,
  'POST /api/receipt/confirm': handleReceiptConfirm,
  'GET /api/analytics': handleAnalytics,
  'GET /api/dashboard': handleDashboardGet,
  'PUT /api/dashboard': handleDashboardPut,
  'GET /api/dashboard/events': handleDashboardEvents,
  'GET /api/user/groups': handleUserGroups,
};

/**
 * Handle all /api/* requests for the Mini App.
 * Returns null if the path does not start with /api/.
 */
export async function handleMiniAppRequest(
  req: Request,
  corsOrigin: string,
): Promise<Response | null> {
  // Defensive URL parsing: port scanners send malformed HTTP that makes Bun
  // hand us a relative URL, which would otherwise throw TypeError on every
  // probe and crash the process. The base is only used when req.url is
  // already relative.
  let url: URL;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return null;
  }

  if (!url.pathname.startsWith('/api/')) return null;

  const corsHeaders = buildCorsHeaders(corsOrigin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  logger.info({ method: req.method, path: url.pathname, query: url.search }, 'API request');

  const handler = ROUTES[`${req.method} ${url.pathname}`];
  if (!handler) return errorResponse(404, 'Not Found', 'NOT_FOUND', corsHeaders);
  return handler({ req, url, corsOrigin, corsHeaders });
}

/** Send scan failure report to admin with detailed log file */
async function notifyScanFailure(source: string, input: string, error: unknown): Promise<void> {
  const adminChatId = env.BOT_ADMIN_CHAT_ID;
  if (!adminChatId) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const timestamp = new Date().toISOString();

  const report = [
    `=== Receipt Scan Failure Report ===`,
    `Timestamp: ${timestamp}`,
    `Source: ${source}`,
    ``,
    `--- Input ---`,
    input.length > 5000
      ? `${input.substring(0, 5000)}\n... (truncated, ${input.length} chars total)`
      : input,
    ``,
    `--- Error ---`,
    `Message: ${err.message}`,
    `Stack: ${err.stack ?? 'N/A'}`,
  ].join('\n');

  const filename = `scan-failure-${timestamp.replace(/[:.]/g, '-')}.log`;
  const file = new File([report], filename, { type: 'text/plain' });

  await sendDocumentDirect(adminChatId, file, `⚠️ <b>${source} failed</b>`);
}
