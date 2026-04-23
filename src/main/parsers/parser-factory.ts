/**
 * Output Parser Factory
 *
 * Creates fresh parser instances per-process to avoid shared mutable state.
 * Parsers like CopilotOutputParser and CodexOutputParser track tool names
 * on the instance; sharing a singleton across concurrent sessions causes
 * cross-session state leakage.
 *
 * Use createOutputParser() when assigning a parser to a ManagedProcess.
 * Use getOutputParser() only for capability checks or read-only queries.
 */

import type { ToolType } from '../../shared/types';
import type { AgentOutputParser } from './agent-output-parser';
import { ClaudeOutputParser } from './claude-output-parser';
import { OpenCodeOutputParser } from './opencode-output-parser';
import { CodexOutputParser } from './codex-output-parser';
import { FactoryDroidOutputParser } from './factory-droid-output-parser';
import { CopilotOutputParser } from './copilot-output-parser';

const PARSER_CONSTRUCTORS: Record<string, () => AgentOutputParser> = {
	'claude-code': () => new ClaudeOutputParser(),
	opencode: () => new OpenCodeOutputParser(),
	codex: () => new CodexOutputParser(),
	'factory-droid': () => new FactoryDroidOutputParser(),
	copilot: () => new CopilotOutputParser(),
};

/**
 * Create a fresh output parser instance for a given agent type.
 * Each call returns a new instance so per-process mutable state
 * (e.g., tool name tracking) is session-isolated.
 */
export function createOutputParser(agentId: ToolType | string): AgentOutputParser | null {
	const factory = PARSER_CONSTRUCTORS[agentId];
	return factory ? factory() : null;
}
