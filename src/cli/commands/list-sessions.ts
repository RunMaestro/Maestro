// List sessions command
// Lists agent sessions for a given Maestro agent.
// Claude Code: reads rich session data from ~/.claude/projects/ on disk.
// Other agents (Codex, OpenCode, etc.): lists aiTabs from Maestro's session store.
//
// Both paths report the SAME conversation figures. `computeTabConversationStats`
// is the one definition of "how many messages, over how long", shared with the
// Context Details popover and the HTML export, so a number the CLI prints is a
// number the user can find in the app. See `overlayTabConversationStats` for how
// the disk-based Claude path is reconciled with it.

import { resolveAgentId, getSessionById, readSessions } from '../services/storage';
import { listClaudeSessions } from '../services/agent-sessions';
import { formatSessions, formatError, SessionDisplay } from '../output/formatter';
import { computeTabConversationStats } from '../../shared/tabConversationStats';
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
 * An AI tab as it sits in `maestro-sessions.json`.
 *
 * Deliberately loose: this is JSON off disk, not a live `AITab`, so every field
 * is optional and the log entries may be missing a `source` or a `timestamp`.
 */
interface StoredAiTab {
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
}

/** Conversation figures in the shape `SessionDisplay` wants them. */
interface TabSessionStats {
	messageCount: number;
	durationSeconds: number;
}

function readAgentTabs(agentId: string): StoredAiTab[] {
	const agent = readSessions().find((s) => s.id === agentId);
	return ((agent as { aiTabs?: StoredAiTab[] } | undefined)?.aiTabs ?? []) as StoredAiTab[];
}

/**
 * Count one stored tab's conversation with the shared helper.
 *
 * The narrowing is not ceremony: these logs come straight off disk, so an entry
 * missing a source or a timestamp is possible and would otherwise be counted as
 * a message that happened at the epoch.
 */
function statsForTab(tab: StoredAiTab): TabSessionStats {
	const conversation = computeTabConversationStats(
		(tab.logs ?? []).filter(
			(l): l is { text?: string; source: string; timestamp: number } =>
				typeof l.source === 'string' && typeof l.timestamp === 'number'
		)
	);
	return {
		messageCount: conversation.totalMessages,
		durationSeconds: Math.floor(conversation.durationMs / 1000),
	};
}

/**
 * Conversation figures for every session this agent has a tab for, keyed by the
 * provider session id.
 *
 * Tabs with no conversation entries are left OUT rather than mapped to zero: an
 * empty entry here would overwrite a real disk-derived count with `0 msgs`, and
 * a tab that has never been opened in this install is exactly the case where
 * the JSONL on disk is the only record of the conversation.
 */
function indexTabStatsBySessionId(tabs: StoredAiTab[]): Map<string, TabSessionStats> {
	const index = new Map<string, TabSessionStats>();
	for (const tab of tabs) {
		if (!tab.agentSessionId) continue;
		const stats = statsForTab(tab);
		if (stats.messageCount > 0) index.set(tab.agentSessionId, stats);
	}
	return index;
}

/**
 * Replace the disk-derived counts with the tab's own wherever Maestro has the
 * conversation in hand.
 *
 * The Claude path derives its figures by scanning `~/.claude/projects/*.jsonl`,
 * which is the ONLY record for a session Maestro never rendered - a session
 * started in a bare terminal, or one from before this install. But where a tab
 * does exist, its logs are literally what the Context Details popover counts,
 * so preferring them is what makes the CLI and the app agree. The JSONL
 * fallback also counts by regex over the raw file, so a session whose transcript
 * merely CONTAINS the text `"type":"user"` inflates it; the tab has no such
 * failure mode.
 *
 * Applied after `listClaudeSessions` has sorted and paginated, which is safe
 * because it sorts on `modifiedAt` and searches `sessionName` / `firstMessage`.
 * Neither figure below is a sort or a filter key, so overlaying the page the
 * user actually sees cannot reorder or drop a row.
 */
function overlayTabConversationStats(
	sessions: SessionDisplay[],
	tabStats: Map<string, TabSessionStats>
): SessionDisplay[] {
	if (tabStats.size === 0) return sessions;
	return sessions.map((session) => {
		const stats = tabStats.get(session.sessionId);
		return stats ? { ...session, ...stats } : session;
	});
}

/**
 * List sessions from Maestro's aiTabs for non-Claude agents.
 * Reads stored session data (aiTabs with agentSessionId, usage, etc.)
 * and formats it as SessionDisplay entries.
 */
function listTabSessions(
	tabs: StoredAiTab[],
	options: { limit: number; skip: number; search?: string }
): { sessions: SessionDisplay[]; totalCount: number; filteredCount: number } {
	let tabSessions: SessionDisplay[] = tabs
		.filter((tab) => tab.agentSessionId)
		.map((tab) => {
			const logs = tab.logs || [];
			const { messageCount, durationSeconds } = statsForTab(tab);
			const firstStdout = logs.find((l) => l.source === 'stdout');
			const firstMessage = firstStdout?.text?.slice(0, 200) || '';
			const costUsd = tab.usageStats?.totalCostUsd || 0;

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

		// Use disk-based reader for Claude Code, tab-based reader for other agents.
		// Both end up reporting the same conversation figures: the tab reader
		// computes them, and the disk reader has them overlaid where a tab exists.
		let result: { sessions: SessionDisplay[]; totalCount: number; filteredCount: number };
		const tabs = readAgentTabs(agentId);

		if (DISK_SESSION_TYPES.includes(agent.toolType)) {
			const claudeResult = listClaudeSessions(agent.cwd, {
				limit,
				skip,
				search: options.search,
			});
			result = {
				totalCount: claudeResult.totalCount,
				filteredCount: claudeResult.filteredCount,
				sessions: overlayTabConversationStats(
					claudeResult.sessions.map((s) => ({
						sessionId: s.sessionId,
						sessionName: s.sessionName,
						modifiedAt: s.modifiedAt,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						costUsd: s.costUsd,
						durationSeconds: s.durationSeconds,
						starred: s.starred,
					})),
					indexTabStatsBySessionId(tabs)
				),
			};
		} else {
			result = listTabSessions(tabs, { limit, skip, search: options.search });
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
