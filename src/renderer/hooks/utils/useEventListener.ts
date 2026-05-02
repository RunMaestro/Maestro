/**
 * useEventListener.ts
 *
 * Generic hook for adding and removing DOM event listeners with proper
 * cleanup on unmount or when the event type / target / enabled state changes.
 *
 * The handler is held in a ref so callers can pass an inline function
 * without re-subscribing on every render — only `eventType`, `target`, and
 * `enabled` cause re-subscription.
 */

import { useEffect, useRef } from 'react';

export interface UseEventListenerOptions {
	/**
	 * The EventTarget to attach the listener to. Defaults to `window`.
	 * Pass `document` for click-outside / global keyboard handlers, or an
	 * `HTMLElement` (typically from a ref) for element-scoped listeners.
	 * Pass `null` to skip subscription (useful for ref-based targets that
	 * may be initially null).
	 */
	target?: Window | Document | HTMLElement | null;
	/**
	 * When `false`, the listener is not attached. Toggling between `true` and
	 * `false` re-attaches / detaches the listener cleanly. Defaults to `true`.
	 */
	enabled?: boolean;
}

/**
 * Attaches an event listener to the given target (default `window`) for the
 * given event type and automatically removes it when the component unmounts
 * or when `eventType`, `target`, or `enabled` changes.
 *
 * @example
 * useEventListener('maestro:openFileTab', (e) => {
 *   const { sessionId, filePath } = (e as CustomEvent).detail;
 *   // ...
 * });
 *
 * @example  document-scoped Escape handler, only when modal is open
 * useEventListener(
 *   'keydown',
 *   (e) => { if (e.key === 'Escape') onClose(); },
 *   { target: document, enabled: isOpen }
 * );
 */
export function useEventListener(
	eventType: string,
	handler: (event: Event) => void,
	options?: UseEventListenerOptions
): void {
	const { target = typeof window !== 'undefined' ? window : null, enabled = true } = options ?? {};

	// Keep a stable ref to the handler so the effect only re-runs when
	// eventType / target / enabled change, not on every render where the
	// handler closure is re-created.
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		if (!enabled || !target) return;
		const listener = (event: Event) => handlerRef.current(event);
		target.addEventListener(eventType, listener);
		return () => {
			target.removeEventListener(eventType, listener);
		};
	}, [eventType, target, enabled]);
}
