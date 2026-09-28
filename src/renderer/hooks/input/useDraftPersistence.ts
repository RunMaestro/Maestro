import { useCallback, useEffect, useRef } from 'react';

/**
 * Debounced write-back of a live composer draft, keyed by whatever the
 * caller is drafting into (a tab id, a group chat id, ...).
 *
 * Extracted so AI Chat's `useInputSync` and Group Chat's `GroupChatInput`
 * stop independently reinventing the same "coalesce keystrokes, but never
 * lose a draft across a key switch or unmount" primitive. `V` is whatever
 * payload the caller needs persisted alongside the key - a plain string
 * draft, or a `{ value, commandMode }` pair for AI Chat's tabs.
 *
 * A queued write for a DIFFERENT key than the one now being queued is
 * flushed immediately rather than dropped: without this, switching tabs (or
 * chats) mid-debounce would either lose the previous draft or, worse,
 * eventually stamp it onto whatever key happens to be current when the
 * original timer fires.
 */
export function useDraftPersistence<V>(
	onPersist: (key: string, value: V) => void,
	delayMs = 300
): {
	/** Queue a debounced persist for `key`. Safe to call on every keystroke. */
	queueFlush: (key: string, value: V) => void;
	/** Persist `key`/`value` immediately, canceling any pending queued write. */
	flushNow: (key: string, value: V) => void;
	/** Apply whatever write is currently queued, right now. No-op if nothing is pending. */
	flushPending: () => void;
	/** Discard whatever write is currently queued without persisting it. */
	cancelPending: () => void;
} {
	const pendingRef = useRef<{ key: string; value: V } | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onPersistRef = useRef(onPersist);
	onPersistRef.current = onPersist;

	const cancelPending = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		pendingRef.current = null;
	}, []);

	const flushPending = useCallback(() => {
		const pending = pendingRef.current;
		cancelPending();
		if (pending) onPersistRef.current(pending.key, pending.value);
	}, [cancelPending]);

	const queueFlush = useCallback(
		(key: string, value: V) => {
			const pending = pendingRef.current;
			if (pending && pending.key !== key) {
				flushPending();
			}
			pendingRef.current = { key, value };
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				const next = pendingRef.current;
				pendingRef.current = null;
				if (next) onPersistRef.current(next.key, next.value);
			}, delayMs);
		},
		[delayMs, flushPending]
	);

	const flushNow = useCallback(
		(key: string, value: V) => {
			cancelPending();
			onPersistRef.current(key, value);
		},
		[cancelPending]
	);

	// Teardown is a loss boundary: whatever is still queued has to land before
	// this hook (and its timer) go away.
	useEffect(() => flushPending, [flushPending]);

	return { queueFlush, flushNow, flushPending, cancelPending };
}
