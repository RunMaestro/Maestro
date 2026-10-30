import { canonicalJson } from '../../shared/canonicalJson';
import type { AITab, Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useHeadlessActivityStore } from '../stores/headlessActivityStore';
import { canArchiveRelayConversation } from '../../shared/relayConversation';

/** Persisted native status alone does not prove that a Host turn survived.
 * Live lifecycle updates and browser reattachment retain their normal projection.
 */
export function deriveRelayConversationRuntime(
	relay: AITab['relayConversation'],
	source: 'live' | 'persisted' = 'live'
): Pick<AITab, 'state' | 'thinkingStartTime'> {
	const active = source === 'live' && (relay?.status === 'running' || relay?.status === 'queued');
	return {
		state: active ? 'busy' : 'idle',
		thinkingStartTime: active && relay?.status === 'running' ? relay.lastActivityAt : undefined,
	};
}

/** Lifecycle updates preserve local runtime by default. Relay is host-owned and
 * has no renderer process exit event, so its explicit state transitions settle here.
 */
export function applyRelayConversationRuntime(
	session: Session,
	baseline?: Session,
	source: 'live' | 'persisted' = 'live'
): Session {
	let changed = false;
	const aiTabs = session.aiTabs.map((tab) => {
		const relay = tab.relayConversation;
		const before = baseline?.aiTabs.find((t) => t.id === tab.id)?.relayConversation;
		if (
			!relay?.messageId ||
			(source === 'live' && baseline && canonicalJson(before ?? null) === canonicalJson(relay))
		)
			return tab;
		changed = true;
		return {
			...tab,
			...deriveRelayConversationRuntime(relay, source),
			agentError:
				relay.status === 'error'
					? {
							type: 'unknown' as const,
							message: relay.error ?? 'Relay execution failed',
							recoverable: false,
							agentId: session.toolType,
							timestamp: relay.lastActivityAt,
						}
					: undefined,
		};
	});
	if (!changed) return session;
	// Live reattachment marks a Host-only turn busy with PID 0. Unlike desktop
	// processes it has no process:exit event to clear that parent runtime.
	// Settle only that AI state, and never hide work on another tab or terminal.
	const settleParent =
		session.state === 'busy' &&
		session.busySource === 'ai' &&
		session.aiPid === 0 &&
		![...aiTabs, ...(session.orphanedThinkingTabs ?? [])].some((tab) => tab.state === 'busy');
	return {
		...session,
		aiTabs,
		...(settleParent && {
			state: 'idle' as const,
			busySource: undefined,
			thinkingStartTime: undefined,
		}),
	};
}

/** Owner-side conservative sweep; hiding retains the real tab and its transcript.
 * History/Resume and a later transport message reveal it again with the same identity.
 */
export function sweepRelayConversations(
	now = Date.now(),
	owns: (agentId: string) => boolean = () => true
): void {
	const { sessions, initialLoadComplete } = useSessionStore.getState();
	if (!initialLoadComplete) return;
	const hours = useSettingsStore.getState().relayArchiveHours;
	for (const session of sessions) {
		if (!owns(session.id)) continue;
		const busy =
			session.state === 'busy' ||
			session.bookmarked === true ||
			(useHeadlessActivityStore.getState().counts[session.id] ?? 0) > 0 ||
			!!session.tabGroups?.length ||
			!!session.batchRunnerPrompt;
		const ids = new Set(
			session.aiTabs
				.filter((tab) =>
					canArchiveRelayConversation(tab, {
						now,
						hours,
						busy,
						// Protect the saved selection too, including agents owned by another window.
						selected: session.activeTabId === tab.id,
						queued: session.executionQueue.some((item) => !item.tabId || item.tabId === tab.id),
					})
				)
				.map((tab) => tab.id)
		);
		if (!ids.size) continue;
		updateSessionWith(session.id, (current) => ({
			...current,
			aiTabs: current.aiTabs.map((tab) =>
				ids.has(tab.id) && tab.relayConversation
					? {
							...tab,
							hidden: true,
							relayConversation: { ...tab.relayConversation, archivedAt: now },
						}
					: tab
			),
		}));
	}
}

export function subscribeRelayConversations(
	owns: (agentId: string) => boolean = () => true
): () => void {
	const unsubscribe = useSessionStore.subscribe((state, previous) => {
		if (state.sessions === previous.sessions) return;
		const previousSessions = new Map(previous.sessions.map((session) => [session.id, session]));
		for (const session of state.sessions) {
			if (!owns(session.id)) continue;
			const before = previousSessions.get(session.id);
			if (!before || before.aiTabs === session.aiTabs) continue;
			const previousTabs = new Map(before.aiTabs.map((tab) => [tab.id, tab]));
			for (const tab of session.aiTabs) {
				const relay = tab.relayConversation;
				const old = previousTabs.get(tab.id);
				if (
					!relay ||
					!old ||
					relay.messageId !== old.relayConversation?.messageId ||
					old.logs === tab.logs
				)
					continue;
				const previousIds = new Set(old.logs.map((entry) => entry.id));
				const tail = old.logs.at(-1);
				const tailIndex = tail ? tab.logs.findIndex((entry) => entry.id === tail.id) : -1;
				// Backfill prepends history; a replaced history window is not a submitted turn.
				if (tail && tailIndex < 0) continue;
				const newUserInput = tab.logs
					.slice(tailIndex + 1)
					.some(
						(log) =>
							log.source === 'user' &&
							!previousIds.has(log.id) &&
							log.timestamp >= Math.max(tail?.timestamp ?? 0, relay.lastActivityAt)
					);
				if (!newUserInput) continue;
				updateSessionWith(session.id, (current) => ({
					...current,
					aiTabs: current.aiTabs.map((t) =>
						t.id === tab.id && t.relayConversation
							? {
									...t,
									hidden: false,
									relayConversation: {
										...t.relayConversation,
										completedAt: undefined,
										archivedAt: undefined,
										lastActivityAt: Date.now(),
									},
								}
							: t
					),
				}));
			}
		}
	});
	const timer = setInterval(() => sweepRelayConversations(Date.now(), owns), 60_000);
	return () => {
		clearInterval(timer);
		unsubscribe();
	};
}
