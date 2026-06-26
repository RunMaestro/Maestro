/**
 * Qwen Code Output Parser
 *
 * Parses stream-json output from the Qwen Code CLI (`qwen`).
 *
 * Qwen Code is a fork of Gemini CLI and emits the same stream-json schema that
 * Claude Code does (`type: system/assistant/result`), so parsing reuses the
 * ClaudeOutputParser implementation wholesale. The only difference is the
 * agentId, which is overridden so the registry and error-pattern lookups key
 * off 'qwen3-coder'.
 *
 * Note: Qwen's session init message uses subtype 'session_start' rather than
 * Claude's 'init'. The generic system branch in ClaudeOutputParser still
 * surfaces session_id on those events, and the final `result` event also
 * carries session_id, so session capture works without a custom override.
 *
 * @see https://github.com/QwenLM/qwen-code
 */

import { ClaudeOutputParser } from './claude-output-parser';
import type { ToolType } from '../../shared/types';

/**
 * Qwen Code Output Parser Implementation
 *
 * Subclasses ClaudeOutputParser to reuse its stream-json handling while
 * identifying as the 'qwen3-coder' agent.
 */
export class QwenOutputParser extends ClaudeOutputParser {
	readonly agentId: ToolType = 'qwen3-coder';
}
