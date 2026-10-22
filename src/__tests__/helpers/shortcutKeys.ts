/**
 * Find a chord drawn by `ShortcutKeys` (src/renderer/components/ui/ShortcutHint.tsx).
 *
 * `ShortcutKeys` draws one `<kbd>` cap per key, so the chord's text is split
 * across elements and `getByText(formatShortcutKeys(keys))` no longer finds it.
 * The cluster carries the raw keys in `data-shortcut-keys` instead
 * (`Meta+Shift+k`, alternatives joined with ` | `), which is what these match.
 */

/** Every drawn chord for these raw keys, e.g. `['Meta', 'k']`. */
export function queryAllShortcutKeys(
	keys: string[],
	container: ParentNode = document
): HTMLElement[] {
	const wanted = keys.join('+');
	return Array.from(container.querySelectorAll<HTMLElement>('[data-shortcut-keys]')).filter(
		(el) => el.dataset.shortcutKeys === wanted
	);
}

/** The one drawn chord for these raw keys; throws when there is none. */
export function getShortcutKeys(keys: string[], container: ParentNode = document): HTMLElement {
	const found = queryAllShortcutKeys(keys, container);
	if (found.length === 0) {
		throw new Error(`No ShortcutKeys drawn for ${keys.join('+')}`);
	}
	return found[0];
}
