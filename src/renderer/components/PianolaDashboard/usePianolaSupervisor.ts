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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type {
	PianolaSupervisorHealth,
	PianolaSupervisedState,
} from '../../../main/pianola/pianola-supervisor';
import type { PianolaSupervisorSnapshot } from '../../../main/ipc/handlers/pianola';

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

/** True when an IPC rejection is the gated 'PianolaDisabled' error (feature off). */
function isPianolaDisabled(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes('PianolaDisabled');
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
	// Mutations (add/remove/setEnabled) are authoritative: each bumps this epoch
	// before and after its IPC call and always applies its returned snapshot. A
	// poll captures the epoch when it starts and applies only if it is unchanged
	// on resolve, so a poll overlapping a mutation can never clobber the newer
	// mutation result with a stale snapshot.
	const mutationEpochRef = useRef(0);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		const epoch = mutationEpochRef.current;
		try {
			const snap = await window.maestro.pianola.supervisor.list();
			if (mountedRef.current && mutationEpochRef.current === epoch) {
				setTargets(snap.targets);
				setHealth(snap.health);
			}
		} catch (err) {
			// Feature turned off -> clear stale watched rows (nothing is watched when
			// Pianola is disabled). A transient IPC error keeps the last snapshot so
			// the list does not flicker; a mutation during the poll wins (epoch moved).
			if (mountedRef.current && mutationEpochRef.current === epoch && isPianolaDisabled(err)) {
				setTargets([]);
				setHealth([]);
			}
		}
	}, []);

	useEffect(() => {
		void load();
		const id = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(id);
	}, [load]);

	const mutate = useCallback(async (op: Promise<PianolaSupervisorSnapshot>): Promise<void> => {
		mutationEpochRef.current += 1; // invalidate polls issued before this mutation
		const snap = await op;
		mutationEpochRef.current += 1; // invalidate polls issued during this mutation
		if (mountedRef.current) {
			setTargets(snap.targets);
			setHealth(snap.health);
		}
	}, []);

	const watch = useCallback(
		(agentId: string, tabId: string) =>
			mutate(
				window.maestro.pianola.supervisor.add({ kind: 'watch', agentId, tabId, enabled: true })
			),
		[mutate]
	);
	const unwatch = useCallback(
		(targetId: string) => mutate(window.maestro.pianola.supervisor.remove(targetId)),
		[mutate]
	);
	const setEnabled = useCallback(
		(targetId: string, enabled: boolean) =>
			mutate(window.maestro.pianola.supervisor.setEnabled(targetId, enabled)),
		[mutate]
	);

	const { watched, watchable } = useMemo(
		() => deriveWatchState(sessions, targets, health),
		[sessions, targets, health]
	);

	const refresh = useCallback(() => void load(), [load]);

	return { watched, watchable, watch, unwatch, setEnabled, refresh };
}
