/** Tests for BufferStreamWriter — batch mode text accumulator */
import { describe, expect, test } from 'bun:test';
import { BufferStreamWriter } from './buffer-stream';

describe('BufferStreamWriter', () => {
  test('accumulates text from appendText', async () => {
    const writer = new BufferStreamWriter();
    writer.appendText('Hello ');
    writer.appendText('World');
    await writer.finalize();
    expect(writer.getText()).toBe('Hello World');
  });

  test('getText returns empty before finalize', () => {
    const writer = new BufferStreamWriter();
    writer.appendText('some text');
    expect(writer.getText()).toBe('');
  });

  test('commitIntermediate resets text for next round', async () => {
    const writer = new BufferStreamWriter();
    writer.appendText('Round 1 intermediate text');
    writer.commitIntermediate();
    writer.appendText('Final response');
    await writer.finalize();
    expect(writer.getText()).toBe('Final response');
  });

  test('reset clears all state', async () => {
    const writer = new BufferStreamWriter();
    writer.appendText('some text');
    await writer.finalize();
    expect(writer.getText()).toBe('some text');

    writer.reset();
    expect(writer.getText()).toBe('');
  });

  test('no-op methods do not throw', async () => {
    const writer = new BufferStreamWriter();
    // All these should be silent no-ops
    writer.setToolLabel('get_expenses', { period: '2026-04' });
    await writer.flush(true);
    writer.markToolResult(true);
    await writer.deleteSentMessage();
    await writer.sendRemainingChunks();
  });

  test('trims whitespace on finalize', async () => {
    const writer = new BufferStreamWriter();
    writer.appendText('  text with spaces  \n\n');
    await writer.finalize();
    expect(writer.getText()).toBe('text with spaces');
  });

  test('multiple rounds: only last round text is preserved', async () => {
    const writer = new BufferStreamWriter();

    // Round 1: tool call round (text gets cleared)
    writer.appendText('Thinking about expenses...');
    writer.commitIntermediate();

    // Round 2: tool call round
    writer.appendText('Looking at budgets...');
    writer.commitIntermediate();

    // Round 3: final response
    writer.appendText('Расходы на еду выросли на 15%.');
    await writer.finalize();

    expect(writer.getText()).toBe('Расходы на еду выросли на 15%.');
  });
});
