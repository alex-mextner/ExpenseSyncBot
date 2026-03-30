/**
 * Renders HTML content to a PNG image using Playwright (headless Chromium)
 */
import { chromium } from 'playwright';
import { createLogger } from '../../utils/logger.ts';
import { buildMdTableHtml } from './md-table-html.ts';

const logger = createLogger('table-renderer');

export interface RenderTableInput {
  title: string;
  markdown: string;
  caption?: string | undefined;
}

/**
 * Render a markdown table as a PNG image buffer.
 * Opens a headless browser page, sets the HTML, and takes a screenshot.
 */
export async function renderTableToPng(input: RenderTableInput): Promise<Buffer> {
  const html = buildMdTableHtml(input);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setContent(html, { waitUntil: 'load' });

    const root = await page.$('#root');
    if (!root) {
      throw new Error('Root element not found in rendered HTML');
    }

    const screenshot = await root.screenshot({ type: 'png' });
    return Buffer.from(screenshot);
  } finally {
    await browser.close().catch((err) => logger.error({ err }, 'Failed to close browser'));
  }
}
