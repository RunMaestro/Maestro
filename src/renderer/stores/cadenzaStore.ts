/**
 * cadenzaStore - Zustand store for cadenza views: small, agent-openable
 * panels that display or track what the user is working on.
 *
 * Fed by the CLI/web bridge (`remote:cadenza` -> useRemoteIntegration ->
 * applyCadenzaPayload). Presentational only; CadenzaLayer renders the list.
 * Usable outside React via useCadenzaStore.getState().
 */

import { create } from 'zustand';
import type {
	CadenzaColor,
	CadenzaViewType,
	CadenzaPayload,
	CadenzaDecisionOption,
} from '../../shared/cadenza-types';
import { selectSessionById, useSessionStore } from './sessionStore';
import { upsertById, scheduleFlashClear } from './concertoShared';

/** A resolved cadenza ready to render (defaults applied). */
export interface CadenzaView {
	id: string;
	viewType: CadenzaViewType;
	title: string;
	/** Live tracker text; updated in place via the `update` op. */
	body?: string;
	/** File path for the `file` view type. */
	path?: string;
	/** Choice buttons for the `decision` view type. */
	options?: CadenzaDecisionOption[];
	color: CadenzaColor;
	/** Owning agent, used to expand the cadenza into that agent's tab. */
	sessionId?: string;
	/** Resolved name of the owning agent, stamped on open for fleet attribution. */
	sourceAgent?: string;
	timestamp: number;
	/** Free-floating position, px from the top-left of the layer. Cascades on
	 *  open; the user drags the header to rearrange. */
	x?: number;
	y?: number;
}

/** Resolve an agent's display name from its session id (fleet attribution). */
function resolveAgentName(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	return selectSessionById(sessionId)(useSessionStore.getState())?.name;
}

export interface CadenzaStoreState {
	cadenzas: CadenzaView[];
	/** Id of the cadenza currently pulsing to catch the eye (from a chat chip), or null. */
	flashedId: string | null;
}

export interface CadenzaStoreActions {
	/** Create the cadenza, or replace it if one with the same id is open. */
	upsertCadenza: (view: CadenzaView) => void;
	/** Merge fields into an open cadenza (no-op if the id isn't open). */
	patchCadenza: (id: string, patch: Partial<Omit<CadenzaView, 'id'>>) => void;
	/** Remove a cadenza by id. */
	removeCadenza: (id: string) => void;
	/** Reposition a cadenza (free-floating drag). */
	moveCadenza: (id: string, x: number, y: number) => void;
	/** Remove all cadenzas. */
	clearCadenzas: () => void;
	/** Pulse the cadenza with this id for a moment (chat-chip "point"). */
	flashItem: (id: string) => void;
}

export type CadenzaStore = CadenzaStoreState & CadenzaStoreActions;

export const useCadenzaStore = create<CadenzaStore>()((set, get) => ({
	cadenzas: [],
	flashedId: null,

	upsertCadenza: (view) => set((s) => ({ cadenzas: upsertById(s.cadenzas, view) })),

	patchCadenza: (id, patch) =>
		set((s) => ({
			cadenzas: s.cadenzas.map((v) => (v.id === id ? { ...v, ...patch } : v)),
		})),

	removeCadenza: (id) => set((s) => ({ cadenzas: s.cadenzas.filter((v) => v.id !== id) })),

	moveCadenza: (id, x, y) =>
		set((s) => ({ cadenzas: s.cadenzas.map((v) => (v.id === id ? { ...v, x, y } : v)) })),

	clearCadenzas: () => set({ cadenzas: [] }),

	// Chat-chip "point": pulse the target cadenza for a moment.
	flashItem: (id) => {
		set({ flashedId: id });
		scheduleFlashClear(
			() => get().flashedId,
			() => set({ flashedId: null }),
			id
		);
	},
}));

/** Cascade offset so freshly-opened cadenzas don't stack on the same pixel. */
let cascadeIndex = 0;

/**
 * Apply an incoming cadenza payload from the bridge to the store, resolving
 * defaults on `open` and patching only the provided fields on `update`. Central
 * so the renderer bridge (useRemoteIntegration) stays a thin adapter.
 */
export function applyCadenzaPayload(p: CadenzaPayload): void {
	const store = useCadenzaStore.getState();

	if (p.op === 'close') {
		store.removeCadenza(p.id);
		return;
	}

	if (p.op === 'update') {
		// Patch only the fields the caller actually sent, so an update that only
		// changes `body` (the common "living tracker" case) leaves title/path intact.
		const patch: Partial<Omit<CadenzaView, 'id'>> = {};
		if (p.viewType !== undefined) patch.viewType = p.viewType;
		if (p.title !== undefined) patch.title = p.title;
		if (p.body !== undefined) patch.body = p.body;
		if (p.path !== undefined) patch.path = p.path;
		if (p.options !== undefined) patch.options = p.options;
		if (p.color !== undefined) patch.color = p.color;
		if (p.sessionId !== undefined) patch.sessionId = p.sessionId;
		store.patchCadenza(p.id, patch);
		return;
	}

	// op === 'open'. Preserve position if this id is already open (re-open keeps
	// where the user put it); otherwise cascade a fresh default.
	const existing = store.cadenzas.find((v) => v.id === p.id);
	const step = (cascadeIndex++ % 6) * 28;
	store.upsertCadenza({
		id: p.id,
		viewType: p.viewType ?? 'tracker',
		title: p.title ?? p.id,
		body: p.body,
		path: p.path,
		options: p.options,
		color: p.color ?? 'theme',
		sessionId: p.sessionId,
		// Prefer the name the main process resolved (the HUD window has no session
		// store); fall back to local resolution for the in-app layer.
		sourceAgent: p.sourceAgent ?? resolveAgentName(p.sessionId),
		timestamp: Date.now(),
		x: existing?.x ?? 24 + step,
		y: existing?.y ?? 96 + step,
	});
}
