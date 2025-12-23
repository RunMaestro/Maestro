/**
 * Claude Code Output Parser
 *
 * Parses stream-json output from Claude Code CLI.
 * Claude Code outputs JSONL (JSON Lines) with different message types:
 * - system/init: Session initialization with slash commands
 * - assistant: Streaming text content (partial responses)
 * - result: Final complete response
 * - Messages may include session_id, modelUsage, usage, total_cost_usd
 *
 * @see https://github.com/anthropics/claude-code
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { aggregateModelUsage, type ModelStats } from './usage-aggregator';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Content block in Claude assistant messages
 * Can be text, tool_use, thinking, or redacted_thinking blocks
 *
 * Extended thinking (Claude 3.7 Sonnet, Claude 4+) produces:
 * - thinking: Internal reasoning content (may be encrypted in signature)
 * - redacted_thinking: Encrypted thinking content (for safety-flagged reasoning)
 * - text: The final user-facing response
 */
interface ClaudeContentBlock {
  type: string;
  text?: string;
  // Extended thinking fields (Claude 3.7+, Claude 4+)
  thinking?: string;
  signature?: string;
  // Tool use fields
  name?: string;
  id?: string;
  input?: unknown;
}

/**
 * Raw message structure from Claude Code stream-json output
 */
interface ClaudeRawMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    role?: string;
    content?: string | ClaudeContentBlock[];
  };
  slash_commands?: string[];
  modelUsage?: Record<string, ModelStats>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * Claude Code Output Parser Implementation
 *
 * Transforms Claude Code's stream-json format into normalized ParsedEvents.
 */
export class ClaudeOutputParser implements AgentOutputParser {
  readonly agentId: ToolType = 'claude-code';

  /**
   * Parse a single JSON line from Claude Code output
   *
   * Claude Code message types:
   * - { type: 'system', subtype: 'init', session_id, slash_commands }
   * - { type: 'assistant', message: { role, content } }
   * - { type: 'result', result: string, session_id, modelUsage, usage, total_cost_usd }
   */
  parseJsonLine(line: string): ParsedEvent | null {
    if (!line.trim()) {
      return null;
    }

    try {
      const msg: ClaudeRawMessage = JSON.parse(line);
      return this.transformMessage(msg);
    } catch {
      // Not valid JSON - return as raw text event
      return {
        type: 'text',
        text: line,
        raw: line,
      };
    }
  }

  /**
   * Transform a parsed Claude message into a normalized ParsedEvent
   */
  private transformMessage(msg: ClaudeRawMessage): ParsedEvent {
    // Handle system/init messages
    if (msg.type === 'system' && msg.subtype === 'init') {
      return {
        type: 'init',
        sessionId: msg.session_id,
        slashCommands: msg.slash_commands,
        raw: msg,
      };
    }

    // Handle result messages (final complete response)
    if (msg.type === 'result') {
      // The result field contains the complete formatted response
      // Fall back to message.content if result is not present
      let resultText = msg.result;
      if (!resultText && msg.message?.content) {
        resultText = this.extractTextFromMessage(msg);
      }

      const event: ParsedEvent = {
        type: 'result',
        text: resultText,
        sessionId: msg.session_id,
        raw: msg,
      };

      // Extract usage stats if present
      const usage = this.extractUsageFromRaw(msg);
      if (usage) {
        event.usage = usage;
      }

      return event;
    }

    // Handle assistant messages (streaming partial responses)
    if (msg.type === 'assistant') {
      const text = this.extractTextFromMessage(msg);
      const toolUseBlocks = this.extractToolUseBlocks(msg);

      return {
        type: 'text',
        text,
        sessionId: msg.session_id,
        isPartial: true,
        toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
        raw: msg,
      };
    }

    // Handle messages with only usage stats (no content type)
    if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
      const usage = this.extractUsageFromRaw(msg);
      return {
        type: 'usage',
        sessionId: msg.session_id,
        usage: usage || undefined,
        raw: msg,
      };
    }

    // Handle system messages (other subtypes)
    if (msg.type === 'system') {
      return {
        type: 'system',
        sessionId: msg.session_id,
        raw: msg,
      };
    }

    // Default: preserve as system event
    return {
      type: 'system',
      sessionId: msg.session_id,
      raw: msg,
    };
  }

  /**
   * Extract tool_use blocks from a Claude assistant message
   * These blocks contain tool invocation requests from the AI
   */
  private extractToolUseBlocks(
    msg: ClaudeRawMessage
  ): Array<{ name: string; id?: string; input?: unknown }> {
    if (!msg.message?.content || typeof msg.message.content === 'string') {
      return [];
    }

    return msg.message.content
      .filter((block) => block.type === 'tool_use' && block.name)
      .map((block) => ({
        name: block.name!,
        id: block.id,
        input: block.input,
      }));
  }

  /**
   * Extract text content from a Claude assistant message
   *
   * Only extracts 'text' type blocks - explicitly excludes:
   * - 'thinking' blocks (extended thinking reasoning content)
   * - 'redacted_thinking' blocks (safety-encrypted thinking)
   * - 'tool_use' blocks (handled separately by extractToolUseBlocks)
   *
   * Extended thinking content is emitted separately via thinking-chunk events
   * and controlled by the tab's showThinking setting in the renderer.
   */
  private extractTextFromMessage(msg: ClaudeRawMessage): string {
    if (!msg.message?.content) {
      return '';
    }

    // Content can be string or array of content blocks
    if (typeof msg.message.content === 'string') {
      return msg.message.content;
    }

    // Array of content blocks - extract ONLY text blocks
    // Thinking blocks (type: 'thinking', 'redacted_thinking') are intentionally excluded
    return msg.message.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('');
  }

  /**
   * Extract usage statistics from raw Claude message
   */
  private extractUsageFromRaw(msg: ClaudeRawMessage): ParsedEvent['usage'] | null {
    if (!msg.modelUsage && !msg.usage && msg.total_cost_usd === undefined) {
      return null;
    }

    // Use the aggregateModelUsage helper from process-manager
    const aggregated = aggregateModelUsage(
      msg.modelUsage,
      msg.usage || {},
      msg.total_cost_usd || 0
    );

    return {
      inputTokens: aggregated.inputTokens,
      outputTokens: aggregated.outputTokens,
      cacheReadTokens: aggregated.cacheReadInputTokens,
      cacheCreationTokens: aggregated.cacheCreationInputTokens,
      contextWindow: aggregated.contextWindow,
      costUsd: aggregated.totalCostUsd,
    };
  }

  /**
   * Check if an event is a final result message
   */
  isResultMessage(event: ParsedEvent): boolean {
    return event.type === 'result';
  }

  /**
   * Extract session ID from an event
   */
  extractSessionId(event: ParsedEvent): string | null {
    return event.sessionId || null;
  }

  /**
   * Extract usage statistics from an event
   */
  extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
    return event.usage || null;
  }

  /**
   * Extract slash commands from an event
   */
  extractSlashCommands(event: ParsedEvent): string[] | null {
    return event.slashCommands || null;
  }

  /**
   * Detect an error from a line of agent output
   *
   * IMPORTANT: Only detect errors from structured JSON error events, not from
   * arbitrary text content. Pattern matching on conversational text leads to
   * false positives (e.g., AI discussing "timeout" triggers timeout error).
   *
   * Error detection sources (in order of reliability):
   * 1. Structured JSON: { type: "error", message: "..." } or { error: "..." }
   * 2. stderr output (handled separately by process-manager)
   * 3. Non-zero exit code (handled by detectErrorFromExit)
   */
  detectErrorFromLine(line: string): AgentError | null {
    // Skip empty lines
    if (!line.trim()) {
      return null;
    }

    // Only detect errors from structured JSON error events
    // Do NOT pattern match on arbitrary text - it causes false positives
    let errorText: string | null = null;
    try {
      const parsed = JSON.parse(line);
      // Check for error type messages
      // Claude Code uses type: 'error' for some errors and type: 'turn.failed' for others
      if (parsed.type === 'error' && parsed.message) {
        errorText = parsed.message;
      } else if ((parsed.type === 'turn.failed' || parsed.type === 'turn_failed') && parsed.error?.message) {
        // Handle turn.failed/turn_failed format: {"type":"turn.failed","error":{"message":"..."}}
        errorText = parsed.error.message;
      } else if (parsed.error) {
        errorText = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
      }
      // If no error field in JSON, this is normal output - don't check it
    } catch {
      // Not JSON - skip pattern matching entirely
      // Errors should come through structured JSON, stderr, or exit codes
      // Pattern matching on arbitrary text causes false positives
    }

    // If no error text was extracted, no error to detect
    if (!errorText) {
      return null;
    }

    // Match against error patterns
    const patterns = getErrorPatterns(this.agentId);
    const match = matchErrorPattern(patterns, errorText);

    if (match) {
      return {
        type: match.type,
        message: match.message,
        recoverable: match.recoverable,
        agentId: this.agentId,
        timestamp: Date.now(),
        raw: {
          errorLine: line,
        },
      };
    }

    return null;
  }

  /**
   * Detect an error from process exit information
   */
  detectErrorFromExit(
    exitCode: number,
    stderr: string,
    stdout: string
  ): AgentError | null {
    // Exit code 0 is success
    if (exitCode === 0) {
      return null;
    }

    // Check stderr and stdout for error patterns
    const combined = `${stderr}\n${stdout}`;
    const patterns = getErrorPatterns(this.agentId);
    const match = matchErrorPattern(patterns, combined);

    if (match) {
      return {
        type: match.type,
        message: match.message,
        recoverable: match.recoverable,
        agentId: this.agentId,
        timestamp: Date.now(),
        raw: {
          exitCode,
          stderr,
          stdout,
        },
      };
    }

    // Non-zero exit with no recognized pattern - treat as crash
    return {
      type: 'agent_crashed',
      message: `Agent exited with code ${exitCode}`,
      recoverable: true,
      agentId: this.agentId,
      timestamp: Date.now(),
      raw: {
        exitCode,
        stderr,
        stdout,
      },
    };
  }
}
