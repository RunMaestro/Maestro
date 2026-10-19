/**
 * Reference to any tab in the unified tab system.
 *
 * It lives in `shared/` because the main process needs it too: a tab window's
 * record in the `WindowRegistry` holds the refs of the tabs popped into it
 * (`src/shared/tabWindowTypes.ts`), and `tsconfig.main.json` cannot reach
 * `src/renderer/types`, which type-imports renderer-only modules. The renderer
 * re-exports it from `src/renderer/types/index.ts`, so existing imports keep
 * working.
 */

/** Every kind of entry the unified tab strip holds. */
export type UnifiedTabType = 'ai' | 'file' | 'terminal' | 'browser' | 'group';

/**
 * Used for unified tab ordering across different tab types.
 *
 * The `'group'` kind lets a tiled TabGroup appear as a single entry in the tab
 * strip. Unlike the other kinds (which point at a tab in aiTabs/filePreviewTabs/
 * terminalTabs/browserTabs), a group ref's `id` points at a TabGroup in
 * `Session.tabGroups`; the group's own layout still references the underlying
 * tabs by leaf. See PanelLayoutNode in `src/renderer/types/index.ts`.
 */
export type UnifiedTabRef = { type: UnifiedTabType; id: string };

/** The tab kinds that are a single tab, as opposed to a tiled group. */
export type SingleTabType = Exclude<UnifiedTabType, 'group'>;

/** A ref to one tab (never a tiled group). */
export type SingleTabRef = { type: SingleTabType; id: string };

const SINGLE_TAB_TYPES: ReadonlySet<string> = new Set<SingleTabType>([
	'ai',
	'file',
	'terminal',
	'browser',
]);

/** True for a well-formed `{ type, id }` ref to one tab (not a group). */
export function isSingleTabRef(value: unknown): value is SingleTabRef {
	if (typeof value !== 'object' || value === null) return false;
	const ref = value as { type?: unknown; id?: unknown };
	return (
		typeof ref.type === 'string' &&
		SINGLE_TAB_TYPES.has(ref.type) &&
		typeof ref.id === 'string' &&
		ref.id.length > 0
	);
}

/** Two refs name the same tab. */
export function isSameTabRef(a: UnifiedTabRef, b: UnifiedTabRef): boolean {
	return a.type === b.type && a.id === b.id;
}

/**
 * Stable key for a tab ref (used to dedupe / match refs by value in a Set, and
 * to key the per-pane geometry map the tiled layout publishes for keep-alive
 * overlay repositioning - e.g. `terminal:<id>` / `browser:<id>`).
 */
export function tabRefKey(ref: UnifiedTabRef): string {
	return `${ref.type}:${ref.id}`;
}
