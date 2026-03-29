/**
 * Generates styled HTML page from a markdown table for screenshot rendering
 */
import { marked } from 'marked';

interface TableData {
  title: string;
  markdown: string;
  caption?: string | undefined;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse markdown table syntax into headers + rows — used for input validation */
export function parseMarkdownTable(md: string): { headers: string[]; rows: string[][] } {
  const lines = md
    .trim()
    .split('\n')
    .filter((l) => l.trim());

  if (lines.length < 2) {
    return { headers: [], rows: [] };
  }

  const parseRow = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());

  const firstLine = lines[0] ?? '';
  const headers = parseRow(firstLine);
  if (headers.length === 0) {
    return { headers: [], rows: [] };
  }
  // lines[1] is the separator row (---|---), skip it
  const rows = lines.slice(2).map(parseRow);

  return { headers, rows };
}

/** Generate full HTML page for the table.
 * Markdown is rendered by marked (GFM): inline formatting, table structure, HTML escaping. */
export function buildMdTableHtml(data: TableData): string {
  // markdown comes from the AI agent, rendered by Playwright server-side — not a user-facing browser
  const tableHtml = marked.parse(data.markdown, { gfm: true, async: false }) as string;

  const caption =
    data.caption != null ? `<div class="caption">${escapeHtml(data.caption)}</div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1a1d23;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 32px;
    min-width: 480px;
  }
  #root {
    display: inline-block;
    min-width: 400px;
  }
  .title {
    font-size: 26px;
    font-weight: 700;
    color: #f0f0f0;
    margin-bottom: 20px;
    line-height: 1.3;
  }
  .table-wrap {
    background: #252930;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 17px;
  }
  th {
    background: #4f7cff;
    color: #fff;
    font-weight: 600;
    padding: 13px 18px;
    text-align: left;
    white-space: nowrap;
  }
  td {
    padding: 11px 18px;
    color: #e0e0e0;
    border-bottom: 1px solid #2e3340;
  }
  tr:last-child td { border-bottom: none; }
  tr:nth-child(even) td { background: #1e2128; }
  td strong, th strong { font-weight: 700; }
  td em, th em { font-style: italic; color: #a8b4d0; }
  td code, th code { background: #1a1d23; padding: 1px 6px; border-radius: 4px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 14px; }
  td del, th del { opacity: 0.55; }
  .caption {
    margin-top: 14px;
    font-size: 13px;
    color: #8a8fa8;
  }
  .footer {
    margin-top: 24px;
    text-align: right;
    font-size: 12px;
    color: #4a4e60;
  }
</style>
</head>
<body>
<div id="root">
  <div class="title">${escapeHtml(data.title)}</div>
  <div class="table-wrap">${tableHtml}</div>
  ${caption}
  <div class="footer">ExpenseSyncBot</div>
</div>
</body>
</html>`;
}
