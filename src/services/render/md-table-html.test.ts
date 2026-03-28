import { describe, expect, test } from 'bun:test';
import { buildMdTableHtml, parseMarkdownTable } from './md-table-html';

describe('parseMarkdownTable', () => {
  test('parses standard 2-column table', () => {
    const md = '| Category | Amount |\n|---|---|\n| Food | 500 |';
    const { headers, rows } = parseMarkdownTable(md);
    expect(headers).toEqual(['Category', 'Amount']);
    expect(rows).toEqual([['Food', '500']]);
  });

  test('parses multi-row table', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
    const { headers, rows } = parseMarkdownTable(md);
    expect(headers).toEqual(['A', 'B']);
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  test('trims whitespace in cells', () => {
    const md = '|  Col 1  |  Col 2  |\n|---|---|\n|  val  |  123  |';
    const { headers, rows } = parseMarkdownTable(md);
    expect(headers).toEqual(['Col 1', 'Col 2']);
    expect(rows[0]).toEqual(['val', '123']);
  });

  test('returns empty on empty string', () => {
    const { headers, rows } = parseMarkdownTable('');
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  test('returns empty when no pipes in first line', () => {
    const { headers, rows } = parseMarkdownTable('no pipes here\n|---|---|\n| a | b |');
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  test('returns empty when only one line', () => {
    const { headers, rows } = parseMarkdownTable('| Col |');
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  test('handles Windows line endings (CRLF)', () => {
    const md = '| A | B |\r\n|---|---|\r\n| 1 | 2 |';
    const { headers, rows } = parseMarkdownTable(md);
    expect(headers).toEqual(['A', 'B']);
    expect(rows).toEqual([['1', '2']]);
  });
});

describe('buildMdTableHtml', () => {
  test('contains escaped title', () => {
    const html = buildMdTableHtml({
      title: '<script>xss</script>',
      markdown: '| A |\n|---|\n| v |',
    });
    expect(html).toContain('&lt;script&gt;xss&lt;/script&gt;');
    expect(html).not.toContain('<script>xss');
  });

  test('renders header cells', () => {
    const html = buildMdTableHtml({
      title: 'T',
      markdown: '| Col1 | Col2 |\n|---|---|\n| v1 | v2 |',
    });
    expect(html).toContain('<th>Col1</th>');
    expect(html).toContain('<th>Col2</th>');
  });

  test('renders data rows', () => {
    const html = buildMdTableHtml({ title: 'T', markdown: '| A |\n|---|\n| hello |' });
    expect(html).toContain('<td>hello</td>');
  });

  test('renders caption when provided', () => {
    const html = buildMdTableHtml({
      title: 'T',
      markdown: '| A |\n|---|\n| v |',
      caption: 'Note here',
    });
    expect(html).toContain('Note here');
    expect(html).toContain('class="caption"');
  });

  test('omits caption block when not provided', () => {
    const html = buildMdTableHtml({ title: 'T', markdown: '| A |\n|---|\n| v |' });
    expect(html).not.toContain('class="caption"');
  });

  test('escapes special chars in cell values', () => {
    const html = buildMdTableHtml({ title: 'T', markdown: '| A |\n|---|\n| <b>bold</b> |' });
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  test('produces valid HTML structure', () => {
    const html = buildMdTableHtml({ title: 'My Table', markdown: '| X |\n|---|\n| y |' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('id="root"');
  });
});
