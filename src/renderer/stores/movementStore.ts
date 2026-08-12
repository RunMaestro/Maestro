/**
 * movementStore - Zustand store for the agent-driven movement: free-placed items,
 * each rendering a BlockView tree. Fed by the CLI/web bridge
 * (`remote:movement` -> useRemoteIntegration -> applyMovementPayload). Presentational
 * state only; MovementOverlay renders the items. Usable outside React via
 * useMovementStore.getState() (the bridge builds its `state` snapshot from here).
 */

import { create } from 'zustand';
import type {
	MovementPayload,
	MovementStateSnapshot,
	MovementViewType,
} from '../../shared/movement-types';
import type { BlockSpec } from '../components/BlockView';
import { sourcePluginFromViewId, upsertById, scheduleFlashClear } from './concertoShared';

/** Default item width when the agent doesn't specify one (px). */
export const MOVEMENT_ITEM_DEFAULT_WIDTH = 500;
/** HTML mockups open at an artifact-sized canvas unless geometry is explicit. */
export const MOVEMENT_HTML_DEFAULT_WIDTH = 880;
export const MOVEMENT_HTML_DEFAULT_HEIGHT = 560;
/** Smallest size a user can drag a panel down to (px). */
export const MOVEMENT_ITEM_MIN_WIDTH = 200;
export const MOVEMENT_ITEM_MIN_HEIGHT = 120;

export interface MovementItemBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A resolved movement item ready to render (spec parsed, defaults applied). */
export interface MovementItem {
	id: string;
	viewType: MovementViewType;
	/** A host-rendered shell is visible while authored HTML is still being prepared. */
	preparing: boolean;
	/** User-minimized panels stay mounted so interactive HTML state is preserved. */
	minimized: boolean;
	/** Stable launcher order, independent from the array's back-to-front layer order. */
	taskbarOrder: number;
	x: number;
	y: number;
	/** Fixed width; defaults to MOVEMENT_ITEM_DEFAULT_WIDTH. */
	width: number;
	/** Optional fixed height; unset = sized to content. */
	height?: number;
	title?: string;
	/** Parsed BlockView spec for native `view` items. */
	spec: BlockSpec;
	/** Complete single-page document for isolated `html` items. */
	html?: string;
	/** Host-stamped plugin display name (or legacy id inference) for header provenance. */
	sourcePlugin?: string;
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
	/** Recently user-closed items that a chat chip can reopen as a fresh view. */
	dismissedItems: MovementItem[];
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
	/** Atomically resize and reposition an item, including north/west edge drags. */
	resizeItem: (id: string, bounds: MovementItemBounds) => void;
	setMeasuredHeight: (id: string, height: number) => void;
	dismissItem: (id: string) => void;
	removeItem: (id: string) => void;
	clearItems: () => void;
	setViewport: (width: number, height: number) => void;
	setHidden: (hidden: boolean) => void;
	setItemMinimized: (id: string, minimized: boolean) => void;
	/** Move a recently dismissed item back into the live overlay. */
	restoreDismissedItem: (id: string, timestamp?: number) => boolean;
	/** Restore, un-stash, and move a panel above its peers without remounting it. */
	surfaceItem: (id: string) => void;
	/** Un-stash the overlay and pulse the panel with this id (chat-chip "point"). */
	flashItem: (id: string) => boolean;
}

export type MovementStore = MovementStoreState & MovementStoreActions;

/** True only while at least one Concerto is genuinely present on the stage. */
export function selectHasVisibleMovement(
	state: Pick<MovementStoreState, 'items' | 'hidden'>
): boolean {
	return !state.hidden && state.items.some((item) => !item.minimized);
}

/** How much of a panel must stay inside the viewport so its header (the only
 *  drag handle + close button) remains reachable (px). */
const VISIBLE_MARGIN_X = 120;
const VISIBLE_MARGIN_Y = 40;
/** Bound retained source documents while still allowing recent chat chips to reopen them. */
const MAX_DISMISSED_MOVEMENT_ITEMS = 12;

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
	dismissedItems: [],
	viewportWidth: 0,
	viewportHeight: 0,
	hidden: false,
	flashedId: null,

	upsertItem: (item) =>
		set((s) => ({
			items: upsertById(s.items, item),
			dismissedItems: s.dismissedItems.filter((dismissed) => dismissed.id !== item.id),
		})),

	patchItem: (id, patch) =>
		set((s) => ({
			items: s.items.map((v) => (v.id === id ? { ...v, ...patch } : v)),
			dismissedItems: s.dismissedItems.map((v) => (v.id === id ? { ...v, ...patch } : v)),
		})),

	moveItem: (id, x, y) =>
		set((s) => ({
			items: s.items.map((v) =>
				v.id === id ? { ...v, ...clampPosition(x, y, s.viewportWidth, s.viewportHeight) } : v
			),
		})),

	resizeItem: (id, bounds) =>
		set((s) => ({
			items: s.items.map((v) =>
				v.id === id
					? {
							...v,
							...clampPosition(bounds.x, bounds.y, s.viewportWidth, s.viewportHeight),
							width: Math.max(MOVEMENT_ITEM_MIN_WIDTH, bounds.width),
							height: Math.max(MOVEMENT_ITEM_MIN_HEIGHT, bounds.height),
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

	dismissItem: (id) =>
		set((s) => {
			const item = s.items.find((candidate) => candidate.id === id);
			if (!item) return s;
			const dismissedItems = [
				...s.dismissedItems.filter((dismissed) => dismissed.id !== id),
				item,
			].slice(-MAX_DISMISSED_MOVEMENT_ITEMS);
			return { items: s.items.filter((candidate) => candidate.id !== id), dismissedItems };
		}),

	removeItem: (id) =>
		set((s) => ({
			items: s.items.filter((v) => v.id !== id),
			dismissedItems: s.dismissedItems.filter((v) => v.id !== id),
		})),

	clearItems: () => set({ items: [], dismissedItems: [] }),

	setViewport: (width, height) => set({ viewportWidth: width, viewportHeight: height }),

	setHidden: (hidden) => set({ hidden }),

	setItemMinimized: (id, minimized) =>
		set((s) => {
			let changed = false;
			const items = s.items.map((item) => {
				if (item.id !== id || item.minimized === minimized) return item;
				changed = true;
				return { ...item, minimized };
			});
			return changed ? { items } : s;
		}),

	restoreDismissedItem: (id, timestamp) => {
		let restored = false;
		set((s) => {
			const item = s.dismissedItems.find((candidate) => candidate.id === id);
			if (!item) return s;
			restored = true;
			return {
				hidden: false,
				items: [
					...s.items.filter((candidate) => candidate.id !== id),
					{ ...item, minimized: false, timestamp: timestamp ?? item.timestamp },
				],
				dismissedItems: s.dismissedItems.filter((candidate) => candidate.id !== id),
			};
		});
		return restored;
	},

	surfaceItem: (id) =>
		set((s) => {
			const index = s.items.findIndex((item) => item.id === id);
			if (index < 0) return s;
			const target = s.items[index];
			const surfaced = target.minimized ? { ...target, minimized: false } : target;
			if (index === s.items.length - 1) {
				if (!s.hidden && surfaced === target) return s;
				return { hidden: false, items: [...s.items.slice(0, index), surfaced] };
			}
			return {
				hidden: false,
				items: [...s.items.slice(0, index), ...s.items.slice(index + 1), surfaced],
			};
		}),

	// Chat-chip "point": surface the overlay and pulse the target panel for a moment.
	flashItem: (id) => {
		if (!get().items.some((item) => item.id === id)) return false;
		get().surfaceItem(id);
		set({ flashedId: id });
		scheduleFlashClear(
			() => get().flashedId,
			() => set({ flashedId: null }),
			id
		);
		return true;
	},
}));

/** Cascade offset so items opened without a position don't stack on one pixel. */
let cascadeIndex = 0;

/** Apply an incoming movement payload from the bridge to the store. */
export function applyMovementPayload(p: MovementPayload): void {
	const store = useMovementStore.getState();

	if (p.op === 'progress') return;

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
		const target =
			store.items.find((v) => v.id === p.id) ?? store.dismissedItems.find((v) => v.id === p.id);
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
		const isBodylessHtmlTransition =
			p.viewType === 'html' && target?.viewType !== 'html' && p.body === undefined;
		if (p.viewType !== undefined && !isBodylessHtmlTransition) patch.viewType = p.viewType;
		const targetViewType = isBodylessHtmlTransition
			? (target?.viewType ?? 'view')
			: (p.viewType ?? target?.viewType ?? 'view');
		if (p.body !== undefined) {
			if (targetViewType === 'html') patch.html = p.body;
			else patch.spec = parseSpec(p.body);
			patch.preparing = false;
			patch.timestamp =
				targetViewType === 'html' && p.revision !== undefined
					? p.revision
					: Math.max(Date.now(), (target?.timestamp ?? 0) + 1);
		}
		store.patchItem(p.id, patch);
		return;
	}

	// `begin` reserves a host-rendered HTML frame. `add` fills that same frame
	// once authored content exists. Preserve position if the id already exists;
	// otherwise use the normal cascade.
	const liveExisting = store.items.find((v) => v.id === p.id);
	const existing = liveExisting ?? store.dismissedItems.find((v) => v.id === p.id);
	const isBegin = p.op === 'begin';
	const viewType = isBegin ? 'html' : (p.viewType ?? existing?.viewType ?? 'view');
	const step = (cascadeIndex++ % 6) * 32;
	// A newly-added panel should surface immediately. Updates intentionally do
	// not change `hidden`, so a live tracker cannot override the user's stash.
	store.setHidden(false);
	const taskbarOrder =
		existing?.taskbarOrder ??
		Math.max(
			-1,
			...store.items.map((item) => item.taskbarOrder),
			...store.dismissedItems.map((item) => item.taskbarOrder)
		) + 1;
	store.upsertItem({
		id: p.id,
		viewType,
		preparing: isBegin,
		minimized: isBegin ? false : (existing?.minimized ?? false),
		taskbarOrder,
		...clampPosition(
			p.x ?? existing?.x ?? 24 + step,
			p.y ?? existing?.y ?? 24 + step,
			store.viewportWidth,
			store.viewportHeight
		),
		width:
			p.width ??
			existing?.width ??
			(viewType === 'html' ? MOVEMENT_HTML_DEFAULT_WIDTH : MOVEMENT_ITEM_DEFAULT_WIDTH),
		height:
			p.height ??
			existing?.height ??
			(viewType === 'html' ? MOVEMENT_HTML_DEFAULT_HEIGHT : undefined),
		title: p.title ?? existing?.title,
		spec:
			viewType === 'view' && p.body !== undefined
				? parseSpec(p.body)
				: (existing?.spec ?? { blocks: [] }),
		html:
			viewType === 'html' && p.body !== undefined
				? p.body
				: isBegin
					? liveExisting?.html
					: existing?.html,
		sourcePlugin: p.sourcePlugin ?? existing?.sourcePlugin ?? sourcePluginFromViewId(p.id),
		timestamp: isBegin
			? (liveExisting?.timestamp ?? Date.now())
			: viewType === 'html' && p.revision !== undefined
				? p.revision
				: Date.now(),
	});
	if (isBegin) store.surfaceItem(p.id);
}

/** Build the snapshot returned to `maestro-cli movement state` (agent awareness). */
export function getMovementSnapshot(): MovementStateSnapshot {
	const { items, viewportWidth, viewportHeight, hidden } = useMovementStore.getState();
	return {
		items: items.flatMap((it, index) =>
			it.minimized
				? []
				: [
						{
							id: it.id,
							x: Math.round(it.x),
							y: Math.round(it.y),
							width: Math.round(it.width),
							// Prefer the real rendered height; fall back to an explicit height.
							height: Math.round(it.measuredHeight ?? it.height ?? 0),
							z: index + 1,
							title: it.title,
						},
					]
		),
		width: viewportWidth,
		height: viewportHeight,
		hidden,
	};
}
