// AI-powered dev agent — uses OpenAI SDK with tool calling to implement tasks via file and git operations
import type OpenAI from 'openai';
import { getErrorMessage } from '../../utils/error';
import { createLogger } from '../../utils/logger.ts';
import { aiStreamRound, type StreamRoundResult } from '../ai/streaming';
import { deleteFile, fileExists, listDirectory, readFile, searchCode, writeFile } from './file-ops';
import { commitChanges, managePackages, revertFileToMain } from './git-ops';

type ChatMessage = OpenAI.ChatCompletionMessageParam;

const logger = createLogger('dev-agent');

/** Tool definitions in OpenAI format */
function devTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAI.ChatCompletionTool {
  return { type: 'function', function: { name, description, parameters } };
}

const DEV_TOOLS: OpenAI.ChatCompletionTool[] = [
  devTool(
    'read_file',
    'Read a file from the project. Use relative paths from project root (e.g., "src/bot/commands/ask.ts")',
    {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path' } },
      required: ['path'],
    },
  ),
  devTool(
    'write_file',
    'Write content to a file. Creates parent directories if needed. Use for creating new files or fully replacing existing ones.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  ),
  devTool('list_directory', 'List files and directories. Use to explore the project structure.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative directory path (default: ".")' } },
  }),
  devTool(
    'search_code',
    'Search for a regex pattern across source files. Returns matching lines with file paths.',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        glob: { type: 'string', description: 'Optional file glob filter (e.g., "*.ts")' },
      },
      required: ['pattern'],
    },
  ),
  devTool('file_exists', 'Check if a file exists.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative file path' } },
    required: ['path'],
  }),
  devTool('delete_file', 'Delete a file from the project.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative file path' } },
    required: ['path'],
  }),
  devTool(
    'revert_file',
    'Revert a file to its original version from main branch. Use this when you modified a file that is NOT part of your task and it caused test failures. If the file did not exist on main, it will be deleted.',
    {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path to revert' } },
      required: ['path'],
    },
  ),
  devTool('commit', 'Stage and commit all current changes.', {
    type: 'object',
    properties: { message: { type: 'string', description: 'Commit message' } },
    required: ['message'],
  }),
  devTool(
    'manage_packages',
    'Install or remove npm packages in the project. Use this when your implementation requires a new dependency or when replacing one library with another.',
    {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Whether to add or remove packages',
        },
        packages: {
          type: 'string',
          description: 'Space-separated package names (e.g., "lodash zod" or "@types/lodash")',
        },
      },
      required: ['action', 'packages'],
    },
  ),
];

const MAX_ROUNDS = 500;
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Thrown when agent is aborted externally (e.g. user cancelled the task). */
export class AgentAbortedError extends Error {
  constructor() {
    super('Agent was cancelled by user');
    this.name = 'AgentAbortedError';
  }
}

export class DevAgent {
  private worktreePath: string;
  private externalAbort: AbortController | null = null;
  private aborted = false;

  constructor(worktreePath: string) {
    this.worktreePath = worktreePath;
  }

  abort(): void {
    this.aborted = true;
    this.externalAbort?.abort();
  }

  async run(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    this.externalAbort = controller;
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    try {
      let round = 0;
      let finalText = '';

      while (round < MAX_ROUNDS) {
        round++;
        logger.info(`[DEV-AGENT] Round ${round}/${MAX_ROUNDS}`);

        let result: StreamRoundResult;
        try {
          result = await aiStreamRound({
            messages,
            maxTokens: 8192,
            tools: DEV_TOOLS,
            chain: 'smart',
            signal: controller.signal,
          });
        } catch (err: unknown) {
          if ((err instanceof Error && err.name === 'AbortError') || controller.signal.aborted) {
            if (this.aborted) {
              throw new AgentAbortedError();
            }
            throw new Error(
              `Agent timed out after ${AGENT_TIMEOUT_MS / 60000} minutes (completed ${round - 1} rounds)`,
            );
          }
          throw err;
        }

        // Parse response
        const toolCalls = result.toolCalls ?? [];
        if (result.text) {
          finalText += result.text;
        }

        logger.info(
          `[DEV-AGENT] finish=${result.finishReason} toolCalls=${toolCalls.length} textLen=${finalText.length}`,
        );

        if (toolCalls.length === 0) {
          break;
        }

        // Build assistant message with tool calls for history
        messages.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute tools and add results
        for (const call of toolCalls) {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          } catch {
            logger.error(
              `[DEV-AGENT] Malformed tool arguments for ${call.name}: ${call.arguments?.substring(0, 200)}`,
            );
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: `Error: malformed arguments`,
            });
            continue;
          }
          logger.info(`[DEV-AGENT] Tool: ${call.name} ${JSON.stringify(input).slice(0, 200)}`);
          const toolResult = await this.executeTool(call.name, input);
          logger.info(`[DEV-AGENT] Result: ${toolResult.slice(0, 200)}`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
        }
      }

      // Nudge for final answer if no text produced
      if (!finalText.trim() && round < MAX_ROUNDS) {
        logger.info('[DEV-AGENT] No text produced — sending nudge for final answer');
        messages.push({ role: 'user', content: 'Please now write your final answer as text.' });
        const nudge = await aiStreamRound({ messages, maxTokens: 8192, chain: 'smart' });
        finalText += nudge.text;
        logger.info(`[DEV-AGENT] Nudge result: textLen=${finalText.length}`);
      }

      return finalText;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      const str = (key: string): string => {
        const v = input[key];
        if (typeof v !== 'string' || !v) throw new Error(`Missing required param: ${key}`);
        return v;
      };

      switch (name) {
        case 'read_file':
          return await readFile(this.worktreePath, str('path'));

        case 'write_file':
          await writeFile(this.worktreePath, str('path'), str('content'));
          return `Written: ${input['path']}`;

        case 'list_directory': {
          const files = await listDirectory(this.worktreePath, (input['path'] as string) || '.');
          return files.join('\n');
        }

        case 'search_code': {
          const results = await searchCode(
            this.worktreePath,
            str('pattern'),
            input['glob'] as string | undefined,
          );
          return results || 'No matches found.';
        }

        case 'file_exists':
          return fileExists(this.worktreePath, str('path')) ? 'true' : 'false';

        case 'delete_file':
          await deleteFile(this.worktreePath, str('path'));
          return `Deleted: ${input['path']}`;

        case 'revert_file':
          await revertFileToMain(this.worktreePath, str('path'));
          return `Reverted to main: ${input['path']}`;

        case 'commit':
          await commitChanges(this.worktreePath, str('message'));
          return `Committed: ${input['message']}`;

        case 'manage_packages': {
          const action = str('action');
          if (action !== 'add' && action !== 'remove') {
            return 'Error: action must be "add" or "remove"';
          }
          return await managePackages(this.worktreePath, action, str('packages'));
        }

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error) {
      return `Error: ${getErrorMessage(error)}`;
    }
  }
}
