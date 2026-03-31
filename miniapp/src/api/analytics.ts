// Analytics and dashboard API: fetch data, manage widget config, subscribe to SSE events
import { apiRequest } from './client';
import type { WidgetConfig } from '../widgets/registry';

export interface AnalyticsData {
  period: string;
  defaultCurrency: string;
  income: number;
  expenses: number;
  balance: number;
  savings: number;
  byCategory: Record<string, number>;
}

export interface DashboardData {
  widgets: WidgetConfig[];
  updatedAt: string | null;
}

export async function getAnalytics(groupId: number, period?: string): Promise<AnalyticsData> {
  const params = new URLSearchParams({ groupId: String(groupId) });
  if (period) params.set('period', period);
  return apiRequest<AnalyticsData>(`/api/analytics?${params}`);
}

export async function getDashboard(groupId: number): Promise<DashboardData> {
  return apiRequest<DashboardData>(`/api/dashboard?groupId=${groupId}`);
}

export async function putDashboard(
  groupId: number,
  widgets: WidgetConfig[],
  updatedAt: string | null,
): Promise<{ ok: boolean; updatedAt: string }> {
  return apiRequest<{ ok: boolean; updatedAt: string }>(`/api/dashboard?groupId=${groupId}`, {
    method: 'PUT',
    body: JSON.stringify({ groupId, widgets, updatedAt }),
  });
}

export function subscribeDashboardEvents(
  groupId: number,
  onEvent: (eventType: string) => void,
): () => void {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  const url = `/api/dashboard/events?groupId=${groupId}&initData=${encodeURIComponent(initData)}`;

  let es: EventSource | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  if (typeof EventSource !== 'undefined') {
    es = new EventSource(url);
    es.addEventListener('expense_added', () => onEvent('expense_added'));
    es.addEventListener('budget_updated', () => onEvent('budget_updated'));
    es.onerror = () => {
      es?.close();
      // fallback to polling if SSE fails
      if (!closed && !pollInterval) {
        pollInterval = setInterval(() => onEvent('poll'), 60_000);
      }
    };
  } else {
    // Polling fallback
    pollInterval = setInterval(() => onEvent('poll'), 60_000);
  }

  return () => {
    closed = true;
    es?.close();
    if (pollInterval) clearInterval(pollInterval);
  };
}
