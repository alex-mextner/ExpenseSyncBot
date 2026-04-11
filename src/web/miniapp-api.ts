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
import { parseReceipt } from '../services/receipt/receipt-parser.ts';
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
  | { ok: false; code: 'group_missing' };

function resolveGroupAndEnsureUser(
  telegramGroupId: number,
  telegramUserId: number,
): GroupResolution {
  const group = database.groups.findByTelegramGroupId(telegramGroupId);
  if (!group) {
    return { ok: false, code: 'group_missing' };
  }

  let user = database.users.findByTelegramId(telegramUserId);
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
    logger.warn({ userId, telegramGroupId }, 'Auth rejected: group not found');
    return {
      ok: false,
      response: errorResponse(
        403,
        'Group not configured — run /connect in the group first',
        'FORBIDDEN_GROUP',
        corsHeaders,
      ),
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

  if (url.pathname === '/api/receipt/scan' && req.method === 'POST') {
    const groupIdParam = url.searchParams.get('groupId');
    const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(
        400,
        'Missing or invalid groupId query param',
        'BAD_REQUEST',
        corsHeaders,
      );
    }

    let body: { qr?: unknown };
    try {
      body = (await req.json()) as { qr?: unknown };
    } catch (parseError) {
      logger.warn({ err: parseError }, 'Failed to parse request body');
      return errorResponse(400, 'Invalid JSON body', 'BAD_REQUEST', corsHeaders);
    }

    const { qr } = body;
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
      const categoryNames = database.categories
        .findByGroupId(ctx.internalGroupId)
        .map((c) => c.name);
      const result = await parseReceipt(html, categoryNames);

      const items = result.items.map((item) => ({
        name: item.name_ru,
        qty: item.quantity,
        price: item.price,
        total: item.total,
        category: item.category,
      }));

      logger.info(
        {
          userId: ctx.userId,
          itemCount: items.length,
          verified: result.sumVerified,
          rounds: result.calculateSumRounds,
        },
        'Receipt QR scan completed',
      );

      return new Response(
        JSON.stringify({
          items,
          ...(result.currency !== undefined ? { currency: result.currency } : {}),
          ...(result.date !== undefined ? { date: result.date } : {}),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
        },
      );
    } catch (err) {
      logger.error({ err, userId: ctx.userId, groupId: telegramGroupId }, 'Receipt scan failed');
      notifyScanFailure('QR scan', qr, err).catch((e) =>
        logger.warn({ err: e }, 'notifyScanFailure failed'),
      );
      return errorResponse(500, 'Receipt scan failed', 'SCAN_FAILED', corsHeaders);
    }
  }

  if (url.pathname === '/api/receipt/ocr' && req.method === 'POST') {
    const groupIdParam = url.searchParams.get('groupId');
    const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(
        400,
        'Missing or invalid groupId query param',
        'BAD_REQUEST',
        corsHeaders,
      );
    }

    // Authenticate before consuming the request body to avoid processing untrusted uploads
    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    logger.info({ userId: ctx.userId, groupId: telegramGroupId }, 'Receipt OCR upload started');

    let imageBlob: Blob | null = null;
    try {
      const formData = await req.formData();
      const field = formData.get('image');
      if (!field || !(field instanceof Blob)) {
        return errorResponse(400, 'Missing required field: image', 'BAD_REQUEST', ctx.corsHeaders);
      }
      imageBlob = field;
    } catch (parseError) {
      logger.warn({ err: parseError }, 'Failed to parse multipart form data');
      return errorResponse(400, 'Invalid multipart form data', 'BAD_REQUEST', ctx.corsHeaders);
    }

    if (imageBlob.type !== 'image/jpeg') {
      return errorResponse(
        415,
        'Only image/jpeg is accepted',
        'UNSUPPORTED_MEDIA_TYPE',
        ctx.corsHeaders,
      );
    }

    const MAX_BYTES = 2 * 1024 * 1024;
    if (imageBlob.size > MAX_BYTES) {
      return errorResponse(413, 'Image exceeds 2 MB limit', 'PAYLOAD_TOO_LARGE', ctx.corsHeaders);
    }

    let rawBuffer: Buffer | null = null;
    let compressedBuffer: Buffer | null = null;
    try {
      rawBuffer = Buffer.from(await imageBlob.arrayBuffer());
      compressedBuffer = await sharp(rawBuffer)
        .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const ocrText = await extractTextFromImageBuffer(compressedBuffer);

      const categoryNames = database.categories
        .findByGroupId(ctx.internalGroupId)
        .map((c) => c.name);
      const result = await parseReceipt(ocrText, categoryNames);

      // Upload image to Telegram to get a file_id for later use in the confirm step
      const tgFormData = new FormData();
      tgFormData.append(
        'document',
        new File([compressedBuffer], 'receipt.jpg', { type: 'image/jpeg' }),
      );
      tgFormData.append('chat_id', String(ctx.groupId));

      let fileId: string | null = null;
      try {
        const telegramResp = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
          { method: 'POST', body: tgFormData },
        );
        const tgResult = (await telegramResp.json()) as {
          ok: boolean;
          result?: { document?: { file_id: string } };
        };
        fileId = tgResult.result?.document?.file_id ?? null;
      } catch (tgError) {
        logger.warn(
          { err: tgError },
          '[OCR] Failed to upload receipt to Telegram, continuing without file_id',
        );
      }

      const items = result.items.map((item) => ({
        name: item.name_ru,
        qty: item.quantity,
        price: item.price,
        total: item.total,
        category: item.category,
      }));

      logger.info(
        {
          userId: ctx.userId,
          itemCount: items.length,
          verified: result.sumVerified,
          rounds: result.calculateSumRounds,
        },
        'Receipt OCR completed',
      );

      return new Response(
        JSON.stringify({
          items,
          ...(result.currency !== undefined ? { currency: result.currency } : {}),
          ...(result.date !== undefined ? { date: result.date } : {}),
          file_id: fileId,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
        },
      );
    } catch (err) {
      logger.error({ err, userId: ctx.userId, groupId: telegramGroupId }, 'OCR processing failed');
      notifyScanFailure('OCR', '[image upload]', err).catch((e) =>
        logger.warn({ err: e }, 'notifyScanFailure failed'),
      );
      return errorResponse(500, 'OCR processing failed', 'OCR_FAILED', corsHeaders);
    } finally {
      rawBuffer = null;
      compressedBuffer = null;
    }
  }

  // ── POST /api/receipt/confirm ──────────────────────────────────────────────

  if (url.pathname === '/api/receipt/confirm' && req.method === 'POST') {
    let body: {
      groupId?: unknown;
      fileId?: unknown;
      date?: unknown;
      expenses?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch (parseError) {
      logger.warn({ err: parseError }, 'Failed to parse confirm request body');
      return errorResponse(400, 'Invalid JSON body', 'BAD_REQUEST', corsHeaders);
    }

    const telegramGroupId = typeof body.groupId === 'number' ? body.groupId : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(400, 'Missing or invalid groupId', 'BAD_REQUEST', corsHeaders);
    }

    if (!Array.isArray(body.expenses) || body.expenses.length === 0) {
      return errorResponse(400, 'Missing or empty expenses array', 'BAD_REQUEST', corsHeaders);
    }

    /** Expected shape of each receipt item from the Mini App client */
    interface ConfirmItemInput {
      name?: unknown;
      total?: unknown;
      category?: unknown;
      currency?: unknown;
      qty?: unknown;
      price?: unknown;
    }

    const itemInputs = body.expenses as ConfirmItemInput[];
    for (const item of itemInputs) {
      if (
        typeof item.name !== 'string' ||
        typeof item.total !== 'number' ||
        !Number.isFinite(item.total) ||
        item.total <= 0 ||
        typeof item.category !== 'string' ||
        typeof item.currency !== 'string' ||
        !isValidCurrencyCode(item.currency)
      ) {
        return errorResponse(
          400,
          'Each item must have name (string), total (positive finite number), category (string), currency (valid ISO code)',
          'BAD_REQUEST',
          corsHeaders,
        );
      }
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    const fileId = typeof body.fileId === 'string' ? body.fileId : null;

    // Receipt date (one for the whole receipt, not per item). Fall back to today.
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const date =
      typeof body.date === 'string' && ISO_DATE_RE.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);

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

      try {
        emitForGroup(ctx.internalGroupId, 'expense_added');
      } catch (emitError) {
        logger.warn({ err: emitError }, 'SSE emit failed, continuing');
      }

      logger.info(
        {
          userId: ctx.userId,
          created: result.expenses.length,
          categories: result.categoriesAffected.length,
        },
        'Receipt confirm completed',
      );

      return new Response(JSON.stringify({ created: result.expenses.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
      });
    } catch (err) {
      logger.error({ err, userId: ctx.userId, groupId: telegramGroupId }, 'Receipt confirm failed');
      return errorResponse(500, 'Failed to save expenses', 'CONFIRM_FAILED', corsHeaders);
    }
  }

  // ── GET /api/analytics ────────────────────────────────────────────────────

  if (url.pathname === '/api/analytics' && req.method === 'GET') {
    const groupIdParam = url.searchParams.get('groupId');
    const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(
        400,
        'Missing or invalid groupId query param',
        'BAD_REQUEST',
        corsHeaders,
      );
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
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

    /** Row returned by the per-category aggregation query */
    interface CategoryRow {
      category: string;
      total: number;
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
      byCategory[row.category] =
        Math.round(convertCurrency(row.total, 'EUR', defaultCurrency) * 100) / 100;
    }

    const totalInDefault =
      Math.round(convertCurrency(totalEur, 'EUR', defaultCurrency) * 100) / 100;

    return new Response(
      JSON.stringify({
        period,
        defaultCurrency,
        income: 0,
        expenses: totalInDefault,
        balance: -totalInDefault,
        savings: 0,
        byCategory,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
      },
    );
  }

  // ── GET /api/dashboard ────────────────────────────────────────────────────

  if (url.pathname === '/api/dashboard' && req.method === 'GET') {
    const groupIdParam = url.searchParams.get('groupId');
    const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(
        400,
        'Missing or invalid groupId query param',
        'BAD_REQUEST',
        corsHeaders,
      );
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    /** Row shape from dashboard_widgets table */
    interface DashboardRow {
      config: string;
      updated_at: string;
    }

    const row = database.queryOne<DashboardRow>(
      'SELECT config, updated_at FROM dashboard_widgets WHERE group_id = ? AND user_id = ?',
      ctx.internalGroupId,
      ctx.internalUserId,
    );

    if (!row) {
      return new Response(JSON.stringify({ widgets: [], updatedAt: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
      });
    }

    let widgets: unknown[] = [];
    try {
      widgets = JSON.parse(row.config) as unknown[];
    } catch {
      widgets = [];
    }

    return new Response(JSON.stringify({ widgets, updatedAt: row.updated_at }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
    });
  }

  // ── PUT /api/dashboard ────────────────────────────────────────────────────

  if (url.pathname === '/api/dashboard' && req.method === 'PUT') {
    let body: { groupId?: unknown; widgets?: unknown; updatedAt?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch (parseError) {
      logger.warn({ err: parseError }, 'Failed to parse dashboard PUT body');
      return errorResponse(400, 'Invalid JSON body', 'BAD_REQUEST', corsHeaders);
    }

    const telegramGroupId = typeof body.groupId === 'number' ? body.groupId : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(400, 'Missing or invalid groupId', 'BAD_REQUEST', corsHeaders);
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    /** Row shape for conflict check */
    interface DashboardUpdatedAtRow {
      updated_at: string;
    }

    const clientUpdatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : null;
    const newUpdatedAt = new Date().toISOString();
    const configJson = JSON.stringify(Array.isArray(body.widgets) ? body.widgets : []);

    // SELECT + UPDATE/INSERT must be atomic to prevent lost updates under concurrent writes
    const conflict = database.transaction(() => {
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

    if (conflict) {
      return errorResponse(
        409,
        'Dashboard was modified by another client',
        'CONFLICT',
        ctx.corsHeaders,
      );
    }

    return new Response(JSON.stringify({ ok: true, updatedAt: newUpdatedAt }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
    });
  }

  // ── GET /api/dashboard/events (SSE) ───────────────────────────────────────

  if (url.pathname === '/api/dashboard/events' && req.method === 'GET') {
    const groupIdParam = url.searchParams.get('groupId');
    const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(
        400,
        'Missing or invalid groupId query param',
        'BAD_REQUEST',
        corsHeaders,
      );
    }

    // EventSource doesn't support custom headers — initData comes as query param
    const initData = url.searchParams.get('initData') ?? '';
    const syntheticReq = new Request(req.url, {
      headers: { ...Object.fromEntries(req.headers), 'X-Telegram-Init-Data': initData },
    });

    const ctx = await validateAndResolveContext(syntheticReq, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    const sseHeaders = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...ctx.corsHeaders,
    };

    let unsub: (() => void) | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (msg: string) => {
          try {
            controller.enqueue(encoder.encode(msg));
          } catch {
            // controller may be closed already — ignore
          }
        };

        unsub = subscribeGroup(ctx.internalGroupId, send);

        // Send an initial ping so client knows the connection is alive
        send('event: ping\ndata: {}\n\n');

        pingInterval = setInterval(() => {
          send('event: ping\ndata: {}\n\n');
        }, 30_000);
      },
      cancel() {
        if (unsub) unsub();
        if (pingInterval) clearInterval(pingInterval);
      },
    });

    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  // ── GET /api/user/groups ───────────────────────────────────────────────────
  // Returns groups the authenticated user belongs to (no groupId required)

  if (url.pathname === '/api/user/groups' && req.method === 'GET') {
    const rawInitData = req.headers.get('X-Telegram-Init-Data') ?? undefined;
    if (!rawInitData) {
      logger.warn('Auth rejected: missing X-Telegram-Init-Data header (user/groups)');
      return errorResponse(
        401,
        'Missing X-Telegram-Init-Data header',
        'INVALID_INIT_DATA',
        corsHeaders,
      );
    }

    // Early expiry check with specific code for frontend session recovery
    const groupsParams = new URLSearchParams(rawInitData);
    const groupsAuthDate = groupsParams.get('auth_date');
    if (groupsAuthDate) {
      const age = Math.floor(Date.now() / 1000) - parseInt(groupsAuthDate, 10);
      if (age > INIT_DATA_TTL_SECONDS) {
        logger.warn(
          { ageSec: age, ttl: INIT_DATA_TTL_SECONDS },
          'Auth rejected: initData expired (user/groups)',
        );
        return errorResponse(401, 'initData expired', 'INIT_DATA_EXPIRED', corsHeaders);
      }
    }

    const userId = validateInitData(rawInitData);
    if (userId === null) {
      logger.warn('Auth rejected: invalid initData (user/groups)');
      return errorResponse(401, 'Invalid initData', 'INVALID_INIT_DATA', corsHeaders);
    }

    const user = database.users.findByTelegramId(userId);
    if (!user || !user.group_id) {
      return new Response(JSON.stringify({ groups: [], botUsername: env.BOT_USERNAME }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const group = database.groups.findById(user.group_id);
    const groups = group ? [{ telegramGroupId: group.telegram_group_id }] : [];

    return new Response(JSON.stringify({ groups, botUsername: env.BOT_USERNAME }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  return errorResponse(404, 'Not Found', 'NOT_FOUND', corsHeaders);
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
