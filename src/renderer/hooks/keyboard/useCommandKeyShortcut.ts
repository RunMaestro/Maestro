import { useEffect, useRef } from 'react';

/**
 * Listens for a bare Cmd+<key> (macOS) / Ctrl+<key> (other) chord and invokes
 * `handler` while `enabled` is true.
 *
 * This is the primitive behind the surface-local chords that a focused pane
 * claims for itself while it is open - Cmd+S in an editor pane, Cmd+R on a
 * quota panel. It deliberately requires the modifier ALONE (no Shift, no Alt)
 * so it can never swallow a Shift- or Alt-qualified binding that means
 * something else, and it listens in the capture phase with preventDefault so
 * it wins against a focused textarea and against the browser's own default for
 * the chord (Save Page As, Reload).
 *
 * It is NOT the way to add a global, user-rebindable shortcut: those live in
 * `constants/shortcuts.ts` and are matched through `eventMatchesShortcutKeys`
 * so the user can change them. Reach for this only when the chord belongs to
 * one surface for as long as that surface is up.
 */
export function useCommandKeyShortcut(key: string, handler: () => void, enabled: boolean): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		if (!enabled) return;

		const target = key.toLowerCase();
		const onKeyDown = (e: KeyboardEvent) => {
			const modifier = e.metaKey || e.ctrlKey;
			if (!modifier || e.shiftKey || e.altKey) return;
			if (e.key.toLowerCase() !== target) return;
			e.preventDefault();
			e.stopPropagation();
			handlerRef.current();
		};

		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [key, enabled]);
}
