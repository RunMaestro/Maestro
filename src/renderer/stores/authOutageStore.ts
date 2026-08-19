/**
 * authOutageStore - one re-authentication prompt per PROVIDER, not per agent.
 *
 * Credentials are shared: thirty agents backed by `claude-code` all read one
 * credential store, so an expired token fails all thirty within seconds of each
 * other (plus every Cue pipeline they own). Reporting each failure on its own
 * would bury the user in thirty identical dialogs describing one problem with
 * one fix.
 *
 * This store collapses them. The first blocked agent on a provider opens the
 * prompt; every later one joins the same outage, which is what lets the modal
 * say "31 agents are blocked" instead of appearing 31 times. That roster is not
 * cosmetic - it is the work list for the resume below.
 *
 * On a successful login the outage RESOLVES, and resolving replays the turn each
 * blocked agent died on. Their queued messages were never burned (the execution
 * queue is held while a session is in the error state), so replaying the failed
 * turn lets the ordinary exit-to-dequeue chain drain everything that piled up
 * behind it. The user re-authenticates once and the board picks up where it
 * stopped, with nothing to hunt down by hand.
 */

import { create } from 'zustand';

import { providerAuthKey, type ProviderAuthKey } from '../../shared/providerAuthIdentity';
import { logger } from '../utils/logger';
import { useSessionStore, selectSessionById } from './sessionStore';
import { useAgentStore } from './agentStore';
import { replayAfterAuth } from './retryStore';
import type { Session } from '../types';

// ============================================================================
// Types
// ============================================================================

/** One agent stopped by the outage, and the turns it lost. */
export interface BlockedAgent {
	sessionId: string;
	/**
	 * Tabs whose turn died on this outage, captured AT FAILURE TIME.
	 *
	 * Deliberately not re-derived from `tab.agentError` when the user resumes:
	 * several recovery paths clear the error the moment the user acts on it, so
	 * by resume time the evidence of what failed is gone and nothing would be
	 * replayed. Empty for a Cue pipeline failure, which owns no AI tab.
	 */
	tabIds: string[];
}

export interface AuthOutage {
	/** Identity of the credential store every agent below authenticates against. */
	providerKey: ProviderAuthKey;
	/** Agent id (e.g. `claude-code`) whose credentials expired. */
	toolType: string;
	/** SSH remote whose credential store expired, when the agents run remotely. */
	sshRemoteId?: string;
	/** The provider's own error text from the first failure. */
	message: string;
	/** Epoch ms of the first failure in this outage. */
	startedAt: number;
	/**
	 * Every agent known to be blocked, in the order they failed. The first entry
	 * is the one that raised the prompt.
	 */
	blocked: BlockedAgent[];
	/** True once any blocked agent was a Cue pipeline run, not a chat turn. */
	fromPipeline: boolean;
}

interface AuthOutageState {
	/** Active outages, keyed by {@link ProviderAuthKey}. */
	outages: Record<ProviderAuthKey, AuthOutage>;
	setOutage: (key: ProviderAuthKey, outage: AuthOutage | null) => void;
}

export const useAuthOutageStore = create<AuthOutageState>((set) => ({
	outages: {},
	setOutage: (key, outage) =>
		set((state) => {
			const next = { ...state.outages };
			if (outage) next[key] = outage;
			else delete next[key];
			return { outages: next };
		}),
}));

/** Stagger between resumed agents. See {@link resolveAuthOutage}. */
const RESUME_STAGGER_MS = 250;

// ============================================================================
// Selectors
// ============================================================================

export const selectAuthOutage =
	(key: ProviderAuthKey | null | undefined) => (s: AuthOutageState) =>
		key ? (s.outages[key] ?? null) : null;

/**
 * Resolve the credential store an agent authenticates against.
 *
 * Reads the SSH remote off the session rather than the error payload: the
 * session is the authority on where the agent actually runs, and an agent that
 * failed locally must not be grouped with one that failed on a remote host.
 */
export function providerKeyForSession(
	session: Pick<Session, 'toolType' | 'sshRemoteId' | 'sessionSshRemoteConfig'>
): ProviderAuthKey {
	const sshRemoteId = session.sessionSshRemoteConfig?.enabled
		? session.sessionSshRemoteConfig.remoteId
		: session.sshRemoteId;
	return providerAuthKey(session.toolType, sshRemoteId);
}

// ============================================================================
// Public API
// ============================================================================

export interface ReportAuthFailureParams {
	sessionId: string;
	/** The provider's own error text. Only the first failure's text is kept. */
	message: string;
	/**
	 * The tab whose turn died, when one did. Recorded now because it is what
	 * gets replayed later, and the error state it could be derived from is
	 * cleared as soon as the user acts on the prompt.
	 */
	tabId?: string;
	/** True when a Cue pipeline run hit this rather than an interactive turn. */
	fromPipeline?: boolean;
}

/** Merge a newly blocked tab into an agent roster, without duplicating either. */
function withBlockedTab(
	blocked: BlockedAgent[],
	sessionId: string,
	tabId?: string
): BlockedAgent[] {
	const existing = blocked.find((b) => b.sessionId === sessionId);
	if (!existing) {
		return [...blocked, { sessionId, tabIds: tabId ? [tabId] : [] }];
	}
	if (!tabId || existing.tabIds.includes(tabId)) return blocked;
	// A second tab of the same agent failed on the same outage: both are
	// replayed, since each lost its own turn.
	return blocked.map((b) =>
		b.sessionId === sessionId ? { ...b, tabIds: [...b.tabIds, tabId] } : b
	);
}

/**
 * Record that an agent is blocked on expired credentials.
 *
 * @returns true when this call OPENED a new outage (the caller should show the
 *   prompt), false when it joined an outage that is already on screen. Returns
 *   false for an unknown session - there is nothing to resume and no provider
 *   to name.
 */
export function reportAuthFailure({
	sessionId,
	message,
	tabId,
	fromPipeline,
}: ReportAuthFailureParams): { opened: boolean; providerKey: ProviderAuthKey | null } {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) {
		logger.warn('[auth-outage] Ignoring auth failure for unknown agent', undefined, { sessionId });
		return { opened: false, providerKey: null };
	}

	const key = providerKeyForSession(session);
	const existing = useAuthOutageStore.getState().outages[key];

	if (existing) {
		// Already prompting for this provider. Joining is not a no-op: this agent
		// has to be on the roster or its queued work is never resumed.
		const blocked = withBlockedTab(existing.blocked, sessionId, tabId);
		if (blocked !== existing.blocked) {
			useAuthOutageStore.getState().setOutage(key, {
				...existing,
				blocked,
				fromPipeline: existing.fromPipeline || !!fromPipeline,
			});
			logger.info('[auth-outage] Agent joined an existing provider outage', undefined, {
				providerKey: key,
				sessionId,
				blockedAgents: blocked.length,
			});
		}
		return { opened: false, providerKey: key };
	}

	const sshRemoteId = session.sessionSshRemoteConfig?.enabled
		? session.sessionSshRemoteConfig.remoteId
		: session.sshRemoteId;

	useAuthOutageStore.getState().setOutage(key, {
		providerKey: key,
		toolType: session.toolType,
		sshRemoteId: sshRemoteId ?? undefined,
		message,
		startedAt: Date.now(),
		blocked: withBlockedTab([], sessionId, tabId),
		fromPipeline: !!fromPipeline,
	});
	logger.info('[auth-outage] Provider credentials expired', undefined, {
		providerKey: key,
		sessionId,
		fromPipeline: !!fromPipeline,
	});
	return { opened: true, providerKey: key };
}

/**
 * Close an outage and put every agent it blocked back to work.
 *
 * Each blocked agent has its error cleared (which releases its held execution
 * queue) and the turn it died on replayed. The replayed turn's exit drives the
 * normal dequeue chain, so anything queued behind it runs in order without the
 * user touching it.
 *
 * Resumes are staggered so re-authenticating a provider with thirty agents
 * behind it does not spawn thirty processes in the same tick.
 *
 * @param resume - pass false to dismiss the prompt without restarting anything
 *   (the user closed the dialog rather than completing the login). The agents
 *   keep their error state and their queues, so nothing is lost either way.
 */
export function resolveAuthOutage(key: ProviderAuthKey, resume: boolean = true): void {
	const outage = useAuthOutageStore.getState().outages[key];
	if (!outage) return;

	useAuthOutageStore.getState().setOutage(key, null);

	if (!resume) {
		logger.info('[auth-outage] Prompt dismissed without resuming', undefined, {
			providerKey: key,
			blockedAgents: outage.blocked.length,
		});
		return;
	}

	logger.info('[auth-outage] Resuming agents blocked by the outage', undefined, {
		providerKey: key,
		blockedAgents: outage.blocked.length,
	});

	outage.blocked.forEach(({ sessionId, tabIds }, index) => {
		const start = () => {
			// The agent may have been deleted, or the user may have already dealt
			// with it by hand while the prompt was open.
			if (!selectSessionById(sessionId)(useSessionStore.getState())) return;

			// Releases the held execution queue and drops the error banner. Whatever
			// the user had queued behind the failed turn drains on its own once the
			// replayed turn exits.
			useAgentStore.getState().clearAgentError(sessionId);

			// Only the tabs that actually died are replayed. Every tab has a dispatch
			// snapshot, so replaying indiscriminately would resend turns that already
			// succeeded.
			replayAfterAuth(sessionId, tabIds);
		};

		if (index === 0) start();
		else setTimeout(start, index * RESUME_STAGGER_MS);
	});
}
