/**
 * useOwnedSessionGate - window-scoping for incoming `process:*` events.
 *
 * The main process BROADCASTS every `process:*` event (data, exit, status, ...)
 * to ALL windows (see the MULTI-WINDOW INVARIANT in `safe-send.ts`). Each
 * window must therefore drop events for agents it does not own, otherwise a
 * non-owning window would append another agent's output to its store and - far
 * worse - re-run the one-shot `onExit` / `onAgentError` side effects (synopsis
 * spawn, git refresh, history entry, batch pause) once per open window.
 *
 * Ownership truth lives in exactly one place: `WindowContext.ownsSession`
 * (the primary window is the catch-all owner; a secondary window owns its
 * explicit scoped set). This hook reuses that predicate rather than
 * re-deriving ownership, and exposes it as a STABLE ref so the high-frequency
 * IPC listeners can sit in a `useEffect` dependency array without
 * re-subscribing every time ownership changes (re-subscribing would risk
 * dropping events mid-swap - keyboard/event reliability is non-negotiable).
 *
 * Null-safe: outside a `WindowProvider` (isolation tests) the gate permits
 * everything, so single-window behaviour is unchanged. The web-desktop build
 * mounts a `WindowProvider` but its `ownsSession` is a permit-all by design
 * (a browser client mirrors every agent - see `WindowContext`).
 */

import { useEffect, useRef, type RefObject } from 'react';
import { useWindowContextOptional } from '../../../contexts/WindowContext';
import { parseSessionId } from '../../../utils/sessionIdParser';

/** Suffix the PTY/command terminal appends to a raw process session id. */
const TERMINAL_SUFFIX = '-terminal';

/**
 * Resolve the owning agent id from a raw `process:*` session id.
 *
 * Process events arrive keyed by decorated session ids - `{agentId}-ai-{tabId}`,
 * `{agentId}-terminal`, `{agentId}-batch-{ts}`, `{agentId}-synopsis-{ts}`, or a
 * bare `{agentId}`. {@link parseSessionId} strips the AI/batch/synopsis forms;
 * the terminal suffix it does not know about, so we peel that first. The
 * returned id is what `ownsSession` is keyed on (an agent lives in one window,
 * and all of its decorated ids - including its background batch/synopsis runs -
 * belong to that same window).
 */
export function agentIdFromProcessSessionId(rawSessionId: string): string {
	if (rawSessionId.endsWith(TERMINAL_SUFFIX)) {
		return rawSessionId.slice(0, -TERMINAL_SUFFIX.length);
	}
	return parseSessionId(rawSessionId).baseSessionId;
}

/** A stable ref whose `.current` answers "does THIS window own this raw session?". */
export type OwnedSessionGate = RefObject<(rawSessionId: string) => boolean>;

/**
 * Returns a stable ref-backed predicate gating `process:*` events to the agents
 * this window owns. Call once per listener hook (before its subscription
 * `useEffect`) and guard the handler's first line with
 * `if (!gate.current?.(sessionId)) return;`.
 */
export function useOwnedSessionGate(): OwnedSessionGate {
	const ctx = useWindowContextOptional();
	const ownsSession = ctx?.ownsSession;
	// Default permits everything so the very first events (before the effect
	// below commits) and the no-WindowProvider case are never dropped.
	const gateRef = useRef<(rawSessionId: string) => boolean>(() => true);

	useEffect(() => {
		gateRef.current = (rawSessionId: string) => {
			// No window scoping in play (isolation tests): permit all.
			if (!ownsSession) return true;
			return ownsSession(agentIdFromProcessSessionId(rawSessionId));
		};
	}, [ownsSession]);

	return gateRef;
}
