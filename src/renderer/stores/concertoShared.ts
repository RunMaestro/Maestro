/**
 * Shared helpers for the two Concerto view stores (movementStore, cadenzaStore),
 * which are structurally parallel: an id-keyed list of cards, plus a transient
 * "flash" pulse driven by a chat "point" chip.
 */

/** Insert `item`, or replace the existing entry with the same id. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
	return list.some((v) => v.id === item.id)
		? list.map((v) => (v.id === item.id ? item : v))
		: [...list, item];
}

/** Return the owning plugin id for a namespaced contribution view id. */
export function sourcePluginFromViewId(id: string): string | undefined {
	const separator = id.indexOf('/');
	return separator > 0 && separator < id.length - 1 ? id.slice(0, separator) : undefined;
}

/** How long a chat-chip "point" pulse stays lit (ms). */
export const FLASH_DURATION_MS = 2200;

/**
 * Schedule clearing the flash after FLASH_DURATION_MS, but only if this flash is
 * still the current one - so a newer flash isn't cancelled by an older pending
 * timeout. Callers set `flashedId` themselves (the stores differ: movement also
 * un-stashes the overlay) and pass a getter + clearer for the tail.
 */
export function scheduleFlashClear(
	getFlashedId: () => string | null,
	clearFlash: () => void,
	id: string
): void {
	setTimeout(() => {
		if (getFlashedId() === id) clearFlash();
	}, FLASH_DURATION_MS);
}
