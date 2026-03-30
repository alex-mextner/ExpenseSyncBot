// Full conversation debug logger. Enabled via AI_DEBUG_LOGS=true.
// Writes to logs/chats/{chatId}/{YYYY-MM-DD_HH-MM-SS}.log — one file per dialog session.
// A new session starts after SESSION_TIMEOUT_MS of inactivity.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → new file

/**
 * Context for a single AI conversation run — accumulates log entries
 * and flushes them to disk at the end.
 */
export class AiDebugRunContext {
  private parts: string[] = [];

  constructor(
    private readonly file: string,
    userId: number,
    chatId: number,
    username: string | undefined,
    userFullName: string,
    messageText: string,
  ) {
    const ts = new Date().toISOString();
    const userLabel = [`uid:${userId}`, username ? `@${username}` : null, userFullName]
      .filter(Boolean)
      .join(' ');

    this.parts.push('');
    this.parts.push('='.repeat(80));
    this.parts.push(`[${ts}]`);
    this.parts.push(`CHAT: ${chatId} | USER: ${userLabel}`);
    this.parts.push(`MESSAGE: ${messageText}`);
    this.parts.push('='.repeat(80));
  }

  logSystemPrompt(prompt: string): void {
    this.parts.push('');
    this.parts.push('## SYSTEM PROMPT');
    this.parts.push(prompt);
    this.parts.push('## END SYSTEM PROMPT');
  }

  logHistory(messages: Array<{ role: string; content: string }>): void {
    this.parts.push('');
    this.parts.push(`## HISTORY [${messages.length} messages]`);
    for (const msg of messages) {
      this.parts.push(`[${msg.role}]`);
      this.parts.push(msg.content.slice(0, 500));
    }
    this.parts.push('## END HISTORY');
  }

  logRound(round: number): void {
    this.parts.push('');
    this.parts.push(`## ROUND ${round}`);
  }

  logToolCall(name: string, input: Record<string, unknown>): void {
    this.parts.push(`TOOL CALL: ${name}`);
    this.parts.push(
      JSON.stringify(input, null, 2)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  logToolResult(
    name: string,
    success: boolean,
    output?: string,
    error?: string,
    data?: unknown,
    summary?: string,
  ): void {
    const status = success ? 'OK' : 'ERROR';
    let body: string;
    if (output !== undefined) {
      body = output;
    } else if (data !== undefined) {
      const summaryPart = summary ? `${summary}\n` : '';
      body = `${summaryPart}${JSON.stringify(data)}`;
    } else {
      body = error ?? '';
    }
    this.parts.push(`TOOL RESULT: ${name} → ${status}`);
    this.parts.push(`  ${body.slice(0, 400)}`);
  }

  logAiText(text: string): void {
    if (!text.trim()) return;
    this.parts.push('AI TEXT:');
    this.parts.push(
      text
        .slice(0, 600)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  logFinal(responseText: string, toolCount: number): void {
    this.parts.push('');
    this.parts.push('## FINAL');
    this.parts.push(`Tools called: ${toolCount}`);
    this.parts.push(`Response (${responseText.length} chars):`);
    this.parts.push(
      responseText
        .slice(0, 600)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    this.parts.push('='.repeat(80));
  }

  flush(): void {
    try {
      appendFileSync(this.file, `${this.parts.join('\n')}\n`);
    } catch {
      // Debug logging is non-critical — write failures must not crash the agent
    }
  }
}

interface SessionEntry {
  file: string;
  lastActivity: number;
}

/**
 * Manages per-chat log file sessions.
 * Reuses the same file for 30 min of activity, then starts a new one.
 */
export class AiDebugLogger {
  private sessions = new Map<number, SessionEntry>();

  constructor(
    private readonly enabled: boolean,
    private readonly logsDir: string,
  ) {}

  private getSessionFile(chatId: number): string {
    const now = Date.now();
    const existing = this.sessions.get(chatId);

    if (existing && now - existing.lastActivity < SESSION_TIMEOUT_MS) {
      existing.lastActivity = now;
      return existing.file;
    }

    const dir = path.join(this.logsDir, 'chats', String(chatId));
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Non-critical
    }

    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    const file = path.join(dir, `${ts}.log`);

    this.sessions.set(chatId, { file, lastActivity: now });
    return file;
  }

  createRunContext(
    userId: number,
    chatId: number,
    username: string | undefined,
    userFullName: string,
    messageText: string,
  ): AiDebugRunContext | null {
    if (!this.enabled) return null;

    const file = this.getSessionFile(chatId);
    return new AiDebugRunContext(file, userId, chatId, username, userFullName, messageText);
  }
}
