// List sessions command
// Lists agent sessions for a given Maestro agent.
// Claude Code: reads rich session data from ~/.claude/projects/ on disk.
// Other agents (Codex, OpenCode, etc.): lists aiTabs from Maestro's session store.

import { resolveAgentId, getSessionById, readSessions } from '../services/storage';
import { listClaudeSessions } from '../services/agent-sessions';
import { formatSessions, formatError, SessionDisplay } from '../output/formatter';
import type { ToolType } from '../../shared/types';

interface ListSessionsOptions {
	limit?: string;
	skip?: string;
	search?: string;
	json?: boolean;
}

// Agent types with rich disk-based session listing
const DISK_SESSION_TYPES: ToolType[] = ['claude-code'];

/**
 * List sessions from Maestro's aiTabs for non-Claude agents.
 * Reads stored session data (aiTabs with agentSessionId, usage, etc.)
 * and formats it as SessionDisplay entries.
 */
function listTabSessions(
	agentId: string,
	options: { limit: number; skip: number; search?: string }
): { sessions: SessionDisplay[]; totalCount: number; filteredCount: number } {
	const sessions = readSessions();
	const agent = sessions.find((s) => s.id === agentId);
	if (!agent) {
		return { sessions: [], totalCount: 0, filteredCount: 0 };
	}

	const aiTabs = (agent as any).aiTabs as
		| Array<{
				id: string;
				agentSessionId?: string;
				name?: string;
				starred?: boolean;
				createdAt?: number;
				usageStats?: {
					totalCostUsd?: number;
					inputTokens?: number;
					outputTokens?: number;
				};
				logs?: Array<{ text?: string; source?: string; timestamp?: number }>;
				state?: string;
		  }>
		| undefined;

	if (!aiTabs || aiTabs.length === 0) {
		return { sessions: [], totalCount: 0, filteredCount: 0 };
	}

	let tabSessions: SessionDisplay[] = aiTabs
		.filter((tab) => tab.agentSessionId)
		.map((tab) => {
			const logs = tab.logs || [];
			const messageCount = logs.filter((l) => l.source === 'stdout' || l.source === 'stdin').length;
			const firstStdout = logs.find((l) => l.source === 'stdout');
			const firstMessage = firstStdout?.text?.slice(0, 200) || '';
			const costUsd = tab.usageStats?.totalCostUsd || 0;

			let durationSeconds = 0;
			if (logs.length >= 2) {
				const first = logs[0]?.timestamp;
				const last = logs[logs.length - 1]?.timestamp;
				if (first && last) {
					durationSeconds = Math.max(0, Math.floor((last - first) / 1000));
				}
			}

			const modifiedAt =
				logs.length > 0 && logs[logs.length - 1]?.timestamp
					? new Date(logs[logs.length - 1].timestamp!).toISOString()
					: tab.createdAt
						? new Date(tab.createdAt).toISOString()
						: new Date().toISOString();

			return {
				sessionId: tab.agentSessionId!,
				sessionName: tab.name,
				modifiedAt,
				firstMessage,
				messageCount,
				costUsd,
				durationSeconds,
				starred: tab.starred,
			};
		});

	tabSessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

	const totalCount = tabSessions.length;

	if (options.search) {
		const searchLower = options.search.toLowerCase();
		tabSessions = tabSessions.filter((s) => {
			if (s.sessionName?.toLowerCase().includes(searchLower)) return true;
			if (s.firstMessage.toLowerCase().includes(searchLower)) return true;
			return false;
		});
	}

	const filteredCount = tabSessions.length;
	const paginated = tabSessions.slice(options.skip, options.skip + options.limit);

	return { sessions: paginated, totalCount, filteredCount };
}

export function listSessions(agentIdArg: string, options: ListSessionsOptions): void {
	try {
		const agentId = resolveAgentId(agentIdArg);
		const agent = getSessionById(agentId);

		if (!agent) {
			if (options.json) {
				console.log(
					JSON.stringify(
						{ success: false, error: `Agent not found: ${agentIdArg}`, code: 'AGENT_NOT_FOUND' },
						null,
						2
					)
				);
			} else {
				console.error(formatError(`Agent not found: ${agentIdArg}`));
			}
			process.exit(1);
		}

		const limit = options.limit ? parseInt(options.limit, 10) : 25;
		if (isNaN(limit) || limit < 1) {
			const msg = 'Invalid limit value. Must be a positive integer.';
			if (options.json) {
				console.log(
					JSON.stringify({ success: false, error: msg, code: 'INVALID_OPTION' }, null, 2)
				);
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}

		const skip = options.skip ? parseInt(options.skip, 10) : 0;
		if (isNaN(skip) || skip < 0) {
			const msg = 'Invalid skip value. Must be a non-negative integer.';
			if (options.json) {
				console.log(
					JSON.stringify({ success: false, error: msg, code: 'INVALID_OPTION' }, null, 2)
				);
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}

		// Use disk-based reader for Claude Code, tab-based reader for other agents
		let result: { sessions: SessionDisplay[]; totalCount: number; filteredCount: number };

		if (DISK_SESSION_TYPES.includes(agent.toolType)) {
			const claudeResult = listClaudeSessions(agent.cwd, {
				limit,
				skip,
				search: options.search,
			});
			result = {
				totalCount: claudeResult.totalCount,
				filteredCount: claudeResult.filteredCount,
				sessions: claudeResult.sessions.map((s) => ({
					sessionId: s.sessionId,
					sessionName: s.sessionName,
					modifiedAt: s.modifiedAt,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					costUsd: s.costUsd,
					durationSeconds: s.durationSeconds,
					starred: s.starred,
				})),
			};
		} else {
			result = listTabSessions(agentId, { limit, skip, search: options.search });
		}

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						agentId,
						agentName: agent.name,
						totalCount: result.totalCount,
						filteredCount: result.filteredCount,
						sessions: result.sessions,
					},
					null,
					2
				)
			);
		} else {
			console.log(
				formatSessions(
					result.sessions,
					agent.name,
					result.totalCount,
					result.filteredCount,
					options.search
				)
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.log(
				JSON.stringify({ success: false, error: message, code: 'UNKNOWN_ERROR' }, null, 2)
			);
		} else {
			console.error(formatError(`Failed to list sessions: ${message}`));
		}
		process.exit(1);
	}
}
