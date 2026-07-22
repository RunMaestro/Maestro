/**
 * Pianola supervisor (watch) state for the dashboard.
 *
 * The desktop `PianolaSupervisor` daemon keeps a "watch" child alive per
 * supervised (tab, agent). The same registry is what `maestro-cli pianola
 * supervise watch ...` writes; this hook is the in-app way to add/remove those
 * watches from the Pianola Dashboard instead of the CLI.
 *
 * Pure derivation lives in `deriveWatchState` (testable without IPC); the hook
 * adds the session-store subscription, the polled `supervisor.list()` fetch, and
 * the add/remove/toggle actions. Every channel rejects with 'PianolaDisabled'
 * when the Encore flag is off, which we treat as "nothing watched".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type {
	PianolaSupervisorHealth,
	PianolaSupervisedState,
} from '../../../main/pianola/pianola-supervisor';

/** A currently-watched agent, with live daemon health when a child is running. */
export interface WatchedAgentRow {
	/** Supervisor target id, for setEnabled/remove. */
	targetId: string;
	agentId: string;
	agentName: string;
	enabled: boolean;
	/** Live child state, when the daemon currently has one for this target. */
	state?: PianolaSupervisedState;
	lastError?: string;
}

/** An agent that can be watched: not Pianola, not already watched, has an AI tab. */
export interface WatchableAgent {
	agentId: string;
	/** The AI tab the watch will babysit (active AI tab, else the first). */
	tabId: string;
	agentName: string;
}

/** Short id fallback for an agent whose session is no longer loaded. */
function shortId(id: string): string {
	return id.slice(0, 6);
}

/** The AI tab a watch should target: the active tab when it's an AI tab, else the first. */
function watchableTabId(session: Session): string | undefined {
	const aiTabIds = new Set(session.aiTabs.map((t) => t.id));
	if (session.activeTabId && aiTabIds.has(session.activeTabId)) return session.activeTabId;
	return session.aiTabs[0]?.id;
}

/**
 * Pure derivation of the watch UI state from live sessions + the supervisor
 * snapshot. `watched` lists existing watch targets (enriched with name + live
 * health); `watchable` lists top-level, non-Pianola agents that have an AI tab
 * and are not already watched, ready for the "+ Watch an agent" picker.
 */
export function deriveWatchState(
	sessions: readonly Session[],
	targets: readonly PianolaSupervisedTarget[],
	health: readonly PianolaSupervisorHealth[]
): { watched: WatchedAgentRow[]; watchable: WatchableAgent[] } {
	const nameById = new Map(sessions.map((s) => [s.id, s.name] as const));
	const healthById = new Map(health.map((h) => [h.id, h] as const));

	const watchTargets = targets.filter(
		(t) => t.kind === 'watch' && typeof t.agentId === 'string' && t.agentId.length > 0
	);
	const watched: WatchedAgentRow[] = watchTargets.map((t) => {
		const agentId = t.agentId as string;
		const h = healthById.get(t.id);
		return {
			targetId: t.id,
			agentId,
			agentName: nameById.get(agentId) ?? shortId(agentId),
			enabled: t.enabled,
			...(h ? { state: h.state } : {}),
			...(h?.lastError ? { lastError: h.lastError } : {}),
		};
	});

	const watchedAgentIds = new Set(watchTargets.map((t) => t.agentId));
	const watchable: WatchableAgent[] = [];
	for (const s of sessions) {
		if (s.isPianola || s.parentSessionId || watchedAgentIds.has(s.id)) continue;
		const tabId = watchableTabId(s);
		if (!tabId) continue; // no AI tab -> nothing to babysit
		watchable.push({ agentId: s.id, tabId, agentName: s.name });
	}

	return { watched, watchable };
}

const POLL_MS = 4000;

export interface PianolaSupervisorState {
	watched: WatchedAgentRow[];
	watchable: WatchableAgent[];
	watch: (agentId: string, tabId: string) => Promise<void>;
	unwatch: (targetId: string) => Promise<void>;
	setEnabled: (targetId: string, enabled: boolean) => Promise<void>;
	refresh: () => void;
}

/**
 * Live watch state. Subscribes to the session store and polls the supervisor
 * registry; the mutators write through `window.maestro.pianola.supervisor` and
 * apply the returned snapshot immediately so the UI updates without waiting for
 * the next poll.
 */
export function usePianolaSupervisor(): PianolaSupervisorState {
	const sessions = useSessionStore((s) => s.sessions);
	const [targets, setTargets] = useState<PianolaSupervisedTarget[]>([]);
	const [health, setHealth] = useState<PianolaSupervisorHealth[]>([]);
	const [nonce, setNonce] = useState(0);

	const refresh = useCallback(() => setNonce((n) => n + 1), []);

	useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			try {
				const snap = await window.maestro.pianola.supervisor.list();
				if (!cancelled) {
					setTargets(snap.targets);
					setHealth(snap.health);
				}
			} catch {
				// 'PianolaDisabled' or transient IPC error: leave the last snapshot.
			}
		};
		void tick();
		const id = setInterval(tick, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [nonce]);

	const { watched, watchable } = useMemo(
		() => deriveWatchState(sessions, targets, health),
		[sessions, targets, health]
	);

	const watch = useCallback(async (agentId: string, tabId: string) => {
		const snap = await window.maestro.pianola.supervisor.add({
			kind: 'watch',
			agentId,
			tabId,
			enabled: true,
		});
		setTargets(snap.targets);
		setHealth(snap.health);
	}, []);

	const unwatch = useCallback(async (targetId: string) => {
		const snap = await window.maestro.pianola.supervisor.remove(targetId);
		setTargets(snap.targets);
		setHealth(snap.health);
	}, []);

	const setEnabled = useCallback(async (targetId: string, enabled: boolean) => {
		const snap = await window.maestro.pianola.supervisor.setEnabled(targetId, enabled);
		setTargets(snap.targets);
		setHealth(snap.health);
	}, []);

	return { watched, watchable, watch, unwatch, setEnabled, refresh };
}
