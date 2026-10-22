/**
 * resumableSession - read a past provider conversation back into the shape a
 * tab is built from.
 *
 * Two callers reopen a conversation that has no tab: `handleResumeSession`
 * (History, the sessions browser, starred sessions), which focuses the tab it
 * makes, and Quick Chat's router, which makes one in the background for a
 * message that belongs in a closed conversation. Both need the same transcript
 * read, the same synopsis-turn stripping, and the same name / starred / context
 * lookup, or a conversation reopened one way would differ from the same one
 * reopened the other. What they do with the result (which tab, focused or not)
 * stays with each caller.
 */

import { FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';
import type { LogEntry, ToolType, UsageStats } from '../types';
import { isSessionIdLabel } from '../utils/tabHelpers';
import {
	TRANSCRIPT_RESUME_READ_LIMIT,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../utils/transcriptMessages';
import { logger } from '../utils/logger';

export interface LoadResumableSessionOptions {
	/** The agent's provider. Decides which transcript store is read. */
	toolType: ToolType | undefined;
	/** Where the provider keeps this agent's conversations (see `resolveSessionProjectPath`). */
	projectRoot: string;
	/** The SSH remote the transcript lives on, when the agent is remote. */
	sshRemoteId?: string;
	agentSessionId: string;
	/** Messages the caller already has. When given, nothing is read from disk. */
	providedMessages?: LogEntry[];
	/** A RECORDED display name (a history entry's pill, a starred label). */
	sessionName?: string;
	starred?: boolean;
	usageStats?: UsageStats;
}

/** Everything `createTab` needs to bring a conversation back. */
export interface ResumableSession {
	origin?: 'user' | 'auto' | 'relay';
	messages: LogEntry[];
	/** Null when the conversation was never named, so the tab can still be auto-named. */
	name: string | null;
	starred: boolean;
	usageStats?: UsageStats;
}

/**
 * Load a conversation for resuming.
 *
 * @returns Null when it has no displayable messages (empty, aged out, or removed
 * from disk). Throws when the transcript cannot be read at all; the caller owns
 * how that is reported.
 */
export async function loadResumableSession(
	options: LoadResumableSessionOptions
): Promise<ResumableSession | null> {
	const { toolType, projectRoot, sshRemoteId, agentSessionId, providedMessages, sessionName } =
		options;

	let messages: LogEntry[];
	if (providedMessages && providedMessages.length > 0) {
		messages = providedMessages;
	} else {
		// Use projectRoot (not cwd) for consistent session storage access, and
		// pass sshRemoteId so SSH-remote sessions read from the correct host.
		const result = await window.maestro.agentSessions.read(
			toolType || 'claude-code',
			projectRoot,
			agentSessionId,
			{ offset: 0, limit: TRANSCRIPT_RESUME_READ_LIMIT },
			sshRemoteId
		);

		// Strip the Auto Run synopsis turns, then convert. Shared with the
		// scroll-to-top backfill (issue #1407), which matches what it reads
		// against these entries to find where to splice older history in -
		// so both paths must build entries the same way.
		messages = transcriptMessagesToLogEntries(
			stripSynopsisTurns(result.messages as TranscriptMessage[])
		);
	}

	if (messages.length === 0) return null;

	let isStarred = options.starred ?? false;
	// A caller's `sessionName` is a RECORDED display name (a history entry's
	// pill, a starred session's label), so an unnamed tab recorded its own id
	// fallback. Writing that back as `tab.name` would look identical while
	// permanently opting the tab out of auto-naming, so drop it and let the
	// tab stay genuinely unnamed.
	let name = sessionName && !isSessionIdLabel(sessionName, agentSessionId) ? sessionName : null;
	let storedContextUsage: number | undefined;
	let usageStats = options.usageStats;

	let origin: ResumableSession['origin'];
	try {
		// Claude and Codex origins share the legacy store; other providers use
		// the generic store. Supplied transcript/name/star fields must not skip provenance.
		const origins =
			!toolType || toolType === 'claude-code' || toolType === 'codex'
				? await window.maestro.claude.getSessionOrigins(projectRoot)
				: await window.maestro.agentSessions.getOrigins(toolType, projectRoot);
		const originData = origins[agentSessionId];
		origin = typeof originData === 'string' ? originData : originData?.origin;
		if (originData && typeof originData === 'object') {
			if (sessionName === undefined && originData.sessionName) name = originData.sessionName;
			if (options.starred === undefined && originData.starred !== undefined)
				isStarred = originData.starred;
			if ('contextUsage' in originData && typeof originData.contextUsage === 'number')
				storedContextUsage = originData.contextUsage;
		}
	} catch (error) {
		logger.warn('[handleResumeSession] Failed to lookup session metadata:', undefined, error);
	}

	// If we have stored contextUsage, set token values to reproduce that percentage
	// The context calculation is: (inputTokens + cacheRead + cacheCreation) / contextWindow * 100
	// So we set inputTokens = contextUsage * contextWindow / 100 to get the correct percentage
	if (storedContextUsage !== undefined && storedContextUsage > 0) {
		const contextWindow = usageStats?.contextWindow || FALLBACK_CONTEXT_WINDOW;
		usageStats = {
			inputTokens: Math.round((storedContextUsage * contextWindow) / 100),
			outputTokens: usageStats?.outputTokens || 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: usageStats?.totalCostUsd || 0,
			contextWindow,
			reasoningTokens: usageStats?.reasoningTokens,
		};
	}

	return { messages, name, starred: isStarred, usageStats, origin };
}
