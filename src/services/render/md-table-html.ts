/**
 * Generates styled HTML page from a markdown table for screenshot rendering
 */

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

/** Convert inline Markdown to HTML within a table cell or header value.
 * HTML is escaped first, so raw tags can't inject markup. */
function renderInlineMd(raw: string): string {
  let s = escapeHtml(raw);
  // Bold must come before italic so **x** doesn't leave stray *x*.
  // [^*]+ intentionally rejects content containing literal asterisks — **a * b** is left as-is.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return s;
}

/** Parse markdown table syntax into headers + rows */
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

/** Generate full HTML page for the table */
export function buildMdTableHtml(data: TableData): string {
  const { headers, rows } = parseMarkdownTable(data.markdown);

  const headerCells = headers.map((h) => `<th>${renderInlineMd(h)}</th>`).join('');
  const bodyRows = rows
    .map((row) => {
      const cells = row.map((cell) => `<td>${renderInlineMd(cell)}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

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
  td b, th b { font-weight: 700; }
  td i, th i { font-style: italic; color: #a8b4d0; }
  td code, th code { background: #1a1d23; padding: 1px 6px; border-radius: 4px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 14px; }
  td s, th s { opacity: 0.55; }
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
  <div class="table-wrap">
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>
  ${caption}
  <div class="footer">ExpenseSyncBot</div>
</div>
</body>
</html>`;
}
