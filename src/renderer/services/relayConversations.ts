import { canonicalJson } from '../../shared/canonicalJson';
import type { Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useHeadlessActivityStore } from '../stores/headlessActivityStore';
import { canArchiveRelayConversation } from '../../shared/relayConversation';

/** Lifecycle updates preserve local runtime by default. Relay is host-owned and
 * has no renderer process exit event, so its explicit state transitions settle here.
 */
export function applyRelayConversationRuntime(session: Session, baseline?: Session): Session {
	let changed = false;
	const aiTabs = session.aiTabs.map((tab) => {
		const relay = tab.relayConversation;
		const before = baseline?.aiTabs.find((t) => t.id === tab.id)?.relayConversation;
		if (!relay?.messageId || (baseline && canonicalJson(before ?? null) === canonicalJson(relay)))
			return tab;
		changed = true;
		return {
			...tab,
			state:
				relay.status === 'running' || relay.status === 'queued'
					? ('busy' as const)
					: ('idle' as const),
			thinkingStartTime: relay.status === 'running' ? relay.lastActivityAt : undefined,
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
	return changed ? { ...session, aiTabs } : session;
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
		for (const session of state.sessions) {
			if (!owns(session.id)) continue;
			const before = previous.sessions.find((s) => s.id === session.id);
			if (!before || before.aiTabs === session.aiTabs) continue;
			for (const tab of session.aiTabs) {
				const relay = tab.relayConversation;
				const old = before.aiTabs.find((t) => t.id === tab.id);
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
