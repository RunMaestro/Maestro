import { useEffect } from 'react';

export interface UseBracketTabCycleParams<T> {
	/** When false the shortcut is inert (e.g. modal closed or a nested overlay is up). */
	enabled: boolean;
	/** Ordered list of tab values to cycle through. Keep the reference stable. */
	values: readonly T[];
	/** Currently selected value. */
	active: T;
	/** Called with the next value when the user cycles. */
	onChange: (value: T) => void;
}

/**
 * Wires Cmd+Shift+[ and Cmd+Shift+] to cycle through a fixed list of tab
 * values, wrapping at both ends. `[` goes to the previous tab, `]` to the next.
 * No-op when `enabled` is false.
 *
 * Uses preventDefault + stopPropagation so the shortcut doesn't bubble out to
 * global app-level keybindings (plain Cmd+[ / Cmd+] cycle agents in the Left
 * Bar). Requiring Shift keeps this modal-local cycling distinct from that.
 *
 * Generalizes the per-modal cycle hooks (useSymphonyTabCycle, useDocumentCycle,
 * useMarketplaceCategoryDocumentCycle); prefer this for new modal tab cycling.
 */
export function useBracketTabCycle<T>({
	enabled,
	values,
	active,
	onChange,
}: UseBracketTabCycleParams<T>): void {
	useEffect(() => {
		if (!enabled) return;
		const handle = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();
				const currentIndex = values.indexOf(active);
				if (currentIndex === -1 || values.length === 0) return;
				const delta = e.key === '[' ? -1 : 1;
				const newIndex = (currentIndex + delta + values.length) % values.length;
				onChange(values[newIndex]);
			}
		};
		window.addEventListener('keydown', handle);
		return () => window.removeEventListener('keydown', handle);
	}, [enabled, values, active, onChange]);
}
