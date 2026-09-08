/**
 * Typography snapshot - one saved copy of "the fonts I actually like".
 *
 * The Display tab offers two destructive-by-design controls: the Factory Reset
 * presets, which overwrite every font and size at once. Trying one meant losing
 * a hand-tuned setup that took a dozen picker changes to build, so the presets
 * were effectively unusable to anyone who had customized anything.
 *
 * A snapshot is the escape hatch: capture the current state, go try Default or
 * Hacker, restore. It is deliberately ONE slot rather than named profiles - the
 * job is "get back to mine", not "curate a library", and a list would need
 * naming, renaming, and deleting UI for a thing most users save once.
 *
 * Shared rather than renderer-local because the settings keys it copies come
 * from the surface registry in typography.ts, and a second hand-written list of
 * them is exactly how a newly added surface gets silently left out of a save.
 */

import {
	TYPOGRAPHY_SURFACE_LIST,
	canInherit,
	clampSurfaceFontSize,
	BASE_FONT_SIZE_DEFAULT,
	SURFACE_FONT_SIZE_MAX,
	SURFACE_FONT_SIZE_MIN,
} from './typography';

export interface TypographySnapshot {
	/** ms epoch when captured, so the UI can say how old the save is. */
	savedAt: number;
	/** Settings key -> font family, for every registered surface. */
	fonts: Record<string, string>;
	/**
	 * Settings key -> size in px BEFORE zoom, for every registered surface.
	 * Zoom is not captured: it is an accessibility accommodation the user
	 * moves with Cmd+= as they read, not part of the look being saved, and
	 * restoring a setup should not reach in and change how big everything is.
	 */
	sizes: Record<string, number>;
}

/** The settings keys a snapshot covers, derived from the surface registry. */
export function typographySnapshotKeys(): { fontKeys: string[]; sizeKeys: string[] } {
	return {
		fontKeys: TYPOGRAPHY_SURFACE_LIST.map((spec) => spec.fontKey),
		sizeKeys: TYPOGRAPHY_SURFACE_LIST.map((spec) => spec.sizeKey),
	};
}

/** Read a size the same way the store clamps it, so a save round-trips exactly. */
function readSize(raw: unknown, inheritable: boolean): number {
	const value = Number(raw ?? 0);
	if (!inheritable) {
		// The interface size is the base of the chain and can never be 0
		// ("inherit from myself"), so it clamps against the base bounds.
		if (!Number.isFinite(value) || value <= 0) return BASE_FONT_SIZE_DEFAULT;
		return Math.min(SURFACE_FONT_SIZE_MAX, Math.max(SURFACE_FONT_SIZE_MIN, Math.round(value)));
	}
	return clampSurfaceFontSize(value);
}

/**
 * Capture the current font and size of every surface.
 *
 * `values` is the settings store read as a plain record, the same shape the
 * Display tab already passes its font pickers.
 */
export function captureTypographySnapshot(
	values: Record<string, unknown>,
	savedAt: number = Date.now()
): TypographySnapshot {
	const fonts: Record<string, string> = {};
	const sizes: Record<string, number> = {};
	for (const spec of TYPOGRAPHY_SURFACE_LIST) {
		fonts[spec.fontKey] = String(values[spec.fontKey] ?? '');
		sizes[spec.sizeKey] = readSize(values[spec.sizeKey], canInherit(spec));
	}
	return { savedAt, fonts, sizes };
}

/**
 * Narrow a persisted value back into a snapshot, or null when it is missing or
 * malformed.
 *
 * Validated rather than cast because this value survives across versions: a
 * snapshot saved before a surface existed simply lacks that key, and one written
 * by a hand-edited settings file could be anything. Missing keys are filled from
 * the CURRENT values by `typographySnapshotPatch`, so an old save restores the
 * surfaces it knows about and leaves the rest alone instead of blanking them.
 */
export function parseTypographySnapshot(raw: unknown): TypographySnapshot | null {
	if (!raw || typeof raw !== 'object') return null;
	const candidate = raw as Partial<TypographySnapshot>;
	if (!candidate.fonts || typeof candidate.fonts !== 'object') return null;
	if (!candidate.sizes || typeof candidate.sizes !== 'object') return null;

	const { fontKeys, sizeKeys } = typographySnapshotKeys();
	const fonts: Record<string, string> = {};
	const sizes: Record<string, number> = {};
	for (const key of fontKeys) {
		const value = (candidate.fonts as Record<string, unknown>)[key];
		if (typeof value === 'string') fonts[key] = value;
	}
	for (const key of sizeKeys) {
		const value = Number((candidate.sizes as Record<string, unknown>)[key]);
		if (Number.isFinite(value)) sizes[key] = value;
	}
	// A snapshot that carries no recognizable surface is indistinguishable from
	// no snapshot at all, and offering "Restore" for it would do nothing.
	if (Object.keys(fonts).length === 0 && Object.keys(sizes).length === 0) return null;

	const savedAt = Number(candidate.savedAt);
	return { savedAt: Number.isFinite(savedAt) ? savedAt : 0, fonts, sizes };
}

/**
 * The flat settings patch that restores a snapshot: one object the store can
 * `set` in a single repaint, and iterate to persist.
 *
 * Only keys the snapshot actually holds are written, so restoring a save made
 * before a surface existed leaves that surface where the user has it rather
 * than resetting it to an empty family.
 */
export function typographySnapshotPatch(
	snapshot: TypographySnapshot
): Record<string, string | number> {
	const patch: Record<string, string | number> = {};
	for (const spec of TYPOGRAPHY_SURFACE_LIST) {
		const font = snapshot.fonts[spec.fontKey];
		if (typeof font === 'string') patch[spec.fontKey] = font;
		const size = snapshot.sizes[spec.sizeKey];
		if (typeof size === 'number' && Number.isFinite(size)) {
			patch[spec.sizeKey] = readSize(size, canInherit(spec));
		}
	}
	return patch;
}

/**
 * Whether the live settings already equal the snapshot.
 *
 * Drives the "your saved setup is active" readout, so the user can tell at a
 * glance whether they are looking at their own fonts or at a preset they were
 * trying out. Compares only the keys the snapshot holds, for the same
 * forward-compatibility reason as the patch.
 */
export function typographySnapshotMatches(
	snapshot: TypographySnapshot | null,
	values: Record<string, unknown>
): boolean {
	if (!snapshot) return false;
	const patch = typographySnapshotPatch(snapshot);
	for (const [key, saved] of Object.entries(patch)) {
		const live = values[key];
		if (typeof saved === 'string') {
			if (String(live ?? '') !== saved) return false;
		} else if (Number(live ?? 0) !== saved) {
			return false;
		}
	}
	return true;
}
