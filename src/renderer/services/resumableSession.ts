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
import { canonicalJson } from '../../shared/canonicalJson';
import {
	matchesNativeSessionBinding,
	type NativeSessionBinding,
} from '../../shared/maestro-lib/agents/providerSwap';
import type { LogEntry, Session, ToolType, UsageStats } from '../types';
import { isSessionIdLabel } from '../utils/tabHelpers';
import {
	TRANSCRIPT_RESUME_READ_LIMIT,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../utils/transcriptMessages';
import { logger } from '../utils/logger';

export { matchesNativeSessionBinding } from '../../shared/maestro-lib/agents/providerSwap';

export interface LoadResumableSessionOptions {
	/** Maestro owner whose selected account/host the main process must resolve. */
	ownerAgentId?: string;
	/** Ownership retained by the selected history record, never inferred from its ID. */
	nativeSessionBinding?: NativeSessionBinding;
	/** The agent's provider. Decides which transcript store is read. */
	toolType: ToolType | undefined;
	/** Where the provider keeps this agent's conversations (see `resolveSessionProjectPath`). */
	projectRoot: string;
	/** The SSH remote the transcript lives on, when the agent is remote. */
	sshRemoteId?: string;
	agentSessionId: string;
	/** Retained display messages. Grok still requires a scoped native read. */
	providedMessages?: LogEntry[];
	/** A RECORDED display name (a history entry's pill, a starred label). */
	sessionName?: string;
	starred?: boolean;
	usageStats?: UsageStats;
}

/** Everything `createTab` needs to bring a conversation back. */
export interface ResumableSession {
	nativeSessionBinding?: NativeSessionBinding;
	origin?: 'user' | 'auto' | 'relay';
	messages: LogEntry[];
	/** Null when the conversation was never named, so the tab can still be auto-named. */
	name: string | null;
	starred: boolean;
	usageStats?: UsageStats;
}

/** Expected refusal: callers must preserve history and must not start a new conversation. */
export class SessionResumeRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SessionResumeRefusedError';
	}
}

/** An in-memory selection fence, not an account identity. Never log or persist it. */
export function resumeSelectionKey(session: Session): string {
	return canonicalJson({
		id: session.id,
		provider: session.toolType,
		cwd: session.cwd,
		projectRoot: session.projectRoot,
		remoteCwd: session.remoteCwd,
		sshRemoteId: session.sshRemoteId,
		ssh: session.sessionSshRemoteConfig,
		customPath: session.customPath,
		customArgs: session.customArgs,
		customEnvVars: session.customEnvVars,
	});
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
	const binding =
		options.nativeSessionBinding === undefined
			? undefined
			: structuredClone(options.nativeSessionBinding);
	if (
		binding !== undefined &&
		(binding?.state !== 'bound' ||
			!matchesNativeSessionBinding(binding, binding) ||
			binding.provider !== toolType ||
			binding.nativeSessionId !== agentSessionId)
	) {
		throw new SessionResumeRefusedError(
			'The selected history has unknown or mismatched ownership.'
		);
	}
	if (toolType === 'grok' && !options.ownerAgentId) {
		throw new SessionResumeRefusedError(
			'Select the owning Grok agent before reopening its history.'
		);
	}
	if (toolType === 'grok' && !binding) {
		throw new SessionResumeRefusedError(
			'Grok history ownership is unknown. Select a verified native history record first.'
		);
	}

	let messages: LogEntry[];
	if (toolType !== 'grok' && providedMessages && providedMessages.length > 0) {
		messages = providedMessages;
	} else {
		// Use projectRoot (not cwd) for consistent session storage access, and
		// pass sshRemoteId so SSH-remote sessions read from the correct host.
		const result = await window.maestro.agentSessions.read(
			toolType || 'claude-code',
			projectRoot,
			agentSessionId,
			{
				offset: 0,
				limit: TRANSCRIPT_RESUME_READ_LIMIT,
				...(options.ownerAgentId === undefined ? {} : { ownerAgentId: options.ownerAgentId }),
				...(toolType === 'grok' && binding
					? { nativeSessionBinding: structuredClone(binding) }
					: {}),
			},
			sshRemoteId
		);
		if (toolType === 'grok') {
			if (result.source?.provider !== 'grok' || result.source.status !== 'available') {
				throw new SessionResumeRefusedError(
					'Grok history is unavailable or incomplete. Retained history was kept.'
				);
			}
			if (!matchesNativeSessionBinding(binding, result.nativeSessionBinding)) {
				throw new SessionResumeRefusedError(
					'Grok history ownership could not be verified. Retained history was kept.'
				);
			}
		}

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
	if (toolType === 'grok') {
		// Only the selected record's metadata is scoped by the validated binding.
		// The origins store is keyed by ID/project, so another account can own it.
		return { messages, name, starred: isStarred, usageStats, nativeSessionBinding: binding };
	}

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

	return { messages, name, starred: isStarred, usageStats, origin, nativeSessionBinding: binding };
}
