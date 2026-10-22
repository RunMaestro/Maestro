/**
 * useSteeringVerdictListener - settles delivered chat steers.
 *
 * Two subscriptions, both handed to services/chatSteering.ts: the transcript
 * verdict (`process:steering-verdict`), and process exit, which settles any steer
 * whose verdict never arrived. Both are keyed by the full process key
 * (`{sessionId}-ai-{tabId}`), which is what the steer was sent to.
 *
 * Plus one reconcile once the store has loaded: parked steers are persisted, and
 * a reload or restart can have swallowed the verdict or exit they were waiting
 * for.
 */

import { useEffect } from 'react';
import {
	applySteeringVerdict,
	reconcilePendingSteers,
	settlePendingSteersOnExit,
} from '../../../services/chatSteering';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useSteeringVerdictListener(): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const process = window.maestro?.process;
		if (!process?.onSteeringVerdict) return;

		const unsubscribeVerdict = process.onSteeringVerdict((processKey, verdict) => {
			if (!ownedGate.current?.(processKey)) return;
			applySteeringVerdict(processKey, verdict);
		});
		const unsubscribeExit = process.onExit((processKey: string) => {
			if (!ownedGate.current?.(processKey)) return;
			settlePendingSteersOnExit(processKey);
		});

		return () => {
			unsubscribeVerdict();
			unsubscribeExit();
		};
	}, [ownedGate]);

	const initialLoadComplete = useSessionStore((s) => s.initialLoadComplete);
	useEffect(() => {
		if (!initialLoadComplete) return;
		void reconcilePendingSteers((processKey) => ownedGate.current?.(processKey) ?? false);
	}, [initialLoadComplete, ownedGate]);
}
