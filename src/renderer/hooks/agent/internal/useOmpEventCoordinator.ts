import { useCallback, useRef } from 'react';

/**
 * Serializes first-party OMP renderer mutations per owning tab. OMP emits
 * several IPC streams; wall-clock timestamps and independent RAF queues are
 * not a reliable ordering mechanism, so callers enqueue their source-event
 * mutation and lifecycle frames explicitly flush the matching tab.
 */
export interface OmpEventCoordinator {
	enqueue(sessionId: string, mutation: () => void): void;
	flush(sessionId: string): void;
}

const NOOP: OmpEventCoordinator = {
	enqueue: () => undefined,
	flush: () => undefined,
};

export function useOmpEventCoordinator(): OmpEventCoordinator {
	const pendingRef = useRef(new Map<string, Array<{ sequence: number; mutation: () => void }>>());
	const sequenceRef = useRef(0);

	const enqueue = useCallback((sessionId: string, mutation: () => void) => {
		const pending = pendingRef.current.get(sessionId) ?? [];
		pending.push({ sequence: sequenceRef.current++, mutation });
		pendingRef.current.set(sessionId, pending);
	}, []);

	const flush = useCallback((sessionId: string) => {
		const pending = pendingRef.current.get(sessionId);
		if (!pending?.length) return;
		pendingRef.current.delete(sessionId);
		pending.sort((first, second) => first.sequence - second.sequence);
		for (const { mutation } of pending) mutation();
	}, []);

	return { enqueue, flush };
}

export const NOOP_OMP_EVENT_COORDINATOR = NOOP;
