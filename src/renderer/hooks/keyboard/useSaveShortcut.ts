import { useEffect, useRef } from 'react';

/**
 * Listens for Cmd+S (macOS) / Ctrl+S (other) and invokes `handler` while `enabled` is true.
 * Uses capture-phase + preventDefault so it wins against textarea/input handlers
 * and the browser's default "Save Page As" behavior.
 */
export function useSaveShortcut(handler: () => void, enabled: boolean): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		if (!enabled) return;

		const onKeyDown = (e: KeyboardEvent) => {
			const modifier = e.metaKey || e.ctrlKey;
			if (!modifier || e.shiftKey || e.altKey) return;
			if (e.key !== 's' && e.key !== 'S') return;
			e.preventDefault();
			e.stopPropagation();
			handlerRef.current();
		};

		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [enabled]);
}
