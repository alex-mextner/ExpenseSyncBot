// Receipt API: QR scan, OCR upload, expense confirmation
import { apiRequest } from './client';

export interface ReceiptItem {
  name: string;
  qty: number;
  price: number;
  total: number;
  category: string;
}

export interface ScanResult {
  merchant?: string;
  date?: string;
  items: ReceiptItem[];
  currency?: string;
}

export interface OcrResult extends ScanResult {
  file_id: string | null;
}

export async function scanQR(groupId: number, qr: string): Promise<ScanResult> {
  return apiRequest<ScanResult>(`/api/receipt/scan?groupId=${groupId}`, {
    method: 'POST',
    body: JSON.stringify({ qr }),
  });
}

export async function uploadOCR(groupId: number, imageBlob: Blob): Promise<OcrResult> {
  // Client-side JPEG compression before upload
  const compressed = await compressImage(imageBlob);
  const formData = new FormData();
  formData.append('image', compressed, 'receipt.jpg');
  return apiRequest<OcrResult>(`/api/receipt/ocr?groupId=${groupId}`, {
    method: 'POST',
    body: formData,
  });
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

/**
 * Client-side JPEG compression: long side ≤ 1800px, quality 0.85
 * Falls back to original if canvas is unavailable
 */
async function compressImage(blob: Blob): Promise<Blob> {
  const MAX_LONG_SIDE = 1800;
  const QUALITY = 0.85;
  const MAX_BYTES = 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { width, height } = img;
      const longSide = Math.max(width, height);
      const scale = longSide > MAX_LONG_SIDE ? MAX_LONG_SIDE / longSide : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        if (blob.size > MAX_BYTES) {
          reject(new Error('Image exceeds 2 MB and canvas is unavailable'));
        } else {
          resolve(blob);
        }
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (result) => {
          if (!result) { reject(new Error('Canvas toBlob failed')); return; }
          if (result.size > MAX_BYTES) {
            reject(new Error('Image exceeds 2 MB after compression'));
            return;
          }
          resolve(result);
        },
        'image/jpeg',
        QUALITY,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
