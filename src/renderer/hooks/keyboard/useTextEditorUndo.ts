import { useEffect } from 'react';

/**
 * Window-level fallback that routes Cmd+Z / Cmd+Shift+Z (and Ctrl+Y on
 * Windows/Linux) to the focused text input via `document.execCommand`.
 *
 * Maestro's Edit menu intentionally omits `role: 'undo'` / `role: 'redo'`
 * so the image annotator can claim Cmd+Z for stroke undo. On macOS that
 * also disables native textarea/input undo inside Electron - Chromium
 * relies on the Edit menu role to deliver Cmd+Z to the focused editable
 * element. This hook restores that behavior in the renderer.
 *
 * Bubble phase + `defaultPrevented` check lets editors with their own
 * undo stack (Auto Run via `useAutoRunUndo`) handle the key first; we
 * only step in when nothing else has. The image annotator's keydown
 * handler bails out for text targets, so the two don't conflict.
 */
export function useTextEditorUndo(): void {
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			const mod = e.metaKey || e.ctrlKey;
			if (!mod || e.altKey) return;

			const key = e.key.toLowerCase();
			let command: 'undo' | 'redo' | null = null;
			if (key === 'z') {
				command = e.shiftKey ? 'redo' : 'undo';
			} else if (key === 'y' && !e.shiftKey && e.ctrlKey && !e.metaKey) {
				command = 'redo';
			}
			if (!command) return;

			const target = e.target as HTMLElement | null;
			const isTextField =
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable);
			if (!isTextField) return;

			e.preventDefault();
			document.execCommand(command);
		};

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);
}
