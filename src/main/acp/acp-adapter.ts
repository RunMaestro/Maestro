/**
 * ACP to ParsedEvent Adapter
 *
 * Converts ACP session updates to Maestro's internal ParsedEvent format,
 * enabling seamless integration with existing UI components.
 */

import type { ParsedEvent } from '../parsers/agent-output-parser';
import type {
  SessionUpdate,
  SessionId,
  ContentBlock,
  ToolCallStatus,
} from './types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[ACPAdapter]';

/**
 * Extract text from a ContentBlock
 * Handles both ACP spec format and OpenCode's actual format:
 * - ACP spec: { text: { text: '...' } }
 * - OpenCode: { type: 'text', text: '...' }
 */
function extractText(block: ContentBlock): string {
  const content = block as any;
  
  logger.debug('Extracting text from content block', LOG_CONTEXT, { content });
  
  // OpenCode format: { type: 'text', text: '...' }
  if (content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  
  // ACP spec format: { text: { text: '...' } }
  if ('text' in content && content.text && typeof content.text === 'object' && 'text' in content.text) {
    return content.text.text;
  }
  
  // Simple text field
  if ('text' in content && typeof content.text === 'string') {
    return content.text;
  }
  
  // Direct string content
  if (typeof content === 'string') {
    return content;
  }
  
  if ('image' in content) {
    return '[image]';
  }
  if ('resource_link' in content) {
    return `[resource: ${content.resource_link.name}]`;
  }
  if ('resource' in content) {
    const res = content.resource.resource;
    if ('text' in res) {
      return res.text;
    }
    return '[binary resource]';
  }
  
  // Fallback: try to stringify
  logger.warn('Unknown content block format', LOG_CONTEXT, { content });
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

/**
 * Map ACP ToolCallStatus to Maestro status
 */
function mapToolStatus(status?: ToolCallStatus): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    default:
      return 'pending';
  }
}

/**
 * Convert an ACP SessionUpdate to a Maestro ParsedEvent
 */
export function acpUpdateToParseEvent(
  sessionId: SessionId,
  update: SessionUpdate
): ParsedEvent | null {
  logger.debug('Converting ACP update to ParsedEvent', LOG_CONTEXT, { 
    sessionId, 
    updateKeys: Object.keys(update),
    update 
  });
  
  // Agent message chunk (streaming text)
  if ('agent_message_chunk' in update) {
    const chunk = update.agent_message_chunk;
    logger.debug('Processing agent_message_chunk', LOG_CONTEXT, { chunk });
    const text = extractText(chunk.content);
    return {
      type: 'text',
      text,
      isPartial: true,
      sessionId,
      raw: update,
    };
  }

  // Agent thought chunk (thinking/reasoning) - map to 'text' type with marker
  if ('agent_thought_chunk' in update) {
    const text = extractText(update.agent_thought_chunk.content);
    return {
      type: 'text',
      text: `[thinking] ${text}`,
      isPartial: true,
      sessionId,
      raw: update,
    };
  }

  // User message chunk (echo of user input)
  if ('user_message_chunk' in update) {
    // Usually not displayed, but can be used for confirmation
    return null;
  }

  // Tool call started
  if ('tool_call' in update) {
    const tc = update.tool_call;
    return {
      type: 'tool_use',
      toolName: tc.title,
      toolState: {
        id: tc.toolCallId,
        input: tc.rawInput,
        status: mapToolStatus(tc.status),
      },
      sessionId,
      raw: update,
    };
  }

  // Tool call update
  if ('tool_call_update' in update) {
    const tc = update.tool_call_update;
    return {
      type: 'tool_use',
      toolName: tc.title || '',
      toolState: {
        id: tc.toolCallId,
        input: tc.rawInput,
        output: tc.rawOutput,
        status: mapToolStatus(tc.status),
      },
      sessionId,
      raw: update,
    };
  }

  // Plan update - map to system message
  if ('plan' in update) {
    const entries = update.plan.entries.map((e) => `- [${e.status}] ${e.content}`).join('\n');
    return {
      type: 'system',
      text: `Plan:\n${entries}`,
      sessionId,
      raw: update,
    };
  }

  // Available commands update
  if ('available_commands_update' in update) {
    // Map to slash commands for UI
    return {
      type: 'init',
      slashCommands: update.available_commands_update.availableCommands.map((c) => c.name),
      sessionId,
      raw: update,
    };
  }

  // Mode update
  if ('current_mode_update' in update) {
    // Could emit a mode change event
    return null;
  }

  return null;
}

/**
 * Create an init event from ACP session creation
 */
export function createSessionIdEvent(sessionId: SessionId): ParsedEvent {
  return {
    type: 'init',
    sessionId,
    raw: { type: 'session_created', sessionId },
  };
}

/**
 * Create a result event from ACP prompt response
 */
export function createResultEvent(
  sessionId: SessionId,
  text: string,
  _stopReason: string,
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
): ParsedEvent {
  // Convert ACP usage format to Maestro's ParsedEvent usage format
  const eventUsage = usage ? {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    // ACP doesn't provide cache tokens, so default to 0
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    // ACP doesn't provide cost, calculated separately based on model
    costUsd: 0,
    // Context window should be configured in agent settings
    contextWindow: 0,
  } : undefined;

  return {
    type: 'result',
    text,
    sessionId,
    usage: eventUsage,
    raw: { type: 'prompt_response', stopReason: _stopReason, usage },
  };
}

/**
 * Create an error event
 */
export function createErrorEvent(sessionId: SessionId, message: string): ParsedEvent {
  return {
    type: 'error',
    text: message,
    sessionId,
    raw: { type: 'error', message },
  };
}
