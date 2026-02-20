// List sessions command
// Lists agent sessions (Claude Code) for a given Maestro agent

import { resolveAgentId, getSessionById } from '../services/storage';
import { listClaudeSessions } from '../services/agent-sessions';
import { formatSessions, formatError, SessionDisplay } from '../output/formatter';
import type { ToolType } from '../../shared/types';

interface ListSessionsOptions {
	limit?: string;
	skip?: string;
	search?: string;
	json?: boolean;
}

const SUPPORTED_TYPES: ToolType[] = ['claude-code', 'gemini-cli'];

export function listSessions(agentIdArg: string, options: ListSessionsOptions): void {
	try {
		// Resolve agent ID (supports partial IDs)
		const agentId = resolveAgentId(agentIdArg);
		const agent = getSessionById(agentId);

		if (!agent) {
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: `Agent not found: ${agentIdArg}`, code: 'AGENT_NOT_FOUND' }, null, 2));
			} else {
				console.error(formatError(`Agent not found: ${agentIdArg}`));
			}
			process.exit(1);
		}

		if (!SUPPORTED_TYPES.includes(agent.toolType)) {
			const msg = `Session listing is not supported for agent type "${agent.toolType}". Supported: ${SUPPORTED_TYPES.join(', ')}`;
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg, code: 'AGENT_UNSUPPORTED' }, null, 2));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}

		const limit = options.limit ? parseInt(options.limit, 10) : 25;
		if (isNaN(limit) || limit < 1) {
			const msg = 'Invalid limit value. Must be a positive integer.';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg, code: 'INVALID_OPTION' }, null, 2));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}

		const skip = options.skip ? parseInt(options.skip, 10) : 0;
		if (isNaN(skip) || skip < 0) {
			const msg = 'Invalid skip value. Must be a non-negative integer.';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg, code: 'INVALID_OPTION' }, null, 2));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}

		const projectPath = agent.cwd;
		const result = listClaudeSessions(projectPath, {
			limit,
			skip,
			search: options.search,
		});

		if (options.json) {
			console.log(JSON.stringify({
				success: true,
				agentId,
				agentName: agent.name,
				totalCount: result.totalCount,
				filteredCount: result.filteredCount,
				sessions: result.sessions,
			}, null, 2));
		} else {
			const displaySessions: SessionDisplay[] = result.sessions.map((s) => ({
				sessionId: s.sessionId,
				sessionName: s.sessionName,
				modifiedAt: s.modifiedAt,
				firstMessage: s.firstMessage,
				messageCount: s.messageCount,
				costUsd: s.costUsd,
				durationSeconds: s.durationSeconds,
				starred: s.starred,
			}));
			console.log(formatSessions(displaySessions, agent.name, result.totalCount, result.filteredCount, options.search));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message, code: 'UNKNOWN_ERROR' }, null, 2));
		} else {
			console.error(formatError(`Failed to list sessions: ${message}`));
		}
		process.exit(1);
	}
}
