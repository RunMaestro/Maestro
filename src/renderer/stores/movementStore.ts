/**
 * movementStore - Zustand store for the agent-driven movement: free-placed items,
 * each rendering a BlockView tree. Fed by the CLI/web bridge
 * (`remote:movement` -> useRemoteIntegration -> applyMovementPayload). Presentational
 * state only; MovementOverlay renders the items. Usable outside React via
 * useMovementStore.getState() (the bridge builds its `state` snapshot from here).
 */

import { create } from 'zustand';
import type { MovementPayload, MovementStateSnapshot } from '../../shared/movement-types';
import type { BlockSpec } from '../components/BlockView';
import { upsertById, scheduleFlashClear } from './concertoShared';

/** Default item width when the agent doesn't specify one (px). */
export const MOVEMENT_ITEM_DEFAULT_WIDTH = 500;

/** Maestro-owned actions are attached in-process and never parsed from agent payloads. */
export type MovementItemAction = {
	kind: 'open-git-review';
	sessionId: string;
	tabId?: string;
};

/** A resolved movement item ready to render (spec parsed, defaults applied). */
export interface MovementItem {
	id: string;
	x: number;
	y: number;
	/** Fixed width; defaults to MOVEMENT_ITEM_DEFAULT_WIDTH. */
	width: number;
	/** Optional fixed height; unset = sized to content. */
	height?: number;
	title?: string;
	/** Parsed BlockView spec. Parse failures become an error callout. */
	spec: BlockSpec;
	/** Optional allowlisted action for a Maestro-owned panel. */
	action?: MovementItemAction;
	/** Actual rendered height (px), measured by the overlay - so `movement state`
	 *  reports a real footprint even for auto-sized (unset `height`) panels. */
	measuredHeight?: number;
	timestamp: number;
}

/** Parse an agent-authored JSON spec string; on failure, a visible error block. */
function parseSpec(body: string | undefined): BlockSpec {
	if (!body) return { blocks: [] };
	try {
		return JSON.parse(body) as BlockSpec;
	} catch {
		return { blocks: [{ kind: 'callout', text: 'Invalid movement item JSON', color: 'error' }] };
	}
}

export interface MovementStoreState {
	items: MovementItem[];
	/** Movement viewport size (px), reported by the overlay for agent awareness. */
	viewportWidth: number;
	viewportHeight: number;
	/** User "stash" toggle: hide the whole overlay without removing items. */
	hidden: boolean;
	/** Id of the panel currently pulsing to catch the eye (from a chat chip), or null. */
	flashedId: string | null;
}

export interface MovementStoreActions {
	upsertItem: (item: MovementItem) => void;
	patchItem: (id: string, patch: Partial<Omit<MovementItem, 'id'>>) => void;
	moveItem: (id: string, x: number, y: number) => void;
	resizeItem: (id: string, width: number, height: number) => void;
	setMeasuredHeight: (id: string, height: number) => void;
	removeItem: (id: string) => void;
	clearItems: () => void;
	setViewport: (width: number, height: number) => void;
	setHidden: (hidden: boolean) => void;
	/** Un-stash the overlay and pulse the panel with this id (chat-chip "point"). */
	flashItem: (id: string) => void;
}

export type MovementStore = MovementStoreState & MovementStoreActions;

/** Smallest a user can drag a panel down to (px). */
const MIN_ITEM_WIDTH = 200;
const MIN_ITEM_HEIGHT = 120;

/** How much of a panel must stay inside the viewport so its header (the only
 *  drag handle + close button) remains reachable (px). */
const VISIBLE_MARGIN_X = 120;
const VISIBLE_MARGIN_Y = 40;

/** Clamp a panel position on both ends: never negative, and when the viewport
 *  size is known (non-zero), never so far right/down that the header is
 *  unreachable. An unknown viewport (0, before the overlay first reports)
 *  only clamps at zero. */
function clampPosition(
	x: number,
	y: number,
	viewportWidth: number,
	viewportHeight: number
): { x: number; y: number } {
	const maxX = viewportWidth > 0 ? Math.max(0, viewportWidth - VISIBLE_MARGIN_X) : Infinity;
	const maxY = viewportHeight > 0 ? Math.max(0, viewportHeight - VISIBLE_MARGIN_Y) : Infinity;
	return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

export const useMovementStore = create<MovementStore>()((set, get) => ({
	items: [],
	viewportWidth: 0,
	viewportHeight: 0,
	hidden: false,
	flashedId: null,

	upsertItem: (item) => set((s) => ({ items: upsertById(s.items, item) })),

	patchItem: (id, patch) =>
		set((s) => ({ items: s.items.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),

	moveItem: (id, x, y) =>
		set((s) => ({
			items: s.items.map((v) =>
				v.id === id ? { ...v, ...clampPosition(x, y, s.viewportWidth, s.viewportHeight) } : v
			),
		})),

	resizeItem: (id, width, height) =>
		set((s) => ({
			items: s.items.map((v) =>
				v.id === id
					? {
							...v,
							width: Math.max(MIN_ITEM_WIDTH, width),
							height: Math.max(MIN_ITEM_HEIGHT, height),
						}
					: v
			),
		})),

	// Store the overlay-measured height. Guarded (only on a >1px change) so the
	// ResizeObserver that feeds it can't cause a render loop.
	setMeasuredHeight: (id, height) =>
		set((s) => {
			const rounded = Math.round(height);
			let changed = false;
			const items = s.items.map((v) => {
				if (v.id !== id || Math.abs((v.measuredHeight ?? 0) - rounded) <= 1) return v;
				changed = true;
				return { ...v, measuredHeight: rounded };
			});
			return changed ? { items } : s;
		}),

	removeItem: (id) => set((s) => ({ items: s.items.filter((v) => v.id !== id) })),

	clearItems: () => set({ items: [] }),

	setViewport: (width, height) => set({ viewportWidth: width, viewportHeight: height }),

	setHidden: (hidden) => set({ hidden }),

	// Chat-chip "point": surface the overlay and pulse the target panel for a moment.
	flashItem: (id) => {
		set({ hidden: false, flashedId: id });
		scheduleFlashClear(
			() => get().flashedId,
			() => set({ flashedId: null }),
			id
		);
	},
}));

/** Cascade offset so items opened without a position don't stack on one pixel. */
let cascadeIndex = 0;

/** Apply an incoming movement payload from the bridge to the store. */
export function applyMovementPayload(p: MovementPayload): void {
	const store = useMovementStore.getState();

	if (p.op === 'clear') {
		store.clearItems();
		return;
	}
	if (!p.id) return;

	if (p.op === 'remove') {
		store.removeItem(p.id);
		return;
	}

	if (p.op === 'move') {
		if (typeof p.x === 'number' && typeof p.y === 'number') store.moveItem(p.id, p.x, p.y);
		return;
	}

	if (p.op === 'update') {
		const patch: Partial<Omit<MovementItem, 'id'>> = {};
		// Clamp on both ends like moveItem does, so an agent can't strand a panel
		// (and its only drag handle + close button) off ANY edge of the viewport.
		const target = store.items.find((v) => v.id === p.id);
		if (typeof p.x === 'number' || typeof p.y === 'number') {
			const clamped = clampPosition(
				typeof p.x === 'number' ? p.x : (target?.x ?? 0),
				typeof p.y === 'number' ? p.y : (target?.y ?? 0),
				store.viewportWidth,
				store.viewportHeight
			);
			if (typeof p.x === 'number') patch.x = clamped.x;
			if (typeof p.y === 'number') patch.y = clamped.y;
		}
		if (typeof p.width === 'number') patch.width = p.width;
		if (typeof p.height === 'number') patch.height = p.height;
		if (p.title !== undefined) patch.title = p.title;
		if (p.body !== undefined) patch.spec = parseSpec(p.body);
		store.patchItem(p.id, patch);
		return;
	}

	// op === 'add'. Preserve position if the id already exists; else cascade.
	const existing = store.items.find((v) => v.id === p.id);
	const step = (cascadeIndex++ % 6) * 32;
	// A newly-added panel should surface immediately. Updates intentionally do
	// not change `hidden`, so a live tracker cannot override the user's stash.
	store.setHidden(false);
	store.upsertItem({
		id: p.id,
		...clampPosition(
			p.x ?? existing?.x ?? 24 + step,
			p.y ?? existing?.y ?? 24 + step,
			store.viewportWidth,
			store.viewportHeight
		),
		width: p.width ?? existing?.width ?? MOVEMENT_ITEM_DEFAULT_WIDTH,
		height: p.height ?? existing?.height,
		title: p.title ?? existing?.title,
		spec: p.body !== undefined ? parseSpec(p.body) : (existing?.spec ?? { blocks: [] }),
		timestamp: Date.now(),
	});
}

/** Build the snapshot returned to `maestro-cli movement state` (agent awareness). */
export function getMovementSnapshot(): MovementStateSnapshot {
	const { items, viewportWidth, viewportHeight } = useMovementStore.getState();
	return {
		items: items.map((it) => ({
			id: it.id,
			x: Math.round(it.x),
			y: Math.round(it.y),
			width: Math.round(it.width),
			// Prefer the real rendered height; fall back to an explicit height.
			height: Math.round(it.measuredHeight ?? it.height ?? 0),
			title: it.title,
		})),
		width: viewportWidth,
		height: viewportHeight,
	};
}
