// Mini App API handler: HMAC initData validation and routing for /api/* endpoints
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import { type CurrencyCode, isValidCurrencyCode } from '../config/constants.ts';
import { env } from '../config/env.ts';
import { database } from '../database/index.ts';
import { sendDocumentDirect } from '../services/bank/telegram-sender.ts';
import { convertCurrency } from '../services/currency/converter.ts';
import { getExpenseRecorder } from '../services/expense-recorder.ts';
import { streamExtractExpenses } from '../services/receipt/ai-extractor.ts';
import { extractTextFromImageBuffer } from '../services/receipt/ocr-extractor.ts';
import { fetchReceiptData } from '../services/receipt/receipt-fetcher.ts';
import { shortenReceiptUrl } from '../services/receipt/url-shortener.ts';
import { createLogger } from '../utils/logger.ts';
import { createScan, emitEvent, getScan, subscribe, updateScan } from './scan-store.ts';
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

/** Row shape returned by the membership query */
interface MembershipRow {
  id: number;
}

/** Check that userId is a member of the group identified by telegram_group_id */
function resolveGroupMembership(telegramGroupId: number, userId: number): number | null {
  const row = database.queryOne<MembershipRow>(
    `SELECT g.id FROM groups g
     WHERE g.telegram_group_id = ? AND EXISTS (
       SELECT 1 FROM users u
       WHERE u.telegram_id = ? AND u.group_id = g.id
     )`,
    telegramGroupId,
    userId,
  );

  return row ? row.id : null;
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

  const user = database.users.findByTelegramId(userId);
  if (!user) {
    logger.warn({ userId, telegramGroupId }, 'Auth rejected: user not found in DB');
    return {
      ok: false,
      response: errorResponse(401, 'User not found', 'INVALID_INIT_DATA', corsHeaders),
    };
  }

  const internalGroupId = resolveGroupMembership(telegramGroupId, userId);
  if (internalGroupId === null) {
    logger.warn({ userId, telegramGroupId }, 'Auth rejected: user not a member of group');
    return {
      ok: false,
      response: errorResponse(403, 'Forbidden', 'FORBIDDEN_GROUP', corsHeaders),
    };
  }

  return {
    ok: true,
    userId,
    internalUserId: user.id,
    groupId: telegramGroupId,
    internalGroupId,
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
  const url = new URL(req.url);

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

    const scanId = createScan(ctx.internalGroupId, telegramGroupId);
    const categoryNames = database.categories.findByGroupId(ctx.internalGroupId).map((c) => c.name);

    logger.info(
      { userId: ctx.userId, groupId: telegramGroupId, scanId },
      'Async receipt scan started',
    );

    processScanInBackground(scanId, qr, categoryNames).catch((e) =>
      logger.error({ err: e, scanId }, 'Background scan processing crashed'),
    );

    return new Response(JSON.stringify({ scanId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
    });
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

    // Read buffer before going async — Request body can only be consumed once
    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(await imageBlob.arrayBuffer());
    } catch (bufErr) {
      logger.error({ err: bufErr }, 'Failed to read image buffer');
      return errorResponse(500, 'Failed to read image', 'OCR_FAILED', ctx.corsHeaders);
    }

    const scanId = createScan(ctx.internalGroupId, telegramGroupId);
    const categoryNames = database.categories.findByGroupId(ctx.internalGroupId).map((c) => c.name);

    logger.info({ userId: ctx.userId, groupId: telegramGroupId, scanId }, 'Async OCR scan started');

    processOcrInBackground(scanId, imageBuffer, categoryNames, telegramGroupId).catch((e) =>
      logger.error({ err: e, scanId }, 'Background OCR processing crashed'),
    );

    return new Response(JSON.stringify({ scanId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
    });
  }

  // ── POST /api/receipt/confirm ──────────────────────────────────────────────

  if (url.pathname === '/api/receipt/confirm' && req.method === 'POST') {
    let body: {
      groupId?: unknown;
      fileId?: unknown;
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

    /** Expected shape of each expense item from client */
    interface ConfirmExpenseInput {
      name?: unknown;
      total?: unknown;
      category?: unknown;
      currency?: unknown;
      date?: unknown;
      qty?: unknown;
      price?: unknown;
    }

    const expenseInputs = body.expenses as ConfirmExpenseInput[];
    for (const item of expenseInputs) {
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
          'Each expense must have name (string), total (positive finite number), category (string), currency (valid ISO code)',
          'BAD_REQUEST',
          corsHeaders,
        );
      }
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    const fileId = typeof body.fileId === 'string' ? body.fileId : null;

    logger.info(
      { userId: ctx.userId, groupId: telegramGroupId, expenseCount: expenseInputs.length },
      'Receipt confirm started',
    );

    try {
      const recorder = getExpenseRecorder();
      let created = 0;

      for (const item of expenseInputs) {
        const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
        const date =
          typeof item.date === 'string' && ISO_DATE_RE.test(item.date)
            ? item.date
            : new Date().toISOString().slice(0, 10);

        const result = await recorder.record(ctx.internalGroupId, ctx.internalUserId, {
          date,
          category: item.category as string,
          comment: item.name as string,
          amount: item.total as number,
          currency: item.currency as CurrencyCode,
        });

        if (fileId) {
          database.exec(
            'UPDATE expenses SET receipt_file_id = ? WHERE id = ?',
            fileId,
            result.expense.id,
          );
        }

        created++;
      }

      try {
        emitForGroup(ctx.internalGroupId, 'expense_added');
      } catch (emitError) {
        logger.warn({ err: emitError }, 'SSE emit failed, continuing');
      }

      logger.info({ userId: ctx.userId, created }, 'Receipt confirm completed');

      return new Response(JSON.stringify({ created }), {
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

  // ── GET /api/receipt/scan/:scanId/stream (SSE) ────────────────────────────

  const streamMatch = url.pathname.match(/^\/api\/receipt\/scan\/([^/]+)\/stream$/);
  if (streamMatch?.[1] && req.method === 'GET') {
    const scanId = streamMatch[1];
    const state = getScan(scanId);
    if (!state) return errorResponse(404, 'Scan not found', 'NOT_FOUND', corsHeaders);

    // Auth via initData query param (EventSource doesn't support custom headers)
    const initData = url.searchParams.get('initData') ?? '';
    const syntheticReq = new Request(req.url, {
      headers: { ...Object.fromEntries(req.headers), 'X-Telegram-Init-Data': initData },
    });

    const ctx = await validateAndResolveContext(syntheticReq, corsOrigin, state.telegramGroupId);
    if (!ctx.ok) return ctx.response;
    if (ctx.internalGroupId !== state.groupId) {
      return errorResponse(403, 'Forbidden', 'FORBIDDEN_GROUP', corsHeaders);
    }

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

        unsub = subscribe(scanId, send);
        if (!unsub) {
          send(
            'event: error\ndata: {"message":"Too many connections","code":"TOO_MANY_SUBSCRIBERS"}\n\n',
          );
          controller.close();
          return;
        }

        // Replay current state so late-joining clients catch up
        if (state.url) {
          send(`event: url\ndata: ${JSON.stringify({ url: state.url, raw: state.rawUrl })}\n\n`);
        }
        for (const item of state.items) {
          send(`event: item\ndata: ${JSON.stringify(item)}\n\n`);
        }
        if (state.phase === 'done') {
          send(
            `event: done\ndata: ${JSON.stringify({ items: state.items, currency: state.currency, fileId: state.fileId })}\n\n`,
          );
        }
        if (state.phase === 'error') {
          send(
            `event: error\ndata: ${JSON.stringify({ message: state.error, code: state.errorCode })}\n\n`,
          );
        }

        pingInterval = setInterval(() => send('event: ping\ndata: {}\n\n'), 15_000);
      },
      cancel() {
        if (unsub) unsub();
        if (pingInterval) clearInterval(pingInterval);
      },
    });

    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  // ── GET /api/receipt/scan/:scanId (poll) ──────────────────────────────────

  const pollMatch = url.pathname.match(/^\/api\/receipt\/scan\/([^/]+)$/);
  if (pollMatch?.[1] && req.method === 'GET') {
    const scanId = pollMatch[1];
    const state = getScan(scanId);
    if (!state) return errorResponse(404, 'Scan not found or expired', 'NOT_FOUND', corsHeaders);

    // Auth via initData query param (for consistency with SSE endpoint)
    const initData = url.searchParams.get('initData') ?? '';
    const syntheticReq = new Request(req.url, {
      headers: { ...Object.fromEntries(req.headers), 'X-Telegram-Init-Data': initData },
    });

    const ctx = await validateAndResolveContext(syntheticReq, corsOrigin, state.telegramGroupId);
    if (!ctx.ok) return ctx.response;
    if (ctx.internalGroupId !== state.groupId) {
      return errorResponse(403, 'Forbidden', 'FORBIDDEN_GROUP', corsHeaders);
    }

    return new Response(
      JSON.stringify({
        phase: state.phase,
        url: state.url ?? null,
        items: state.items,
        currency: state.currency ?? null,
        fileId: state.fileId ?? null,
        error: state.error ?? null,
        errorCode: state.errorCode ?? null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders } },
    );
  }

  // ── GET /api/categories ─────────────────────────────────────────────────

  if (url.pathname === '/api/categories' && req.method === 'GET') {
    const groupIdParam = url.searchParams.get('groupId');
    const telegramGroupId = groupIdParam ? Number.parseInt(groupIdParam, 10) : Number.NaN;
    if (Number.isNaN(telegramGroupId)) {
      return errorResponse(400, 'Missing or invalid groupId', 'BAD_REQUEST', corsHeaders);
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    const categories = database.categories.findByGroupId(ctx.internalGroupId).map((c) => c.name);

    return new Response(JSON.stringify({ categories }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
    });
  }

  return errorResponse(404, 'Not Found', 'NOT_FOUND', corsHeaders);
}

/** Detect error code from error type */
function classifyScanError(err: unknown, source: 'fetch' | 'extract'): string {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (source === 'fetch') return 'FETCH_FAILED';
  if (
    msg.includes('402') ||
    msg.includes('credit') ||
    msg.includes('billing') ||
    msg.includes('payment')
  ) {
    return 'CREDITS_EXHAUSTED';
  }
  return 'SCAN_FAILED';
}

/** Background processing for QR receipt scans */
async function processScanInBackground(
  scanId: string,
  qr: string,
  categoryNames: string[],
): Promise<void> {
  try {
    updateScan(scanId, { phase: 'fetching' });

    let html: string;
    try {
      html = await fetchReceiptData(qr);
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : 'Failed to fetch receipt';
      updateScan(scanId, { phase: 'error', error: message, errorCode: 'FETCH_FAILED' });
      emitEvent(scanId, 'error', { message, code: 'FETCH_FAILED' });
      notifyScanFailure('QR scan (fetch)', qr, fetchErr).catch((e) =>
        logger.warn({ err: e }, 'notifyScanFailure failed'),
      );
      return;
    }

    const shortUrl = shortenReceiptUrl(qr);
    updateScan(scanId, { phase: 'extracting', url: shortUrl, rawUrl: qr });
    emitEvent(scanId, 'url', { url: shortUrl, raw: qr });

    const result = await streamExtractExpenses(html, categoryNames, (item) => {
      const state = getScan(scanId);
      if (state) state.items.push(item);
      emitEvent(scanId, 'item', item);
    });

    const state = getScan(scanId);
    const allItems = state?.items ?? [];
    const donePatch: Partial<import('./scan-store').ScanState> = { phase: 'done', items: allItems };
    if (result.currency) donePatch.currency = result.currency;
    updateScan(scanId, donePatch);
    emitEvent(scanId, 'done', { items: allItems, currency: result.currency });

    logger.info({ scanId, itemCount: allItems.length }, 'Scan completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const errorCode = classifyScanError(err, 'extract');
    updateScan(scanId, { phase: 'error', error: message, errorCode });
    emitEvent(scanId, 'error', { message, code: errorCode });

    notifyScanFailure('QR scan (streaming)', qr, err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
  }
}

/** Background processing for OCR receipt scans */
async function processOcrInBackground(
  scanId: string,
  imageBuffer: Buffer,
  categoryNames: string[],
  telegramGroupId: number,
): Promise<void> {
  try {
    updateScan(scanId, { phase: 'processing' });

    // Compress image before OCR
    const compressedBuffer = await sharp(imageBuffer)
      .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const ocrText = await extractTextFromImageBuffer(compressedBuffer);

    // Upload image to Telegram to get a file_id for later use in the confirm step
    let telegramFileId: string | null = null;
    try {
      const tgFormData = new FormData();
      tgFormData.append(
        'document',
        new File([compressedBuffer], 'receipt.jpg', { type: 'image/jpeg' }),
      );
      tgFormData.append('chat_id', String(telegramGroupId));

      const telegramResp = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
        { method: 'POST', body: tgFormData },
      );
      const tgResult = (await telegramResp.json()) as {
        ok: boolean;
        result?: { document?: { file_id: string } };
      };
      telegramFileId = tgResult.result?.document?.file_id ?? null;
    } catch (tgError) {
      logger.warn(
        { err: tgError },
        '[OCR] Failed to upload receipt to Telegram, continuing without file_id',
      );
    }

    updateScan(scanId, { phase: 'extracting', fileId: telegramFileId });

    const result = await streamExtractExpenses(ocrText, categoryNames, (item) => {
      const state = getScan(scanId);
      if (state) state.items.push(item);
      emitEvent(scanId, 'item', item);
    });

    const state = getScan(scanId);
    const allItems = state?.items ?? [];
    const ocrDonePatch: Partial<import('./scan-store').ScanState> = {
      phase: 'done',
      items: allItems,
      fileId: telegramFileId,
    };
    if (result.currency) ocrDonePatch.currency = result.currency;
    updateScan(scanId, ocrDonePatch);
    emitEvent(scanId, 'done', {
      items: allItems,
      currency: result.currency,
      fileId: telegramFileId,
    });

    logger.info({ scanId, itemCount: allItems.length }, 'OCR scan completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const errorCode = classifyScanError(err, 'extract');
    updateScan(scanId, { phase: 'error', error: message, errorCode });
    emitEvent(scanId, 'error', { message, code: errorCode });

    notifyScanFailure('OCR (streaming)', '[image]', err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
  }
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
