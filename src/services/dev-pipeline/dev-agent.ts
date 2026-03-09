// src/services/dev-pipeline/dev-agent.ts
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, AI_BASE_URL } from '../ai/agent';
import { env } from '../../config/env';
import {
  readFile,
  writeFile,
  listDirectory,
  searchCode,
  fileExists,
  deleteFile,
} from './file-ops';
import { commitChanges } from './git-ops';

const DEV_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the project. Use relative paths from project root (e.g., "src/bot/commands/ask.ts")',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Use for creating new files or fully replacing existing ones.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories. Use to explore the project structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: ".")' },
      },
    },
  },
  {
    name: 'search_code',
    description: 'Search for a regex pattern across source files. Returns matching lines with file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        glob: { type: 'string', description: 'Optional file glob filter (e.g., "*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file_exists',
    description: 'Check if a file exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'commit',
    description: 'Stage and commit all current changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['message'],
    },
  },
];

const MAX_ROUNDS = 30;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class DevAgent {
  private anthropic: Anthropic;
  private worktreePath: string;

  constructor(worktreePath: string) {
    this.anthropic = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: AI_BASE_URL,
    });
    this.worktreePath = worktreePath;
  }

  /**
   * Run agent with a system prompt and user message.
   * Returns the final text response.
   */
  async run(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    try {
      let round = 0;
      let finalText = '';

      while (round < MAX_ROUNDS) {
        round++;

        const response = await this.anthropic.messages.create(
          {
            model: AI_MODEL,
            max_tokens: 8192,
            system: systemPrompt,
            messages,
            tools: DEV_TOOLS,
          },
          { signal: controller.signal }
        );

        // Collect text and tool_use blocks
        const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            finalText += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
          }
        }

        if (toolCalls.length === 0 || response.stop_reason === 'end_turn') {
          break;
        }

        // Execute tools and build results
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const call of toolCalls) {
          console.log(`[DEV-AGENT] Tool: ${call.name}`, JSON.stringify(call.input).slice(0, 200));
          const result = await this.executeTool(call.name, call.input);
          console.log(`[DEV-AGENT] Result: ${result.slice(0, 200)}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: result,
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }

      return finalText;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'read_file':
          return await readFile(this.worktreePath, input.path as string);

        case 'write_file':
          await writeFile(this.worktreePath, input.path as string, input.content as string);
          return `Written: ${input.path}`;

        case 'list_directory':
          const files = await listDirectory(this.worktreePath, (input.path as string) || '.');
          return files.join('\n');

        case 'search_code':
          const results = await searchCode(this.worktreePath, input.pattern as string, input.glob as string | undefined);
          return results || 'No matches found.';

        case 'file_exists':
          return fileExists(this.worktreePath, input.path as string) ? 'true' : 'false';

        case 'delete_file':
          await deleteFile(this.worktreePath, input.path as string);
          return `Deleted: ${input.path}`;

        case 'commit':
          await commitChanges(this.worktreePath, input.message as string);
          return `Committed: ${input.message}`;

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
