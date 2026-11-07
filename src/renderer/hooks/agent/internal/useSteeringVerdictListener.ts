/**
 * useSteeringVerdictListener - settles delivered chat steers.
 *
 * Subscriptions handed to services/chatSteering.ts: the actual Codex transport,
 * the transcript verdict (`process:steering-verdict`), and process exit, which settles any steer
 * whose verdict never arrived. Both are keyed by the full process key
 * (`{sessionId}-ai-{tabId}`), which is what the steer was sent to.
 *
 * Plus one reconcile once the store has loaded: parked steers are persisted, and
 * a reload or restart can have swallowed the verdict or exit they were waiting
 * for.
 */

import { useEffect } from 'react';
import {
	applyCodexTransport,
	applySteeringVerdict,
	reconcilePendingSteers,
	settlePendingSteersOnExit,
} from '../../../services/chatSteering';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useSteeringVerdictListener(): void {
	const ownedGate = useOwnedSessionGate();
	const initialLoadComplete = useSessionStore((s) => s.initialLoadComplete);
	useEffect(() => {
		const process = window.maestro?.process;
		if (!process?.onSteeringVerdict) return;
		let disposed = false;
		// Live events and exits always win over a snapshot requested before them.
		const changedDuringSnapshot = new Set<string>();
		const unsubscribeTransport = process.onCodexTransport?.((processKey, transport) => {
			if (!ownedGate.current?.(processKey)) return;
			changedDuringSnapshot.add(processKey);
			applyCodexTransport(processKey, transport);
		});

		const unsubscribeVerdict = process.onSteeringVerdict((processKey, verdict) => {
			if (!ownedGate.current?.(processKey)) return;
			applySteeringVerdict(processKey, verdict);
		});
		const unsubscribeExit = process.onExit((processKey: string) => {
			if (!ownedGate.current?.(processKey)) return;
			changedDuringSnapshot.add(processKey);
			applyCodexTransport(processKey, undefined);
			settlePendingSteersOnExit(processKey);
		});
		if (initialLoadComplete && process.getActiveProcesses) {
			// Persisted transport state cannot prove a process survived a reload.
			for (const session of useSessionStore.getState().sessions) {
				for (const tab of [...session.aiTabs, ...(session.orphanedThinkingTabs ?? [])]) {
					const key = `${session.id}-ai-${tab.id}`;
					if (tab.turnCodexTransport && ownedGate.current?.(key)) {
						applyCodexTransport(key, undefined);
					}
				}
			}
			void process.getActiveProcesses({ includeChildProcesses: false }).then(
				(active) => {
					if (disposed) return;
					for (const running of active) {
						if (
							running.toolType === 'codex' &&
							ownedGate.current?.(running.sessionId) &&
							!changedDuringSnapshot.has(running.sessionId)
						) {
							applyCodexTransport(running.sessionId, running.codexTransport);
						}
					}
				},
				() => {} // Unknown transport stays unsteerable until a live event arrives.
			);
		}

		return () => {
			disposed = true;
			unsubscribeTransport?.();
			unsubscribeVerdict();
			unsubscribeExit();
		};
	}, [initialLoadComplete, ownedGate]);

	useEffect(() => {
		if (!initialLoadComplete) return;
		void reconcilePendingSteers((processKey) => ownedGate.current?.(processKey) ?? false);
	}, [initialLoadComplete, ownedGate]);
}
