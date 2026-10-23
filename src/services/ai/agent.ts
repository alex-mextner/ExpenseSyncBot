/**
 * ExpenseBotAgent — OpenAI SDK agent with tool calling for expense management
 *
 * Streams text to Telegram, executes tools, and manages the conversation loop.
 * Only final text responses are saved to chat history (not intermediate tool_use rounds).
 * A run always ends in a real answer, a short failure message, or (for unaddressed chatter
 * without tool calls only) intentional silence — never in an empty or tools-only message.
 * A stall guard watches the tool rounds: a stuck model is nudged, then the run moves to the next
 * provider of the chain, then it must answer; every run's features go to agent_trajectories.
 */

import { format } from 'date-fns';
import type { Bot } from 'gramio';
import type OpenAI from 'openai';
import { formatCommandsForPrompt } from '../../bot/command-descriptions';
import { CURRENCY_ALIASES, SUPPORTED_CURRENCIES } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import type { AgentRunOutcome } from '../../database/repositories/agent-trajectory.repository';
import type { ChatMessage } from '../../database/types';
import { AgentError } from '../../errors';
import { createLogger } from '../../utils/logger.ts';
import { AiDebugLogger, type AiDebugRunContext } from './debug-logger';
import { reportAiFailureToAdmin } from './error-reporter';
import { findReasoningLeak } from './reasoning-leak';
import { validateResponse } from './response-validator';
import {
  FINAL_ROUND_RESERVE_MS,
  type FinalizeReason,
  hashFeature,
  RUN_DEADLINE_MS,
  type StallDecision,
  StallGuard,
  type StallSignal,
  type ToolCallRecord,
} from './stall-guard';
import {
  aiStreamRound,
  classifyAiError,
  getBackoffDelay,
  isRetryableError,
  nextProvider,
  type StreamCallbacks,
  type StreamRoundResult,
} from './streaming';
import { isSkipSignal, NO_ANSWER_MESSAGE, TelegramStreamWriter } from './telegram-stream';
import { executeTool } from './tool-executor';
import { READ_ONLY_TOOL_NAMES, SYNCING_READ_TOOL_NAMES, TOOL_DEFINITIONS } from './tools';
import type { AgentContext, ToolCallResult, ToolResult } from './types';

const logger = createLogger('agent');

/** Singleton debug logger — writes full AI conversations to logs/chats/ when enabled */
export const aiDebugLogger = new AiDebugLogger(env.AI_DEBUG_LOGS, 'logs');

/**
 * Stage QA of PR #170: after reading page 1 of 8 a model summed those rows and answered them as the
 * month's total. Quoted in the nudge, the handoff note and the forced final round.
 */
const PARTIAL_DATA_RULE =
  'If a get_expenses result says "More pages", the rows you saw are only part of the data: for totals use its "Total for all" line (it covers every page), or call get_expenses with summary_only and currency, or read all the pages first — never present a sum of part of the data as the total.';
/**
 * Sent as the last message when the stall guard ends the tool rounds (a safety cap, or a stall
 * with no escalation left): the next round forbids tool calls, so the model has to answer from
 * what it already gathered instead of ending with no text.
 */
const FINAL_ANSWER_PROMPT = `[SYSTEM] The tool-call limit for this question is reached. Do NOT call any more tools. Answer the user now, using only the tool results above. Never write an amount or a currency that is not in the tool results — do not convert currencies yourself. Adding up amounts that ARE in the tool results is allowed here (no calculate call is possible now): show the amounts you add. ${PARTIAL_DATA_RULE} If some numbers are missing, give what you have and say what is missing.`;
/**
 * Sent when the model wrote its own notes about the task into the answer (seen on stage,
 * PR #170 QA). The leaked answer itself is not sent back.
 */
const REASONING_LEAK_NOTE =
  "[SYSTEM] Your previous reply mixed your internal notes about the conversation into the answer, so it was not shown to the user. Answer the user's last message again: only the final answer, in the user's language, without any notes about the task, the conversation or what you are going to do. Do not call tools: answer from the tool results above.";

/**
 * Currencies of the amounts in `text`, once each: a supported code or a currency symbol right
 * before or after a digit ("700 USD", "USD 700", "$700", "700 €"). Used to spot a forced answer
 * that names a currency no tool result had — the invented amounts of #166. Every pattern is a
 * fixed-width match, so the scan stays linear on long digit runs.
 */
function amountCurrencies(text: string): string[] {
  const codes = new Set<string>();
  const add = (token: string | undefined) => {
    const code = token && (CURRENCY_ALIASES[token] ?? token);
    if (code && SUPPORTED_CURRENCIES.some((c) => c === code)) codes.add(code);
  };
  // Up to 3 spaces of any kind (non-breaking ones included) between amount and currency, and an
  // optional sign before a prefixed amount ("USD -700", "USD −700").
  for (const m of text.matchAll(
    /\d[\s\u00a0\u202f]{0,3}([A-Z]{3}|[$€₽£])(?![A-Za-z])|(?<![A-Za-z])([A-Z]{3}|[$€₽£])[\s\u00a0\u202f]{0,3}[-−+]?\d/g,
  )) {
    add(m[1] ?? m[2]);
  }
  return [...codes];
}
/**
 * What the model was doing when the stall guard stepped in — quoted in the nudge (the first stall
 * of a run) and in the note for the model that takes the run over (later stalls).
 */
const STALL_DESCRIPTIONS: Record<StallSignal, string> = {
  repeated_call: 'the same tool call with the same result, again and again',
  cheap_tool_streak: 'one calculate call per step instead of one call for the whole computation',
  error_streak: 'tool calls that keep failing',
  alternation: 'switching back and forth between the same two tool calls',
  no_new_info: 'tool calls that return nothing new',
};
const MAX_API_RETRIES = 2; // 3 attempts total (1 initial + 2 retries)

/** One agent run as the stall guard and the trajectory log see it. */
interface RunTrajectory {
  startedAt: number;
  /** Seed of this run's feature hashes (hashFeature); never stored. */
  hashSeed: number;
  guard: StallGuard;
  /** Providers the run was handed away from; every later round skips them. */
  excludedProviders: string[];
  /** Providers that answered a round, in first-use order. */
  providers: string[];
  lastProvider: string | null;
  finalizeReason: FinalizeReason | null;
}

function newTrajectory(startedAt: number): RunTrajectory {
  return {
    startedAt,
    hashSeed: Math.floor(Math.random() * 2 ** 32),
    guard: new StallGuard(),
    excludedProviders: [],
    providers: [],
    lastProvider: null,
    finalizeReason: null,
  };
}

/**
 * JSON with object keys sorted at every level, so two tool calls with the same arguments in a
 * different key order produce the same cache key.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class ExpenseBotAgent {
  private ctx: AgentContext;
  /**
   * Results of read-only tool calls in the current run, keyed by tool name + canonical args.
   * Models without parallel tool calls repeat identical calls and burn the
   * round budget; a repeat gets the stored result back instead of running the tool again.
   */
  private readonly readOnlyToolResults = new Map<string, ToolResult>();
  /**
   * A write tool ran somewhere in the current run — also in an attempt runWithRetry threw away
   * (the data change stays). Such a run must answer; it never ends in silence.
   */
  private writeToolRan = false;
  /** Currency codes seen in this run's tool results (see amountCurrencies). */
  private readonly toolResultCurrencies = new Set<string>();
  /** Stall guard state and features of the current run (reset at the start of each run). */
  private trajectory: RunTrajectory = newTrajectory(0);

  constructor(_apiKey: string, ctx: AgentContext) {
    this.ctx = ctx;
  }

  /**
   * Run the full agent loop: stream text, execute tools, update Telegram message
   */
  async run(userMessage: string, conversationHistory: ChatMessage[], bot: Bot): Promise<string> {
    const writer = new TelegramStreamWriter(bot, this.ctx.chatId);
    const debugCtx = aiDebugLogger.createRunContext(
      this.ctx.userId,
      this.ctx.chatId,
      this.ctx.userName,
      this.ctx.userFullName,
      userMessage,
    );

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...this.buildHistoryMessages(conversationHistory),
      { role: 'user', content: userMessage },
    ];

    logger.info('[AGENT] Starting (smart chain)');
    logger.info(`[AGENT] Question: "${userMessage.substring(0, 150)}"`);

    debugCtx?.logSystemPrompt(messages[0]?.content as string);
    debugCtx?.logHistory(conversationHistory.map((m) => ({ role: m.role, content: m.content })));

    const toolCallNames: string[] = [];
    this.readOnlyToolResults.clear();
    this.writeToolRan = false;
    this.toolResultCurrencies.clear();
    this.trajectory = newTrajectory(this.now());
    try {
      database.agentTrajectories.markFollowUp(this.ctx.groupId, this.trajectory.startedAt);
    } catch (err) {
      logger.error({ err }, '[AGENT] Failed to mark the previous run trajectory as followed up');
    }

    try {
      const result = await this.runWithRetry(messages, writer, debugCtx, toolCallNames);
      let { text: finalText } = result;
      let { toolCount: totalToolCalls } = result;

      // --- Reasoning leak: the model wrote its own notes about the task into the answer (seen on
      // stage, PR #170 QA). Checked on the first answer and again on a validator
      // re-run's answer; at most one leak re-run per run. ---
      let leakRerunDone = false;
      const handleReasoningLeak = async (): Promise<void> => {
        if (leakRerunDone || isSkipSignal(finalText)) return;
        const leak = findReasoningLeak(finalText, userMessage);
        if (!leak) return;
        leakRerunDone = true;
        logger.warn(
          { leak: leak.slice(0, 200) },
          '[AGENT] Answer contains the model reasoning — re-running once without it',
        );
        const retry = await this.rerunWithNote({
          messages,
          writer,
          debugCtx,
          toolCallNames,
          rejectedText: null,
          // Tool-free: the first answer's tool results are in the history, and a write tool that
          // already ran (add_expense) must not run a second time.
          note: REASONING_LEAK_NOTE,
          toolFree: true,
        });
        const leakAgain = findReasoningLeak(retry.text, userMessage);
        if (leakAgain) {
          logger.warn(
            { leak: leakAgain.slice(0, 200) },
            '[AGENT] The re-run answer still contains the model reasoning — surfacing it',
          );
        }
        finalText = retry.text;
        totalToolCalls += retry.toolCount;
      };
      await handleReasoningLeak();

      // --- Validation pass (runs only when no tools were called in the whole run AND tools were
      // available) --- If the model called tools the data is real (a leak re-run reuses those
      // results); if no tools existed there's nothing to validate against. An intentional [SKIP]
      // is not an answer, so it is not validated.
      if (totalToolCalls === 0 && TOOL_DEFINITIONS.length > 0 && !isSkipSignal(finalText)) {
        const validated = await this.finalizeWithValidation({
          userMessage,
          messages,
          writer,
          debugCtx,
          toolCallNames,
          initial: { text: finalText, toolCount: totalToolCalls },
        });
        finalText = validated.text;
        totalToolCalls = validated.toolCount;
        await handleReasoningLeak();
      }

      // Skip signal — bot chose to stay silent. The writer replaces a missing answer with the
      // failure message unless silence is allowed (no mention, no write tool, no forced answer;
      // after reads only an explicit [SKIP]), so a skip here is always intentional — including
      // one emitted by the validator re-run (#108).
      if (isSkipSignal(finalText)) {
        logger.info('[AGENT] Skip signal — staying silent');
        debugCtx?.logFinal(finalText, totalToolCalls);
        debugCtx?.flush();
        this.recordTrajectory('silent');
        await writer.deleteSentMessage();
        return '';
      }

      debugCtx?.logAiText(finalText);
      debugCtx?.logFinal(finalText, totalToolCalls);
      debugCtx?.flush();
      this.recordTrajectory(finalText === NO_ANSWER_MESSAGE ? 'no_answer' : 'answered');

      await writer.sendRemainingChunks();
      return finalText;
    } catch (error) {
      const classification = classifyAiError(error);
      debugCtx?.logError(
        `${classification?.kind ?? 'unclassified'}: ${error instanceof Error ? error.message : String(error)}`,
      );
      debugCtx?.flush();
      this.recordTrajectory('error', classification?.kind ?? 'unclassified');
      if (!classification) {
        // Not a recognizable AI/network/timeout failure — propagate so the caller
        // (and logs) see the real, unrelated error instead of a masked generic one.
        // (No admin AI-failure report here: it isn't an AI failure.)
        await writer.deleteSentMessage();
        throw error;
      }

      // Only genuine failures page the admin: provider_down (chain unreachable / 5xx) and generic
      // (a recognized-but-uncategorized API error, including an exhausted-chain empty-response). The
      // transient / user-side classes — rate_limit (429), overloaded (529), timeout (our own 60s
      // abort) — are self-resolving and would only spam the operator, so they are logged warn and
      // skipped here. This is the SAME split as the warn-vs-error logging below.
      const isGenuineFailure =
        classification.kind === 'provider_down' || classification.kind === 'generic';
      if (isGenuineFailure) {
        // Throttled, fire-and-forget — never blocks the user path, never throws back into it.
        reportAiFailureToAdmin({
          groupId: this.ctx.groupId,
          telegramGroupId: this.ctx.telegramGroupId,
          userMessage,
          error,
        }).catch((reportErr) =>
          logger.error({ err: reportErr }, '[AGENT] admin failure report errored'),
        );
      }
      // Keep the original error (stack, status) in the logs — the user only sees the
      // short classified message, so this is the one place it's recorded at the boundary.
      // Server-side / unknown failures are error-level; transient client-side ones are warn.
      const logFields = { err: error, kind: classification.kind };
      const logMsg = '[AGENT] AI run failed — surfacing classified error to user';
      if (isGenuineFailure) {
        logger.error(logFields, logMsg);
      } else {
        logger.warn(logFields, logMsg);
      }
      // Under the work log when tools ran (they may have changed data), else as a plain message
      await writer.fail(classification.userMessage);
      throw new AgentError(classification.userMessage);
    }
  }

  /**
   * Run in batch mode — no streaming, no bot, no conversation history.
   * Used by smart advice system which wants the final text without side effects.
   */
  async runBatch(userMessage: string): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    let result = '';
    const { text } = await aiStreamRound(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        maxTokens: 1500,
        chain: 'smart',
        purpose: 'agent_batch',
      },
      {
        onTextDelta: (delta) => {
          result += delta;
        },
      },
    );
    return text || result;
  }

  /**
   * Retry wrapper: runs runAgentLoop with exponential backoff for transient API errors.
   */
  private async runWithRetry(
    messages: OpenAI.ChatCompletionMessageParam[],
    writer: TelegramStreamWriter,
    debugCtx: AiDebugRunContext | null,
    toolCallNames: string[],
  ): Promise<{ text: string; toolCount: number }> {
    // One overall deadline spanning all retries — a truly-stuck run is bounded
    // by RUN_DEADLINE_MS, not RUN_DEADLINE_MS × attempts. Once it fires, the
    // signal stays aborted, so any retry attempt aborts immediately.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUN_DEADLINE_MS);

    try {
      for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
        try {
          return await this.runAgentLoop(
            messages,
            writer,
            debugCtx,
            controller.signal,
            toolCallNames,
          );
        } catch (error) {
          // Overall deadline fired — stop retrying, surface the timeout.
          if (controller.signal.aborted) {
            throw error;
          }
          if (attempt < MAX_API_RETRIES && isRetryableError(error)) {
            const delay = getBackoffDelay(attempt, error);
            const errName = error instanceof Error ? error.message : String(error);
            logger.warn(
              `[AGENT] Attempt ${attempt + 1}/${MAX_API_RETRIES + 1} failed (${errName}), retrying in ${delay}ms`,
            );
            writer.reset();
            toolCallNames.length = 0;
            await this.sleep(delay);
            continue;
          }

          throw error;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    throw new Error('[AGENT] Retry loop exhausted');
  }

  /**
   * Validate the no-tool answer and, on a REJECT, re-run the agent EXACTLY ONCE. The re-run is
   * then surfaced as-is: trusted if it grounded itself in tool calls, otherwise surfaced
   * best-effort with a warning. We deliberately do NOT re-validate the re-run — at a one-retry
   * cap a second validator verdict can't change the outcome (we surface the re-run either way),
   * so re-validating would only add a second validator round-trip on the unhappy path.
   */
  private async finalizeWithValidation(args: {
    userMessage: string;
    messages: OpenAI.ChatCompletionMessageParam[];
    writer: TelegramStreamWriter;
    debugCtx: AiDebugRunContext | null;
    toolCallNames: string[];
    initial: { text: string; toolCount: number };
  }): Promise<{ text: string; toolCount: number }> {
    const { userMessage, messages, writer, debugCtx, toolCallNames, initial } = args;

    const validation = await validateResponse({
      userMessage,
      toolCalls: toolCallNames,
      response: initial.text,
    });
    if (validation.approved) {
      logger.info('[AGENT] Validation APPROVED');
      return initial;
    }

    logger.info(`[AGENT] Validation REJECTED: ${validation.reason} — re-running once`);
    const retry = await this.rerunWithNote({
      messages,
      writer,
      debugCtx,
      toolCallNames,
      rejectedText: initial.text,
      note: `[SYSTEM] Your previous response was rejected by the quality validator. Reason: ${validation.reason}. You MUST call the appropriate tools and re-answer the question properly. Do NOT repeat the same mistake.`,
      toolFree: false,
    });

    // Surface the re-run either way; the only difference is how we log it.
    if (toolCallNames.length > 0) {
      // The re-run grounded its answer in tool calls — trust it (same rule as the entry guard).
      logger.info('[AGENT] Retry called tools — accepted');
    } else {
      // Cap: one re-run already happened and it still called no tools. Surface the re-run's answer
      // (already streamed to the user) instead of looping toward the per-attempt timeout. This is
      // a quality cap, not a failure — no exception, and since no tools were called nothing was
      // mutated/persisted — so it stays a warn, not an admin failure report.
      logger.warn(
        { reason: validation.reason },
        '[AGENT] Validator rejected and the retry still used no tools — capping, surfacing best-effort answer',
      );
    }
    return retry;
  }

  /**
   * Re-run the agent loop once with a `[SYSTEM]` note after a rejected answer (validator reject,
   * or the model's reasoning inside the answer). `rejectedText` goes back into the history as the
   * assistant turn, or null to leave it out (leaked reasoning must not be fed back).
   * Intentionally a single attempt via `runAgentLoop` (not `runWithRetry`): the initial run
   * already spent its backoff budget, and capping the re-run at one attempt bounds total latency
   * — a transient error here propagates to the caller's catch instead of compounding the wait.
   */
  private async rerunWithNote(args: {
    messages: OpenAI.ChatCompletionMessageParam[];
    writer: TelegramStreamWriter;
    debugCtx: AiDebugRunContext | null;
    toolCallNames: string[];
    rejectedText: string | null;
    note: string;
    /** Answer from the results already gathered: no tool rounds (writes must not run twice). */
    toolFree: boolean;
  }): Promise<{ text: string; toolCount: number }> {
    const { messages, writer, debugCtx, toolCallNames, rejectedText, note, toolFree } = args;
    // The re-run shares the run's deadline: it gets only the time left since the run started, so
    // the stall guard's time budget and this abort measure the same clock.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, RUN_DEADLINE_MS - (this.now() - this.trajectory.startedAt)),
    );

    writer.reset();
    // The rejected answer is already on screen (the loop finalized it): replace it with the
    // progress mark now, not when the re-run streams its first words. A Telegram 429 can make
    // this edit wait; it never waits past the run deadline.
    await Promise.race([
      writer.flush(true),
      new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
    ]);
    toolCallNames.length = 0;

    if (rejectedText !== null) messages.push({ role: 'assistant', content: rejectedText });
    messages.push({ role: 'user', content: note });

    try {
      const retry = await this.runAgentLoop(
        messages,
        writer,
        debugCtx,
        controller.signal,
        toolCallNames,
        toolFree,
      );
      logger.info(
        `[AGENT] Retry response (${retry.text.length} chars): "${retry.text.substring(0, 200)}${retry.text.length > 200 ? '...' : ''}"`,
      );
      return retry;
    } finally {
      clearTimeout(timeout);
    }
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute the streaming agent loop: stream text, call tools, repeat until done.
   */
  private async runAgentLoop(
    messages: OpenAI.ChatCompletionMessageParam[],
    writer: TelegramStreamWriter,
    debugCtx: AiDebugRunContext | null,
    signal: AbortSignal,
    toolCallNames: string[],
    /** Skip the tool rounds: go straight to the forced, tool-free final round. */
    toolFree = false,
  ): Promise<{ text: string; toolCount: number }> {
    let totalToolCalls = 0;
    // A tool-free re-run, or a run the stall guard already ended (a re-run after a forced answer),
    // goes straight to the forced final round: tools do not open again.
    let mustAnswer = toolFree || this.trajectory.finalizeReason !== null;
    let continueLoop = !mustAnswer;
    let round = 0;

    // No fixed round cap here: the stall guard ends the tool rounds (40-round and time caps, or a
    // stall with no escalation left), and the run deadline bounds everything.
    while (continueLoop) {
      // Tool rounds only get the time before the final-round reserve: a round still running then
      // is cut, so the forced answer keeps one full provider timeout before the run deadline.
      const toolTimeLeft =
        RUN_DEADLINE_MS - FINAL_ROUND_RESERVE_MS - (this.now() - this.trajectory.startedAt);
      if (toolTimeLeft <= 0) {
        this.endToolRounds('time_budget');
        mustAnswer = true;
        break;
      }
      round++;
      debugCtx?.logRound(round);

      const callbacks: StreamCallbacks = {
        onTextDelta: (text) => writer.appendText(text),
        onToolCallStart: (name) => writer.setToolLabel(name, {}),
      };

      const toolTime = AbortSignal.timeout(toolTimeLeft);
      let result: StreamRoundResult;
      try {
        result = await aiStreamRound(
          {
            messages,
            tools: TOOL_DEFINITIONS,
            maxTokens: 4096,
            temperature: 0.3,
            chain: 'smart',
            purpose: 'agent',
            signal: AbortSignal.any([signal, toolTime]),
            excludeProviders: [...this.trajectory.excludedProviders],
          },
          callbacks,
        );
      } catch (err) {
        // Only the tool-round time ran out (the run deadline did not): the cut round's partial
        // text is dropped and the forced round answers from what was gathered.
        if (signal.aborted || !toolTime.aborted) throw err;
        writer.commitIntermediate();
        this.endToolRounds('time_budget');
        mustAnswer = true;
        break;
      }
      this.logRoundProvider(round, result, debugCtx);

      // Execute tool calls
      const toolResults: Array<ToolCallResult & { tool: string; argsKey: string }> = [];
      const repeatedCallIds = new Set<string>();

      for (const tc of result.toolCalls) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
        } catch {
          logger.error(
            `[AGENT] Malformed tool arguments for ${tc.name}: ${tc.arguments?.substring(0, 200)}`,
          );
          toolResults.push({
            id: tc.id,
            tool: tc.name,
            argsKey: tc.arguments ?? '',
            result: {
              success: false,
              error: `Malformed arguments: ${tc.arguments?.substring(0, 100)}`,
            },
          });
          continue;
        }

        logger.info(`[AGENT] Tool call: ${tc.name} ${JSON.stringify(input)}`);
        debugCtx?.logToolCall(tc.name, input);

        writer.setToolLabel(tc.name, input);
        await writer.flush(true);

        const isReadOnly = READ_ONLY_TOOL_NAMES[tc.name] === true;
        const argsKey = canonicalJson(input);
        const cacheKey = `${tc.name}:${argsKey}`;
        const cached = isReadOnly ? this.readOnlyToolResults.get(cacheKey) : undefined;
        let toolResult: ToolResult;
        if (cached) {
          logger.info(`[AGENT] Repeated tool call: ${tc.name} — reusing the earlier result`);
          repeatedCallIds.add(tc.id);
          toolResult = cached;
        } else if (
          // Checked right before the tool starts (after the awaited Telegram flush, which can wait
          // out a 429): once the final-round reserve is reached a tool is not started — an earlier
          // call may have been slow — so the forced answer keeps its time. A started tool is never
          // aborted, so writes stay whole.
          this.now() - this.trajectory.startedAt >=
          RUN_DEADLINE_MS - FINAL_ROUND_RESERVE_MS
        ) {
          logger.warn(
            `[AGENT] Tool call ${tc.name} skipped — no time left before the final answer`,
          );
          toolResult = {
            success: false,
            error: 'Not run: no time left for more tool calls in this answer.',
          };
        } else {
          if (!isReadOnly) this.writeToolRan = true;
          toolResult = await executeTool(tc.name, input, this.ctx);
          if (!isReadOnly || SYNCING_READ_TOOL_NAMES[tc.name] === true) {
            // The data may have changed (a write, or a read that synced from Sheets first) —
            // earlier reads are stale now.
            this.readOnlyToolResults.clear();
          }
          if (isReadOnly && toolResult.success) {
            this.readOnlyToolResults.set(cacheKey, toolResult);
          }
        }

        if (toolResult.success) {
          const preview = toolResult.output ? toolResult.output.substring(0, 300) : '(no output)';
          const total = toolResult.output?.length ?? 0;
          logger.info(
            `[AGENT] Tool result: ${tc.name} OK (${total} chars) preview: ${preview}${total > 300 ? '...' : ''}`,
          );
        } else {
          logger.info(`[AGENT] Tool result: ${tc.name} ERR: ${toolResult.error}`);
        }

        debugCtx?.logToolResult(
          tc.name,
          toolResult.success,
          toolResult.output,
          toolResult.error,
          toolResult.data,
          toolResult.summary,
        );
        totalToolCalls++;
        toolCallNames.push(tc.name);

        writer.markToolResult(toolResult.success);

        toolResults.push({ id: tc.id, tool: tc.name, argsKey, result: toolResult });
      }

      if (toolResults.length > 0) {
        writer.commitIntermediate();

        // Sanitize tool_calls before pushing to history — some providers
        // generate malformed JSON arguments that break subsequent
        // rounds when the next provider tries to parse the history.
        const sanitized = { ...result.assistantMessage };
        if ('tool_calls' in sanitized && Array.isArray(sanitized.tool_calls)) {
          sanitized.tool_calls = sanitized.tool_calls.map((tc) => {
            if (!('function' in tc)) return tc;
            try {
              JSON.parse(tc.function.arguments);
              return tc;
            } catch {
              return { ...tc, function: { ...tc.function, arguments: '{}' } };
            }
          });
        }
        messages.push(sanitized);

        // Add tool results (OpenAI format: role=tool)
        const seed = this.trajectory.hashSeed;
        const calls: ToolCallRecord[] = [];
        for (const tr of toolResults) {
          const content = tr.result.success
            ? tr.result.data !== undefined
              ? `${tr.result.summary ? `${tr.result.summary}\n` : ''}${JSON.stringify(tr.result.data)}`
              : tr.result.output || 'Success'
            : `Error: ${tr.result.error}`;
          // Evidence for the forced-answer check: currencies a successful result names (an error
          // listing every supported code is not data) — as whole-word codes (JSON fields like
          // "currency":"RSD" carry no amount next to them) or as amounts with a symbol ("10.00 $").
          if (tr.result.success) {
            for (const code of SUPPORTED_CURRENCIES) {
              if (new RegExp(`(?<![A-Za-z])${code}(?![A-Za-z])`).test(content)) {
                this.toolResultCurrencies.add(code);
              }
            }
            for (const code of amountCurrencies(content)) this.toolResultCurrencies.add(code);
          }
          calls.push({
            tool: tr.tool,
            argsHash: hashFeature(tr.argsKey, seed),
            resultHash: hashFeature(content, seed),
            isError: !tr.result.success,
          });

          messages.push({
            role: 'tool',
            tool_call_id: tr.id,
            content: repeatedCallIds.has(tr.id)
              ? `[This exact call was already made earlier in this answer — same result again. Do not repeat it; use the result.]\n${content}`
              : content,
          });
        }

        const decision = this.trajectory.guard.next(
          {
            round: this.trajectory.guard.entries.length + 1,
            provider: result.providerUsed,
            elapsedMs: this.now() - this.trajectory.startedAt,
            calls,
          },
          nextProvider('smart', [...this.trajectory.excludedProviders, result.providerUsed]) !==
            null,
        );
        mustAnswer = decision.action === 'finalize';
        continueLoop = !mustAnswer;
        await this.applyStallDecision(decision, result.providerUsed, messages, writer);
      } else {
        continueLoop = false;
      }
    }

    if (mustAnswer) {
      // The tool rounds are over while the model still wanted tools: without a last round that
      // forbids tool calls the run would end with no text at all (prod 2026-10-12, a model making
      // one call per round). The tools stay declared with tool_choice 'none': every smart-chain
      // provider accepted that live (2026-10-12), and without the tools Claude refused to add up
      // the grand total because rule 7 sends all arithmetic to calculate.
      // A tool-free re-run already ends with its own note asking for the answer.
      if (!toolFree) messages.push({ role: 'user', content: FINAL_ANSWER_PROMPT });
      debugCtx?.logRound(round + 1);
      try {
        const final = await aiStreamRound(
          {
            messages,
            tools: TOOL_DEFINITIONS,
            toolChoice: 'none',
            maxTokens: 4096,
            temperature: 0.3,
            chain: 'smart',
            purpose: 'agent_final',
            signal,
            excludeProviders: [...this.trajectory.excludedProviders],
          },
          { onTextDelta: (text) => writer.appendText(text) },
        );
        this.logRoundProvider(round + 1, final, debugCtx);
        const unseen = amountCurrencies(final.text).filter(
          (code) => !this.toolResultCurrencies.has(code),
        );
        if (unseen.length > 0) {
          // Not blocked: a log signal for review and the phase-1 dataset, not a verifier.
          logger.warn(
            { currencies: unseen, provider: final.providerUsed },
            '[AGENT] Forced final answer names amounts in a currency not in any tool result — possibly invented',
          );
        }
        if (final.toolCalls.length > 0) {
          // The provider ignored tool_choice 'none'. Its calls never run: once the tool rounds are
          // over only the text counts (none of the providers did this in the 2026-10-12 smoke).
          logger.warn(
            { provider: final.providerUsed, toolCalls: final.toolCalls.map((tc) => tc.name) },
            '[AGENT] Forced final round returned tool calls despite tool_choice none — ignored',
          );
        }
      } catch (err) {
        if (signal.aborted) {
          // The run deadline fired: report the timeout whatever error the round ended with.
          // runWithRetry never retries once the deadline fired, so no tool round is replayed.
          const deadlineError = new Error('AI overall deadline exceeded', { cause: err });
          deadlineError.name = 'AbortError';
          throw deadlineError;
        }
        // Rethrowing would make runWithRetry replay all tool rounds, and write tools
        // (add_expense, …) would run twice. The finalize below shows the failure message.
        logger.warn(
          { err },
          '[AGENT] Forced final answer round failed — showing the failure message',
        );
      }
    }

    // Silence is a choice only for chatter the bot was not asked about. A run that changed data
    // (a write tool ran in any attempt) or was forced to answer (in any loop of the run — a
    // validator re-run included) must answer; after read-only tools the writer accepts only an
    // explicit [SKIP], an empty text is still a failed answer.
    await writer.finalize({
      allowSilence:
        !this.ctx.isMention && this.trajectory.finalizeReason === null && !this.writeToolRan,
    });

    const finalText = writer.getText();
    logger.info(
      `[AGENT] Final response (${finalText.length} chars): "${finalText.substring(0, 200)}${finalText.length > 200 ? '...' : ''}"`,
    );

    return { text: finalText, toolCount: totalToolCalls };
  }

  /** Record which provider actually answered — the chain can fall back on any round. */
  private logRoundProvider(
    round: number,
    result: StreamRoundResult,
    debugCtx: AiDebugRunContext | null,
  ): void {
    logger.info(
      { round, provider: result.providerUsed, toolCalls: result.toolCalls.length },
      '[AGENT] Round answered',
    );
    debugCtx?.logProvider(result.providerUsed);
    const { providers } = this.trajectory;
    if (!providers.includes(result.providerUsed)) providers.push(result.providerUsed);
    this.trajectory.lastProvider = result.providerUsed;
  }

  /**
   * Act on the stall guard's decision after a tool round (`finalize` only needs the reason kept:
   * the caller then runs the forced final round). `provider` answered the round just judged.
   */
  private async applyStallDecision(
    decision: StallDecision,
    provider: string,
    messages: OpenAI.ChatCompletionMessageParam[],
    writer: TelegramStreamWriter,
  ): Promise<void> {
    switch (decision.action) {
      case 'continue':
        return;
      case 'nudge':
        logger.warn(
          { signal: decision.signal, provider },
          '[AGENT] Stall detected — nudging the model to change course',
        );
        messages.push({
          role: 'user',
          content: `[SYSTEM] You are going in circles: ${STALL_DESCRIPTIONS[decision.signal]}. Do not repeat tool calls. If the tool results above already answer the question, answer now. Otherwise change approach: for totals call get_expenses with summary_only and currency (converted per-category and grand totals in one call), or read all the pages; one calculate call takes a whole expression. ${PARTIAL_DATA_RULE}`,
        });
        return;
      case 'handoff': {
        // The stalled model stays out for the rest of the run (retries and the forced round too);
        // the next one gets the whole history, every tool result included.
        this.trajectory.excludedProviders.push(provider);
        const next = nextProvider('smart', this.trajectory.excludedProviders);
        logger.warn(
          { signal: decision.signal, from: provider, to: next },
          '[AGENT] Stall detected — handing the run to the next provider',
        );
        messages.push({
          role: 'user',
          content: `[SYSTEM] You are taking over this answer from another model that got stuck (${STALL_DESCRIPTIONS[decision.signal]}). The tool results above are real — reuse them and do not call the same tools again. Answer the user, calling only the tools that are still needed. ${PARTIAL_DATA_RULE}`,
        });
        await writer.addWorkLogNote(`🔄 Передаю задачу ${next ?? 'другой модели'}…`);
        return;
      }
      case 'finalize':
        this.endToolRounds(decision.reason);
        return;
    }
  }

  /** No more tool rounds in this run: the forced final round answers from what was gathered. */
  private endToolRounds(reason: FinalizeReason): void {
    this.trajectory.finalizeReason = reason;
    logger.warn(
      { reason, toolRounds: this.trajectory.guard.entries.length },
      '[AGENT] Tool rounds over — forcing a final answer with tool calls forbidden',
    );
  }

  /**
   * Store the finished run's features (stall-classifier dataset). Best effort: a failed write is
   * logged and never reaches the user.
   */
  private recordTrajectory(outcome: AgentRunOutcome, errorKind: string | null = null): void {
    const run = this.trajectory;
    try {
      database.agentTrajectories.create({
        groupId: this.ctx.groupId,
        startedAt: run.startedAt,
        finishedAt: this.now(),
        outcome,
        errorKind,
        isMention: this.ctx.isMention === true,
        // Every call the model made in a tool round, malformed ones included — the same calls
        // the round rows list.
        toolCalls: run.guard.entries.reduce((sum, entry) => sum + entry.calls.length, 0),
        nudges: run.guard.nudges,
        handoffs: run.guard.handoffs,
        providers: run.providers,
        answerProvider: outcome === 'error' ? null : run.lastProvider,
        finalizeReason: run.finalizeReason,
        rounds: run.guard.entries.map((entry) => ({
          round: entry.round,
          provider: entry.provider,
          elapsedMs: entry.elapsedMs,
          calls: entry.calls,
          decision: entry.decision.action,
          reason:
            'signal' in entry.decision
              ? entry.decision.signal
              : 'reason' in entry.decision
                ? entry.decision.reason
                : null,
        })),
      });
    } catch (err) {
      logger.error({ err }, '[AGENT] Failed to record the run trajectory');
    }
  }

  /** Clock of the stall guard and the trajectory log; a seam for tests. */
  protected now(): number {
    return Date.now();
  }

  /**
   * Build compact system prompt (no data dumps -- data comes from tools)
   */
  private buildSystemPrompt(): string {
    const now = new Date();
    const currentDate = format(now, 'yyyy-MM-dd');
    const currentMonth = format(now, 'yyyy-MM');

    let prompt = `You are a financial assistant for a Telegram expense tracking group.

CURRENT DATE: ${currentDate}
CURRENT MONTH: ${currentMonth}

CURRENT USER:
- Username: @${this.ctx.userName}
- Full name: ${this.ctx.userFullName}

## DATA INTEGRITY — CRITICAL
You MUST call the appropriate tool before answering any question about expenses or budgets.
You MUST use ONLY the exact numbers, dates, categories, and comments returned by the tool.
You MUST NEVER invent, assume, or extrapolate any expense data.
If the tool returns no data for a period — say so. Do NOT fill in plausible-sounding entries.
When listing individual expenses, copy the exact amount, date, and comment from the tool result. Do NOT paraphrase or round.
If an expense has no comment in the tool result, show nothing — do NOT invent a comment.

## TOOL USAGE
1. Expense questions → call get_expenses with the relevant period/category filter. The list is paginated (100/page): every page shows "Total for all N expenses" (the total of every page) and, when more pages exist, a "More pages" line. For totals use that line or summary_only: true; fetch the remaining pages only when you need the individual rows.
2. Budget questions → call get_budgets.
3. Adding an expense → call add_expense. NEVER say "done" without calling the tool.
4. Deleting an expense → call get_expenses first (to find the ID), confirm with the user, then call delete_expense.
5. User asks about "their" expenses → filter by a category matching their name.
6. For ANY aggregation question (total for a period, breakdown by category, "what did X spend", "how much in total", "по итогам", "сводка по месяцам") → ALWAYS use summary_only: true in get_expenses. The tool returns pre-calculated totals per category WITH stats (count, total, avg, median, min, max). For multi-period comparison, pass an array of periods — e.g. period: ["2025-11", "2025-12", "2026-01"]. NEVER call get_expenses multiple times for different periods — use a single call with an array. Same for get_budgets: pass month as array for multi-month comparison.
7. ANY arithmetic whatsoever → ALWAYS call calculate. EXCEPTIONS: (a) stats already computed by get_expenses (count, total, avg, median, min, max) do NOT need recalculation — use them directly from the tool response; (b) totals or a per-category breakdown in a specific currency ("в евро", "in USD") → call get_expenses with summary_only: true and currency: "<CODE>" — every category total and the grand total come already converted in that ONE call, so do NOT convert categories one by one with calculate. The calculate tool uses live exchange rates for currency conversion.
7a. When referring to "average" or "typical" spending → use MEDIAN from the stats, not avg. Median better represents the typical expense because it's not skewed by outliers. Avg is available for context but median should be the default "average" in your replies.
7b. Do not repeat a read call (get_*, calculate) with the same arguments — reuse the result you already have. The exception is a re-read after you changed data (rule 8): then call it again.
8. After calling set_budget or delete_budget → ALWAYS call get_budgets immediately to get fresh data before writing the response. Never use values from a previous get_budgets call after modifying budgets.
8a. BULK BUDGET SETTING: when the user asks to set budgets for multiple categories at once, FIRST call get_budgets to see which categories already have budgets this month. After setting all requested budgets, compare the list of existing budget categories with the ones you just set. If there are categories with existing budgets that were NOT mentioned by the user → ask whether they should be zeroed out (set to 0) or left unchanged. List those categories with their current limits. Do NOT silently leave old budgets in place — the user may have intended to replace the entire budget plan.
9. Bank balance questions → call get_bank_balances (omit bank_name to show all banks). If result data is empty, check the summary field and relay it to the user exactly — do NOT say the bank is not connected if the summary says otherwise. NEVER suggest /connect for bank issues — /connect is for Google Sheets only. For bank issues use /bank. If the user asks about disabled/hidden accounts → add show_hidden: true.
10. Bank transaction history → call get_bank_transactions.
11. Missing/unmatched bank expenses → call find_missing_expenses.
12. User asks you to remember, note, or save ANYTHING — a fact about a person, an account, a rule, a preference, any context — → call set_custom_prompt with mode="append". NEVER say "got it", "noted", "запомнил", or "remembered" without calling the tool first. This includes phrases like "запомни что", "note that", "keep in mind", "учти что".
13. Recurring patterns → call get_recurring_patterns. To manage (pause/resume/dismiss/delete) → call manage_recurring_pattern.
14. Changing a group setting (default currency, enabled currencies, bank-transaction cards) → call update_group_setting with setting=<key> and value=<string>. You CAN change these — never reply that you can't, and never tell the user to open /settings instead. Call get_group_settings first if you need current values, then apply and confirm the new value.
   - default_currency accepts ONLY the built-in supported codes (USD, EUR, RUB, RSD, GBP, BYN, CHF, JPY, CNY, INR, LKR, AED, EGP).
   - TOPIC: to BIND the bot to a topic the user must run /topic INSIDE that topic — update_group_setting active_topic_id can only CLEAR the binding ("сброс"), never set an id. Tell the user to use /topic for binding.
   - custom_prompt via update_group_setting OVERWRITES the entire prompt — use it ONLY for an explicit full rewrite or clear ("перепиши промпт", "очисти промпт"). To remember/add a note WITHOUT wiping existing notes, use set_custom_prompt (append) per rule 12.

## FORMATTING
Use ONLY these HTML tags (no Markdown, no ** or *):
- <b>bold</b> for amounts and categories
- <i>italic</i> for secondary info
- <code>code</code> for exact numbers and IDs
Escape < > & as &lt; &gt; &amp;
Do NOT use <blockquote>, <u>, or any other tags — they are reserved for system UI.
Do NOT use list tags (<ul>, <ol>, <li>) — Telegram does not support them. Write each list item on its own line starting with "• " (or "1. " for numbered steps).
Do NOT invent links.
NEVER use Markdown tables (|---|---| syntax) in chat messages — Telegram does not render them.
When you have tabular data: ALWAYS call render_table with the full Markdown table AND present the same data as a bullet list in your text reply. Both actions are mandatory — never skip either.
When displaying large amounts (≥ 1 million): prefer the suffix form — "1.5 млн RSD" over "1500000.00 RSD". Tool results include both forms (e.g. "1500000.00 (1.5 млн) RSD") — use the suffix form in your reply.

## BOT CAPABILITIES — STRICTLY ONLY THESE
This bot tracks expenses and budgets. It can:
- Record, view, delete expenses (amount + currency + category + comment)
- Track budgets per category/month
- Sync with Google Sheets (/sync, /push)
- Scan receipt photos (QR and OCR)
- Give financial advice and analytics
- Detect and track recurring monthly expenses (rent, subscriptions, etc.)
- Calculate with currency conversion (calculator tool)
- Connect bank accounts (/bank) to auto-import transactions with AI categorization
- View real-time bank account balances (get_bank_balances tool)
- Find bank transactions not yet recorded as expenses (find_missing_expenses tool)
- Change any group setting (default currency, enabled currencies, AI prompt, bank-transaction cards, topic) via update_group_setting

IMPORTANT: /connect is for Google Sheets integration only. /bank is for bank account integration (TBC, Kaspi, etc.).

The bot CANNOT:
- Create events, reminders, or calendar entries
- Schedule tasks or appointments
- Send notifications at specific times
- Manage contacts, notes, or to-do lists
- Process voice messages
- Do anything unrelated to expense tracking

NEVER mention, suggest, or describe features that are NOT listed above. If a user asks for something outside these capabilities — say directly that the bot doesn't support it.

When a user asks "что ты умеешь?", "what can you do?", or similar — list your capabilities in plain language without mentioning tool names or technical details. Example:
- Записывать и удалять расходы (сумма, валюта, категория, комментарий)
- Вести бюджеты по категориям и месяцам
- Сканировать чеки по фото (просто скинь фотку)
- Показывать статистику и аналитику расходов
- Синхронизировать данные с Google Sheets (в обе стороны)
- Подключать банки и автоматически импортировать транзакции
- Показывать балансы банковских счетов
- Находить банковские транзакции, которые ещё не записаны как расходы
- Конвертировать валюты и считать любые выражения
- Отслеживать повторяющиеся расходы (аренда, подписки и т.д.)
- Давать финансовые советы и отвечать на вопросы о тратах
- Менять настройки группы: валюту по умолчанию, набор валют, AI-промпт, карточки банковских транзакций, топик
- Запоминать заметки и правила для группы
- Отправлять фидбек и баг-репорты администратору

## AVAILABLE COMMANDS
${formatCommandsForPrompt()}

## WHEN TO STAY SILENT
CRITICAL: The skip marker is EXACTLY the 6-character string [SKIP]. Not [ПРОПУСК], not [skip], not (skip), not any variation. ALWAYS output [SKIP] in English, in square brackets, uppercase. This is a machine-parsed token — do not translate it.
When you decide to stay silent, output [SKIP] and NOTHING ELSE — no reasoning, no emoji, no "Готово", no commentary before or after.
Stay silent ([SKIP]) when:
- Someone makes a statement, shares a thought, or talks about plans ("надо будет обсудить", "хочу разобраться", "интересно было бы", "мог бы", "было бы хорошо")
- Casual acknowledgements: "ok", "thanks", "понял", "окей", "хорошо", "+1", "ок"
- People discussing something between themselves, even if the topic is about finances or this bot
- Someone expresses an opinion or suggestion without asking you to do something right now
Respond only when:
- There is a direct question ("сколько?", "покажи", "что такое X?")
- There is a direct command ("добавь", "удали", "покажи бюджет")
- Someone explicitly addresses you by name or @mention

Respond in Russian if the user writes in Russian, otherwise in English.`;

    if (this.ctx.isForumWithoutTopic) {
      prompt += `\n\nЭта группа использует топики (форум), но команда /topic ещё не настроена — бот слушает все топики.
Если пользователь жалуется, что бот отвечает не там или реагирует когда не нужно — посоветуй перейти в топик для финансов и написать /topic, чтобы бот работал только в этом топике.`;
    }

    if (this.ctx.customPrompt) {
      prompt += `\n\n=== CUSTOM GROUP INSTRUCTIONS ===\n${this.ctx.customPrompt}`;
    }

    return prompt;
  }

  /**
   * Convert stored chat messages to OpenAI message format
   */
  private buildHistoryMessages(history: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return history.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));
  }
}
