/**
 * Buffer-based stream writer for batch (non-streaming) agent mode.
 * Captures all text output without sending to Telegram.
 */
import type { AgentStreamWriter } from './types';

export class BufferStreamWriter implements AgentStreamWriter {
  private fullText = '';
  private historyText = '';

  appendText(delta: string): void {
    this.fullText += delta;
  }

  setToolLabel(_name: string, _input?: Record<string, unknown>): void {
    // No-op: no Telegram UI to update
  }

  async flush(_force?: boolean): Promise<void> {
    // No-op: no Telegram message to edit
  }

  markToolResult(_success: boolean): void {
    // No-op: no Telegram UI to update
  }

  commitIntermediate(): void {
    // Reset text buffer between tool-use rounds, same as TelegramStreamWriter
    this.fullText = '';
  }

  async finalize(): Promise<void> {
    this.historyText = this.fullText.trim();
  }

  getText(): string {
    return this.historyText;
  }

  reset(): void {
    this.fullText = '';
    this.historyText = '';
  }

  async deleteSentMessage(): Promise<void> {
    // No-op: no Telegram message to delete
  }

  async sendRemainingChunks(): Promise<void> {
    // No-op: no Telegram chunks to send
  }
}
