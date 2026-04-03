// Receipt API: types and expense confirmation
import { apiRequest } from './client';

export interface ReceiptItem {
  name: string;
  qty: number;
  price: number;
  total: number;
  category: string;
}

export interface ConfirmExpense {
  name: string;
  qty: number;
  price: number;
  total: number;
  category: string;
  currency: string;
  date?: string;
}

export async function confirmExpenses(
  groupId: number,
  expenses: ConfirmExpense[],
  fileId?: string | null,
): Promise<{ created: number }> {
  return apiRequest<{ created: number }>(`/api/receipt/confirm?groupId=${groupId}`, {
    method: 'POST',
    body: JSON.stringify({ groupId, fileId: fileId ?? null, expenses }),
  });
}
