// Mini App API handler: HMAC initData validation and routing for /api/* endpoints
import { createHmac } from 'node:crypto';
import { env } from '../config/env.ts';
import { database } from '../database/index.ts';
import { extractExpensesFromReceipt } from '../services/receipt/ai-extractor.ts';
import { fetchReceiptData } from '../services/receipt/receipt-fetcher.ts';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('miniapp-api');

/** Five-minute window for initData freshness */
const INIT_DATA_TTL_SECONDS = 5 * 60;

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
  const row = database.db
    .query<MembershipRow, { groupId: number; userId: number }>(
      `SELECT g.id FROM groups g
       WHERE g.telegram_group_id = :groupId
         AND EXISTS (
           SELECT 1 FROM users u
           WHERE u.telegram_id = :userId AND u.group_id = g.id
         )`,
    )
    .get({ groupId: telegramGroupId, userId });

  return row ? row.id : null;
}

/** Build CORS headers for a given allowed origin */
function buildCorsHeaders(corsOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      return {
        ok: false,
        response: errorResponse(401, 'initData expired', 'INIT_DATA_EXPIRED', corsHeaders),
      };
    }
  }

  const userId = validateInitData(rawInitData);
  if (userId === null) {
    return {
      ok: false,
      response: errorResponse(401, 'Invalid initData', 'INVALID_INIT_DATA', corsHeaders),
    };
  }

  const user = database.users.findByTelegramId(userId);
  if (!user) {
    logger.warn({ userId }, 'initData valid but user not found in DB');
    return {
      ok: false,
      response: errorResponse(401, 'User not found', 'INVALID_INIT_DATA', corsHeaders),
    };
  }

  const internalGroupId = resolveGroupMembership(telegramGroupId, userId);
  if (internalGroupId === null) {
    return {
      ok: false,
      response: errorResponse(403, 'Forbidden', 'FORBIDDEN_GROUP', corsHeaders),
    };
  }

  return { ok: true, userId, groupId: telegramGroupId, internalGroupId, corsHeaders };
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

    let body: { qrData?: unknown };
    try {
      body = (await req.json()) as { qrData?: unknown };
    } catch {
      return errorResponse(400, 'Invalid JSON body', 'BAD_REQUEST', corsHeaders);
    }

    const { qrData } = body;
    if (typeof qrData !== 'string' || qrData.trim() === '') {
      return errorResponse(400, 'Missing required field: qrData', 'BAD_REQUEST', corsHeaders);
    }

    const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
    if (!ctx.ok) return ctx.response;

    try {
      const html = await fetchReceiptData(qrData);
      const categoryNames = database.categories
        .findByGroupId(ctx.internalGroupId)
        .map((c) => c.name);
      const result = await extractExpensesFromReceipt(html, categoryNames);

      const items = result.items.map((item) => ({
        name: item.name_ru,
        qty: item.quantity,
        price: item.price,
        total: item.total,
        category: item.category,
      }));

      return new Response(
        JSON.stringify({
          items,
          ...(result.currency !== undefined ? { currency: result.currency } : {}),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
        },
      );
    } catch (err) {
      logger.error({ err }, 'Receipt scan failed');
      return errorResponse(
        500,
        err instanceof Error ? err.message : 'Receipt scan failed',
        'SCAN_FAILED',
        corsHeaders,
      );
    }
  }

  return errorResponse(404, 'Not Found', 'NOT_FOUND', corsHeaders);
}
