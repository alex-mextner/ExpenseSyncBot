import { chromium, type Browser } from 'playwright';
import { isURL } from './qr-scanner';

let browser: Browser | null = null;

/**
 * Initialize browser instance (singleton)
 */
async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browser;
}

/**
 * Close browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Fetch receipt data from QR code data
 * @param qrData - QR code data (URL or text/JSON)
 * @returns Receipt HTML content or text data
 * @throws Error if URL cannot be loaded or data is invalid
 */
export async function fetchReceiptData(qrData: string): Promise<string> {
  // If QR data is a URL, fetch it with Playwright
  if (isURL(qrData)) {
    try {
      const browserInstance = await getBrowser();
      const context = await browserInstance.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      // Set timeout
      await page.goto(qrData, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // Wait a bit for dynamic content
      await page.waitForTimeout(2000);

      // Get page content
      const content = await page.content();

      // Close context
      await context.close();

      if (!content || content.length < 100) {
        throw new Error('Page loaded but content is empty or too short');
      }

      return content;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load receipt URL: ${error.message}`);
      }
      throw new Error('Failed to load receipt URL: Unknown error');
    }
  }

  // If not URL, return as is (might be JSON or other text data)
  return qrData;
}

/**
 * Extract text from HTML content
 * @param html - HTML content
 * @returns Plain text content
 */
export function extractTextFromHTML(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}
