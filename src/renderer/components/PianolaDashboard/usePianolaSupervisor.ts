/**
 * Pianola supervisor (watch) state for the dashboard.
 *
 * The desktop supervisor maintains scope workers and legacy tab watches in the
 * shared registry. The dashboard edits scopes and shows the legacy watches.
 *
 * Pure derivation lives in `deriveWatchState` (testable without IPC); the hook
 * adds the session-store subscription, the polled `supervisor.list()` fetch, and
 * the add/remove/toggle actions. Every channel rejects with 'PianolaDisabled'
 * when the Encore flag is off, which we treat as "nothing watched".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Session } from '../../types';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type {
	PianolaSupervisorHealth,
	PianolaSupervisedState,
} from '../../../main/pianola/pianola-supervisor';
import type { PianolaSupervisorSnapshot } from '../../../main/ipc/handlers/pianola';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';

/** A currently-watched agent, with live daemon health when a child is running. */
export interface WatchedAgentRow {
	/** Supervisor target id, for setEnabled/remove. */
	targetId: string;
	agentId: string;
	agentName: string;
	tabId?: string;
	migratedToScopeId?: string;
	enabled: boolean;
	/** Live child state, when the daemon currently has one for this target. */
	state?: PianolaSupervisedState;
	lastError?: string;
}

/** An agent available for a whole-agent selection. */
export interface WatchableAgent {
	agentId: string;
	agentName: string;
}

/** Short id fallback for an agent whose session is no longer loaded. */
function shortId(id: string): string {
	return id.slice(0, 6);
}

/**
 * Pure derivation of the watch UI state from live sessions + the supervisor
 * snapshot. `watched` lists existing watch targets (enriched with name + live
 * health); `watchable` lists top-level agents not already selected by a scope.
 * Legacy tab watches remain available for the host's controlled handover.
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
			tabId: t.tabId,
			migratedToScopeId: t.migratedToScopeId,
			enabled: t.enabled,
			...(h ? { state: h.state } : {}),
			...(h?.lastError ? { lastError: h.lastError } : {}),
		};
	});

	const watchable: WatchableAgent[] = [];
	for (const s of sessions) {
		if (s.isPianola || s.parentSessionId) continue;
		const selected = targets.some((target) => {
			const selection = target.kind === 'watch-scope' ? target.selection : undefined;
			return (
				selection?.mode === 'agents-and-groups' &&
				(selection.agentIds.includes(s.id) ||
					selection.excludedAgentIds.includes(s.id) ||
					(!!s.groupId && selection.groupIds.includes(s.groupId)))
			);
		});
		if (selected) continue;
		watchable.push({ agentId: s.id, agentName: s.name });
	}

	return { watched, watchable };
}

const POLL_MS = 4000;

export interface PianolaSupervisorState {
	targets: PianolaSupervisedTarget[];
	health: PianolaSupervisorHealth[];
	checkpoints: PianolaSupervisorSnapshot['checkpoints'];
	saveScope: (target: Partial<PianolaSupervisedTarget>) => Promise<boolean>;
	watched: WatchedAgentRow[];
	watchable: WatchableAgent[];
	autoWatchNewAgents: boolean;
	setAutoWatchNewAgents: (enabled: boolean) => Promise<void>;
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
	const [checkpoints, setCheckpoints] = useState<PianolaSupervisorSnapshot['checkpoints']>([]);
	const autoWatchNewAgents = useSettingsStore((s) => s.pianolaAutoWatchNewAgents);
	const saveAutoWatchNewAgents = useSettingsStore((s) => s.setPianolaAutoWatchNewAgents);
	const setAutoWatchNewAgents = useCallback(
		async (enabled: boolean): Promise<void> => {
			try {
				await saveAutoWatchNewAgents(enabled);
			} catch (error) {
				notifyToast({
					color: 'red',
					title: 'Pianola setting failed',
					message: 'Could not save automatic watching.',
				});
				captureException(error, {
					tags: { feature: 'pianola' },
					extra: { action: 'save auto-watch setting' },
				});
			}
		},
		[saveAutoWatchNewAgents]
	);
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
				setCheckpoints(snap.checkpoints ?? []);
			}
		} catch (err) {
			// Feature turned off -> clear stale watched rows (nothing is watched when
			// Pianola is disabled). A transient IPC error keeps the last snapshot so
			// the list does not flicker; a mutation during the poll wins (epoch moved).
			if (mountedRef.current && mutationEpochRef.current === epoch && isPianolaDisabled(err)) {
				setTargets([]);
				setHealth([]);
				setCheckpoints([]);
			}
		}
	}, []);

	useEffect(() => {
		void load();
		const id = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(id);
	}, [load]);

	const mutate = useCallback(
		async (op: Promise<PianolaSupervisorSnapshot>, action: string): Promise<boolean> => {
			mutationEpochRef.current += 1; // invalidate polls issued before this mutation
			try {
				const snap = await op;
				mutationEpochRef.current += 1; // invalidate polls issued during this mutation
				if (mountedRef.current) {
					setTargets(snap.targets);
					setHealth(snap.health);
					setCheckpoints(snap.checkpoints ?? []);
				}
				if (snap.migration?.status === 'NeedsConfiguration') {
					notifyToast({
						color: 'red',
						title: 'Pianola needs configuration',
						message: snap.migration.reason ?? 'The selection was not saved.',
					});
					return false;
				}
				return true;
			} catch (err) {
				mutationEpochRef.current += 1;
				const error = err instanceof Error ? err : new Error(String(err));
				// A watch toggle is a recoverable user action: surface the failure and,
				// for unexpected errors, report it - then resolve rather than reject so a
				// fire-and-forget click never becomes an unhandled rejection. Mirrors the
				// PianolaModal rule/suggestion handlers (toast + gated captureException).
				notifyToast({
					color: 'red',
					title: 'Pianola watch action failed',
					message: `Could not ${action}: ${error.message}`,
				});
				if (!isPianolaDisabled(error))
					captureException(error, { tags: { feature: 'pianola' }, extra: { action } });
				return false;
			}
		},
		[]
	);

	const watch = useCallback(
		async (agentId: string, tabId: string) => {
			await mutate(
				window.maestro.pianola.supervisor.add({ kind: 'watch', agentId, tabId, enabled: true }),
				'start watching the agent'
			);
		},
		[mutate]
	);
	const unwatch = useCallback(
		async (targetId: string) => {
			await mutate(window.maestro.pianola.supervisor.remove(targetId), 'stop watching the agent');
		},
		[mutate]
	);
	const setEnabled = useCallback(
		async (targetId: string, enabled: boolean) => {
			await mutate(
				window.maestro.pianola.supervisor.setEnabled(targetId, enabled),
				enabled ? 'resume watching' : 'pause watching'
			);
		},
		[mutate]
	);

	const { watched, watchable } = useMemo(
		() => deriveWatchState(sessions, targets, health),
		[sessions, targets, health]
	);

	const refresh = useCallback(() => void load(), [load]);

	return {
		targets,
		health,
		checkpoints,
		saveScope: (target) => mutate(window.maestro.pianola.supervisor.add(target), 'save selection'),
		watched,
		watchable,
		autoWatchNewAgents,
		setAutoWatchNewAgents,
		watch,
		unwatch,
		setEnabled,
		refresh,
	};
}
