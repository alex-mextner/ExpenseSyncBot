// Fetch wrapper that injects X-Telegram-Init-Data header on every API request
const BASE_URL = import.meta.env.VITE_API_URL ?? '';

function getInitData(): string {
  // window.Telegram.WebApp.initData is the raw initData string
  return window.Telegram?.WebApp?.initData ?? '';
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const initData = getInitData();
  const headers = new Headers(options.headers);
  headers.set('X-Telegram-Init-Data', initData);
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(response.status, error.error ?? 'Request failed', error.code);
  }

  return response.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
