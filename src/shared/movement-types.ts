/**
 * Movement types - the agent-driven, free-placement "living view" surface. Unlike
 * cadenzas (small floating cards) the movement is a roomy main-window view where
 * the agent positions items at (x, y) and each item renders a BlockView tree
 * (see components/BlockView). Shared across the CLI command, the main-process
 * bridge, the preload bridge, and the renderer store so every layer agrees on
 * one payload shape.
 *
 * The agent composes with awareness of the current layout via a `state` read
 * (MovementStateSnapshot), so it can place new items without overlapping.
 */

/** add = create/replace by id; update = merge fields; move = reposition; remove
 *  = delete by id; clear = remove all; progress = report an HTML Concerto's
 *  current design phase without mutating its window. */
export type MovementOp = 'add' | 'update' | 'move' | 'remove' | 'clear' | 'progress';

export const MOVEMENT_OPS: readonly MovementOp[] = [
	'add',
	'update',
	'move',
	'remove',
	'clear',
	'progress',
] as const;

export type ConcertoCreationPhase =
	| 'composing'
	| 'refining'
	| 'arranging'
	| 'reviewing'
	| 'testing';

export const CONCERTO_CREATION_PHASES: readonly ConcertoCreationPhase[] = [
	'composing',
	'refining',
	'arranging',
	'reviewing',
	'testing',
] as const;

/** Native BlockView data, or an isolated single-page HTML mockup. */
export type MovementViewType = 'view' | 'html';

export const MOVEMENT_VIEW_TYPES: readonly MovementViewType[] = ['view', 'html'] as const;

/**
 * A single movement operation sent across the bridge. `id` identifies the item for
 * update/move/remove; `body` is the item's BlockView spec as a JSON string.
 */
export interface MovementPayload {
	op: MovementOp;
	/** Stable item id (required for every op except `clear`). */
	id?: string;
	/** Defaults to `view`; `html` treats body as a complete HTML document. */
	viewType?: MovementViewType;
	/** Free-placement position, px from the movement top-left. */
	x?: number;
	y?: number;
	/** Optional fixed size; unset = sized to content up to a max. */
	width?: number;
	height?: number;
	/** Optional item title shown in its frame header. */
	title?: string;
	/** BlockView JSON for `view`, or a single-page document for `html`. */
	body?: string;
	/** Host-stamped plugin display name for a plugin-contributed view. */
	sourcePlugin?: string;
	/** Main-process document revision for an HTML frame. */
	revision?: number;
	/** Current design phase for `progress`; ignored by window mutation ops. */
	phase?: ConcertoCreationPhase;
}

/** One item's geometry as returned by the `state` read (for agent awareness). */
export interface MovementItemState {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** One-based stacking layer. Higher values render in front of lower values. */
	z: number;
	title?: string;
}

/** Snapshot of the movement returned to `maestro-cli movement state`. */
export interface MovementStateSnapshot {
	/** Non-minimized items only, ordered from back to front. */
	items: MovementItemState[];
	/** Maestro renderer viewport size in px, so the agent can place within bounds. */
	width: number;
	height: number;
	/** Whether the user has temporarily hidden the whole Concerto layer. */
	hidden: boolean;
}
