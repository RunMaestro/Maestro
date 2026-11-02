/**
 * useInterruptHandler - extracted from App.tsx
 *
 * The desktop Stop: stops every turn the active agent has running, through
 * `interruptTurn()` in `services/turnInterrupt.ts`, the same function the REST
 * route and `maestro-cli interrupt` run. When the signal fails, the user is
 * asked before the turn is force-killed.
 *
 * Also registers the two deps only App owns (synopsis cancel and the gated
 * queue dispatch) with that service, so a remote stop gets them too.
 *
 * PERF: Reads activeSession via getState() at interrupt time so App does not
 * re-render when the active session / session list changes. Non-store deps are
 * kept in a ref so handleInterrupt keeps a stable identity.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { QueuedItem } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import {
	FORCE_KILL_PROMPT,
	interruptTurn,
	registerTurnInterruptDeps,
} from '../../services/turnInterrupt';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseInterruptHandlerDeps {
	/** Cancel any pending synopsis processes for a session */
	cancelPendingSynopsis: (sessionId: string) => Promise<void>;
	/** Process next queued execution item */
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseInterruptHandlerReturn {
	/** Interrupt the active session's running process */
	handleInterrupt: () => Promise<void>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useInterruptHandler(deps: UseInterruptHandlerDeps): UseInterruptHandlerReturn {
	const depsRef = useRef(deps);
	depsRef.current = deps;

	useEffect(() => {
		registerTurnInterruptDeps({
			cancelPendingSynopsis: (sessionId) => depsRef.current.cancelPendingSynopsis(sessionId),
			processQueuedItem: (sessionId, item) => depsRef.current.processQueuedItem(sessionId, item),
		});
		return () => registerTurnInterruptDeps(null);
	}, []);

	const handleInterrupt = useCallback(async () => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (!activeSession) return;
		await interruptTurn(activeSession.id, {
			confirmForceKill: () => confirm(FORCE_KILL_PROMPT),
		});
	}, []);

	return { handleInterrupt };
}
