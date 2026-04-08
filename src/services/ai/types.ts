/**
 * Types for the Anthropic AI agent
 */

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  /** Structured payload for tools that return machine-readable data (bank tools). */
  data?: unknown;
  /** Human-readable summary appended alongside data. */
  summary?: string;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface ToolCallResult {
  id: string;
  result: ToolResult;
}

/**
 * Minimal writer interface used by the agent loop.
 * TelegramStreamWriter (real-time streaming) and BufferStreamWriter (batch mode) both implement this.
 */
export interface AgentStreamWriter {
  appendText(delta: string): void;
  setToolLabel(name: string, input?: Record<string, unknown>): void;
  flush(force?: boolean): Promise<void>;
  markToolResult(success: boolean): void;
  commitIntermediate(): void;
  finalize(): Promise<void>;
  getText(): string;
  reset(): void;
  deleteSentMessage(): Promise<void>;
  sendRemainingChunks(): Promise<void>;
}

export interface AgentContext {
  groupId: number;
  userId: number;
  chatId: number;
  userName: string;
  userFullName: string;
  customPrompt: string | null;
  telegramGroupId: number;
  /** Send a PNG image buffer to the chat. Used by render_table tool. */
  sendPhoto?: (imageBuffer: Buffer) => Promise<void>;
  /** True when the message was sent via explicit @mention — never skip in this case. */
  isMention?: boolean;
  /** True when the group is a forum and /topic has not been configured yet. */
  isForumWithoutTopic?: boolean;
}
