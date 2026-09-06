/**
 * The Document Graph's layout vocabulary.
 *
 * A leaf module on purpose. The same union was written out three times - in the
 * layout engine, in the `Session` interface, and in `settingsStore` - so adding
 * a layout meant a type error in two files that know nothing about layouts, and
 * a layout the user picked could be rejected on the way to disk by a copy that
 * had not been updated. Everything imports the union from here.
 *
 * It stays separate from `mindMapLayouts.ts` because that module pulls in
 * d3-force, and `settingsStore` needs only the names.
 */

/** Available layout algorithm types */
export type MindMapLayoutType =
	| 'mindmap'
	| 'radial'
	| 'hierarchical'
	| 'force'
	| 'lobes'
	| 'timeline';

/** Display labels for layout types */
export const LAYOUT_LABELS: Record<MindMapLayoutType, { name: string; description: string }> = {
	mindmap: { name: 'Mind Map', description: 'Tree columns' },
	radial: { name: 'Radial', description: 'Concentric rings' },
	hierarchical: { name: 'Hierarchical', description: 'Top-down rows' },
	force: { name: 'Force', description: 'Physics simulation' },
	lobes: { name: 'Lobes', description: 'Clustered by link community' },
	timeline: { name: 'Timeline', description: 'Columns by last modified' },
};

/**
 * Layout order, shared by the toolbar dropdown, the `L` cycle shortcut, and the
 * settings validator, so a key press, a click, and what reaches disk can never
 * disagree about which layouts exist.
 */
export const MIND_MAP_LAYOUT_TYPES: readonly MindMapLayoutType[] = [
	'mindmap',
	'radial',
	'hierarchical',
	'force',
	'lobes',
	'timeline',
];

/** The layout after `current`, wrapping at the end of the list. */
export function nextMindMapLayout(current: MindMapLayoutType): MindMapLayoutType {
	// An unrecognized value restarts the cycle rather than sticking on itself.
	const index = MIND_MAP_LAYOUT_TYPES.indexOf(current);
	return MIND_MAP_LAYOUT_TYPES[(index + 1) % MIND_MAP_LAYOUT_TYPES.length];
}

/** True when `value` names a layout this build knows how to draw. */
export function isMindMapLayoutType(value: unknown): value is MindMapLayoutType {
	return MIND_MAP_LAYOUT_TYPES.includes(value as MindMapLayoutType);
}
