/**
 * Sends an AI-produced markdown table to the chat as a Bot API 10.1 rich message with a native
 * table; when the table exceeds rich-message limits or Telegram rejects it, as monospace <pre> HTML.
 */
import { marked, type Token, type Tokens } from 'marked';
import type { InputRichBlock, InputRichMessage, RichText } from '../../bot/telegram-rich-message';
import { neutralizeHtml, packHtmlBlocks, TELEGRAM_MAX_MESSAGE_LENGTH } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { sendMessage, sendRichMessage } from '../bank/telegram-sender';

const logger = createLogger('table-message');

export interface TableMessageInput {
  title: string;
  markdown: string;
  caption?: string | undefined;
}

/** Rich message limits from https://core.telegram.org/bots/api#rich-message-limits */
const RICH_MAX_TABLE_COLUMNS = 20;
/** Table rows count as blocks too. */
const RICH_MAX_BLOCKS = 500;
const RICH_MAX_TEXT_LENGTH = 32768;

function childTokens(token: Token): Token[] | undefined {
  return 'tokens' in token ? token.tokens : undefined;
}

/** marked's Generic token also has a string `type`, so `type === 'table'` alone does not narrow. */
function isTable(token: Token): token is Tokens.Table {
  return token.type === 'table';
}

function leafText(token: Token): string {
  return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
}

/** Inline markdown tokens → rich text; unknown inline tokens keep their text, raw HTML is dropped. */
function toRichText(tokens: Token[]): RichText {
  const parts = tokens.map((token): RichText => {
    const children = childTokens(token) ?? [];
    switch (token.type) {
      case 'strong':
        return { type: 'bold', text: toRichText(children) };
      case 'em':
        return { type: 'italic', text: toRichText(children) };
      case 'del':
        return { type: 'strikethrough', text: toRichText(children) };
      case 'codespan':
        return { type: 'code', text: leafText(token) };
      case 'link':
        return 'href' in token && /^https?:\/\//i.test(token.href)
          ? { type: 'url', text: toRichText(children), url: token.href }
          : toRichText(children);
      case 'br':
        return '\n';
      case 'html':
        return '';
      default:
        return children.length > 0 ? toRichText(children) : leafText(token);
    }
  });
  return parts.length === 1 && parts[0] !== undefined ? parts[0] : parts;
}

/** Inline markdown tokens → plain text (formatting markers removed, raw HTML dropped). */
function toPlainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'html') return '';
      if (token.type === 'br') return ' ';
      const children = childTokens(token);
      return children ? toPlainText(children) : leafText(token);
    })
    .join('');
}

function richTableBlock(table: Tokens.Table): InputRichBlock {
  const toRow = (cells: Tokens.TableCell[]) =>
    cells.map((cell) => ({
      text: toRichText(cell.tokens),
      ...(cell.header ? { is_header: true as const } : {}),
      align: cell.align ?? 'left',
      valign: 'middle' as const,
    }));
  return {
    type: 'table',
    cells: [toRow(table.header), ...table.rows.map(toRow)],
    is_bordered: true,
    is_striped: true,
  };
}

/** A rich block with what it adds toward the rich-message limits. */
interface RichPart {
  block: InputRichBlock;
  blockCount: number;
  textLength: number;
}

/** A table as a rich part, or null when it has more columns than a rich table allows. */
function richTablePart(table: Tokens.Table): RichPart | null {
  // marked pads or cuts every body row to the header's cell count.
  if (table.header.length > RICH_MAX_TABLE_COLUMNS) return null;
  let textLength = 0;
  for (const row of [table.header, ...table.rows]) {
    for (const cell of row) textLength += toPlainText(cell.tokens).length;
  }
  // The table block itself, its header row and every body row.
  return { block: richTableBlock(table), blockCount: 2 + table.rows.length, textLength };
}

/** A heading or any other non-table token as a rich heading or paragraph. */
function richTextPart(token: Token): RichPart {
  const children = childTokens(token);
  const text: RichText = children ? toRichText(children) : token.raw.trim();
  return {
    block:
      token.type === 'heading' ? { type: 'heading', text, size: 4 } : { type: 'paragraph', text },
    blockCount: 1,
    // The text the reader sees, as for table cells (no markdown markers).
    textLength: (children ? toPlainText(children) : token.raw.trim()).length,
  };
}

/**
 * Build the rich message (heading, tables, paragraphs, caption), or null when it does not fit the
 * rich-message limits (more than 20 columns, 500 blocks or 32768 characters of text).
 * `tokens` is `input.markdown` already lexed, when the caller has it.
 */
export function buildRichTableMessage(
  input: TableMessageInput,
  tokens: Token[] = marked.lexer(input.markdown),
): InputRichMessage | null {
  const blocks: InputRichBlock[] = [{ type: 'heading', text: input.title, size: 3 }];
  let blockCount = 1;
  let textLength = input.title.length + (input.caption?.length ?? 0);

  for (const token of tokens) {
    if (token.type === 'space') continue;
    const part = isTable(token) ? richTablePart(token) : richTextPart(token);
    if (!part) return null;
    blocks.push(part.block);
    blockCount += part.blockCount;
    textLength += part.textLength;
  }

  if (input.caption) {
    blocks.push({ type: 'paragraph', text: { type: 'italic', text: input.caption } });
    blockCount += 1;
  }

  if (blockCount > RICH_MAX_BLOCKS || textLength > RICH_MAX_TEXT_LENGTH) return null;
  return { blocks };
}

/** One table as aligned monospace lines, split into <pre> blocks that each fit a message. */
function preTableBlocks(table: Tokens.Table): string[] {
  const rows = [table.header, ...table.rows].map((row) =>
    row.map((cell) => toPlainText(cell.tokens).trim()),
  );
  const widths = table.header.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  const lines = rows.map((row) =>
    neutralizeHtml(
      widths
        .map((width, column) => {
          const value = row[column] ?? '';
          return table.align[column] === 'right' ? value.padStart(width) : value.padEnd(width);
        })
        .join(' | ')
        .trimEnd(),
    ),
  );
  const head = `${lines[0] ?? ''}\n${widths.map((width) => '-'.repeat(width)).join('-+-')}`;
  const budget = TELEGRAM_MAX_MESSAGE_LENGTH - '<pre></pre>'.length - head.length - 1;

  // Each chunk repeats the header so a split table stays readable.
  const chunks: string[][] = [[]];
  let used = 0;
  for (const line of lines.slice(1)) {
    const current = chunks[chunks.length - 1] ?? [];
    if (current.length > 0 && used + line.length + 1 > budget) {
      chunks.push([line]);
      used = line.length + 1;
    } else {
      current.push(line);
      used += line.length + 1;
    }
  }
  return chunks.map((chunk) => `<pre>${[head, ...chunk].join('\n')}</pre>`);
}

/**
 * Fallback: the same content as HTML messages with every table in monospace <pre> blocks.
 * `tokens` is `input.markdown` already lexed, when the caller has it.
 */
export function buildPreTableMessages(
  input: TableMessageInput,
  tokens: Token[] = marked.lexer(input.markdown),
): string[] {
  const blocks = [`<b>${neutralizeHtml(input.title)}</b>`];
  for (const token of tokens) {
    if (token.type === 'space') continue;
    if (isTable(token)) {
      blocks.push(...preTableBlocks(token));
      continue;
    }
    const children = childTokens(token);
    blocks.push(neutralizeHtml(children ? toPlainText(children) : token.raw.trim()));
  }
  if (input.caption) blocks.push(`<i>${neutralizeHtml(input.caption)}</i>`);
  return packHtmlBlocks(blocks);
}

/**
 * Send the table to the current chat context: a native rich table when it fits and Telegram
 * accepts it, otherwise the <pre> fallback.
 */
export async function sendTableMessage(input: TableMessageInput): Promise<void> {
  const tokens = marked.lexer(input.markdown);
  const richMessage = buildRichTableMessage(input, tokens);
  if (richMessage && (await sendRichMessage(richMessage))) return;

  logger.warn(
    { title: input.title, fitsRichLimits: richMessage !== null },
    'render_table: sending the table as <pre> text',
  );
  for (const text of buildPreTableMessages(input, tokens)) {
    await sendMessage(text);
  }
}
