// src/main/window-registry.ts

import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import { isPointInWindowBounds, type WindowPanelState } from '../shared/window-types';
import { generateUUID } from '../shared/uuid';
import { isSameTabRef } from '../shared/unifiedTabRef';
import type { TabWindowInfo, TabWindowTabRef } from '../shared/tabWindowTypes';

/**
 * The kind of a registered window. `app` windows own agents (sessions) and take
 * part in all the multi-window machinery (session moves, persistence, the "Move
 * to Window" menu, telemetry). Special kinds like `cadenza-hud` are host-owned
 * feature windows that own no sessions (the cadenza HUD, the Quick Chat window);
 * the multi-window consumers skip them. A `tab` window holds tabs popped out of
 * ONE agent's app window (Tab Windows). It never owns that agent: the agent's
 * owner stays the app window that holds it in `sessionIds` (Tab Windows D1).
 */
export type WindowKind = 'app' | 'cadenza-hud' | 'quick-chat' | 'tab';

/**
 * A single window tracked by the registry. `sessionIds` are agent IDs (what
 * Maestro surfaces to users as "sessions") owned by this window. Exactly one
 * registered window is the primary one (`isMain`).
 *
 * `leftPanelCollapsed` / `rightPanelCollapsed` are the window's per-window UI
 * state (its side-panel collapse). The registry is the per-session source of
 * truth for window state this phase, so it holds these alongside ownership; the
 * renderer reads them via `windows:getState` and writes them via
 * `windows:setPanelState`. They default to expanded (`false`).
 */
export interface RegisteredWindow {
	id: string;
	browserWindow: BrowserWindow;
	sessionIds: string[];
	isMain: boolean;
	/** Window role; `app` unless a feature window (e.g. the cadenza HUD). */
	kind: WindowKind;
	leftPanelCollapsed: boolean;
	rightPanelCollapsed: boolean;
	/** User-assigned window name; undefined for the default generic label. */
	name?: string;
	/**
	 * `tab` kind only: the one agent whose tabs this window holds (TW-4, TW-5).
	 * Kept apart from `sessionIds`, which stays empty, so a tab window is never
	 * mistaken for the agent's owner.
	 */
	agentId?: string;
	/** `tab` kind only: the popped tabs, in the tab window's strip order. */
	tabRefs?: TabWindowTabRef[];
	/** `tab` kind only: the tab shown, or null while the window holds no tab. */
	activeTabRef?: TabWindowTabRef | null;
}

/** The kinds of mutations the registry emits a change signal for. */
export type WindowRegistryChangeType =
	| 'created'
	| 'removed'
	| 'sessions-changed'
	| 'session-moved'
	| 'name-changed'
	| 'panel-changed'
	| 'tab-window-changed';

/**
 * Payload describing a registry mutation. Persistence (the window-state store)
 * and renderers can react to these to keep their view of window<->session
 * ownership in sync.
 */
export interface WindowRegistryChange {
	type: WindowRegistryChangeType;
	windowId?: string;
	sessionId?: string;
	fromWindowId?: string;
	toWindowId?: string;
	/** `tab-window-changed` only: the agent whose tab window changed. */
	agentId?: string;
}

/** True when `entry` is a tab window (and so carries the tab fields). */
function isTabWindowEntry(
	entry: RegisteredWindow | undefined
): entry is RegisteredWindow & { agentId: string; tabRefs: TabWindowTabRef[] } {
	return entry?.kind === 'tab' && typeof entry.agentId === 'string' && Array.isArray(entry.tabRefs);
}

/** The registry view of a tab window, or null for any other kind. */
export function toTabWindowInfo(entry: RegisteredWindow): TabWindowInfo | null {
	if (!isTabWindowEntry(entry)) return null;
	return {
		windowId: entry.id,
		agentId: entry.agentId,
		tabRefs: entry.tabRefs.map((ref) => ({ ...ref })),
		activeTabRef: entry.activeTabRef ? { ...entry.activeTabRef } : null,
	};
}

/** `refs` with later duplicates of the same tab dropped, order kept. */
function dedupeTabRefs(refs: readonly TabWindowTabRef[]): TabWindowTabRef[] {
	const out: TabWindowTabRef[] = [];
	for (const ref of refs) {
		if (!out.some((kept) => isSameTabRef(kept, ref))) out.push({ type: ref.type, id: ref.id });
	}
	return out;
}

/** A single move request awaiting application in {@link WindowRegistry.moveSession}. */
interface QueuedMove {
	sessionId: string;
	fromWindowId: string;
	toWindowId: string;
}

/**
 * WindowRegistry is the single source of truth for window<->session ownership.
 *
 * It tracks every open `BrowserWindow` and which agents (sessions) live in each.
 * The registry does NOT build windows - `window-manager.ts` constructs the
 * actual `BrowserWindow` (with all its security hardening) and hands it here to
 * be tracked. Listeners subscribe via {@link onChange} (or the underlying
 * `EventEmitter` `'change'` event) to react to session moves and window
 * open/close.
 */
export class WindowRegistry extends EventEmitter {
	private readonly windows = new Map<string, RegisteredWindow>();

	/**
	 * Pending session moves, drained FIFO by {@link drainMoveQueue}. A move is
	 * always enqueued and drained synchronously, but routing through the queue
	 * serializes the mutations: if applying one move emits a `session-moved`
	 * change whose listener (synchronously) requests another move, that nested
	 * move is queued and applied only after the current one has fully settled,
	 * never interleaving into the ownership map mid-mutation.
	 */
	private readonly moveQueue: QueuedMove[] = [];

	/** True while {@link drainMoveQueue} is applying moves (re-entrancy guard). */
	private drainingMoves = false;

	/**
	 * Register a window. The `BrowserWindow` itself is built by
	 * `window-manager.ts`; the registry only tracks it. Generates an ID with
	 * {@link generateUUID} when one is not supplied. Returns the window ID.
	 *
	 * A `tab` window needs `agentId` and may carry its first `tabRefs` and
	 * `activeTabRef` (a restore passes all three). It never owns sessions, so
	 * `sessionIds` and `isMain` are ignored for it. Throws when `agentId` is
	 * missing or the agent already has a tab window (TW-4): the caller looks one
	 * up with {@link getTabWindowForAgent} first and adds the tab to it.
	 */
	create(options: {
		windowId?: string;
		sessionIds?: string[];
		isMain?: boolean;
		kind?: WindowKind;
		browserWindow: BrowserWindow;
		name?: string;
		leftPanelCollapsed?: boolean;
		rightPanelCollapsed?: boolean;
		agentId?: string;
		tabRefs?: TabWindowTabRef[];
		activeTabRef?: TabWindowTabRef | null;
	}): string {
		const id = options.windowId ?? generateUUID();
		const kind = options.kind ?? 'app';
		const entry: RegisteredWindow = {
			id,
			browserWindow: options.browserWindow,
			sessionIds: kind === 'tab' ? [] : [...(options.sessionIds ?? [])],
			isMain: kind === 'tab' ? false : (options.isMain ?? false),
			kind,
			// Default to expanded for a fresh window; a restore passes the saved
			// per-window collapse state so panels come back as the user left them.
			leftPanelCollapsed: options.leftPanelCollapsed ?? false,
			rightPanelCollapsed: options.rightPanelCollapsed ?? false,
			name: options.name,
		};
		if (kind === 'tab') {
			const { agentId } = options;
			if (!agentId) throw new Error('A tab window needs an agentId');
			if (this.getTabWindowForAgent(agentId)) {
				throw new Error(`Agent ${agentId} already has a tab window`);
			}
			const tabRefs = dedupeTabRefs(options.tabRefs ?? []);
			const requested = options.activeTabRef;
			entry.agentId = agentId;
			entry.tabRefs = tabRefs;
			entry.activeTabRef =
				(requested && tabRefs.find((ref) => isSameTabRef(ref, requested))) ?? tabRefs[0] ?? null;
		}
		this.windows.set(id, entry);
		this.emitChange({ type: 'created', windowId: id });
		// `created` never reaches a renderer. A new tab window already holds its
		// first tabs, so the owner must hear it as a tab window change, or it keeps
		// the tab in its strip and never starts the patch stream.
		if (isTabWindowEntry(entry) && entry.tabRefs.length > 0) this.emitTabWindowChange(entry);
		return id;
	}

	/** Look up a single registered window by ID. */
	get(windowId: string): RegisteredWindow | undefined {
		return this.windows.get(windowId);
	}

	/** Every registered window, in insertion order. */
	getAll(): RegisteredWindow[] {
		return [...this.windows.values()];
	}

	/**
	 * Only the session-owning `app` windows - the set the multi-window machinery
	 * (persistence, "Move to Window", telemetry, empty-window auto-close) should
	 * act on. Feature windows like the cadenza HUD are excluded.
	 */
	getAppWindows(): RegisteredWindow[] {
		return [...this.windows.values()].filter((w) => w.kind === 'app');
	}

	/** The first registered window of a given kind, if any (e.g. the cadenza HUD). */
	getByKind(kind: WindowKind): RegisteredWindow | undefined {
		for (const entry of this.windows.values()) {
			if (entry.kind === kind) return entry;
		}
		return undefined;
	}

	/** Every tab window, in insertion order. */
	getTabWindows(): RegisteredWindow[] {
		return [...this.windows.values()].filter((w) => w.kind === 'tab');
	}

	/** The agent's one tab window (TW-4), if it has one. */
	getTabWindowForAgent(agentId: string): RegisteredWindow | undefined {
		for (const entry of this.windows.values()) {
			if (isTabWindowEntry(entry) && entry.agentId === agentId) return entry;
		}
		return undefined;
	}

	/**
	 * Add one of `agentId`'s tabs to the tab window `windowId`, at the end of its
	 * strip. Refuses (returns false, emits nothing) when the window is not a tab
	 * window or belongs to another agent (TW-5). A tab already in the window is
	 * not added twice. `activate` (default true) makes it the shown tab. Emits
	 * `tab-window-changed` when anything changed.
	 */
	addTabToTabWindow(
		windowId: string,
		agentId: string,
		tabRef: TabWindowTabRef,
		{ activate = true }: { activate?: boolean } = {}
	): boolean {
		const entry = this.windows.get(windowId);
		if (!isTabWindowEntry(entry) || entry.agentId !== agentId) return false;
		let existing = entry.tabRefs.find((ref) => isSameTabRef(ref, tabRef));
		let changed = false;
		if (!existing) {
			existing = { type: tabRef.type, id: tabRef.id };
			entry.tabRefs.push(existing);
			changed = true;
		}
		if ((activate || !entry.activeTabRef) && entry.activeTabRef !== existing) {
			entry.activeTabRef = existing;
			changed = true;
		}
		if (changed) this.emitTabWindowChange(entry);
		return true;
	}

	/**
	 * Take a tab out of the tab window `windowId` (dock, close, or a tab that no
	 * longer exists). When it was the shown tab, the tab now at its index is
	 * shown, else the one before it, else none. Returns false (emits nothing)
	 * when the window is not a tab window or does not hold the tab. The window
	 * itself stays registered; closing an emptied tab window is the window
	 * manager's job.
	 */
	removeTabFromTabWindow(windowId: string, tabRef: TabWindowTabRef): boolean {
		const entry = this.windows.get(windowId);
		if (!isTabWindowEntry(entry)) return false;
		const index = entry.tabRefs.findIndex((ref) => isSameTabRef(ref, tabRef));
		if (index === -1) return false;
		const [removed] = entry.tabRefs.splice(index, 1);
		if (entry.activeTabRef === removed) {
			entry.activeTabRef = entry.tabRefs[index] ?? entry.tabRefs[index - 1] ?? null;
		}
		this.emitTabWindowChange(entry);
		return true;
	}

	/**
	 * Show `tabRef` in the tab window `windowId`. Returns false when the window is
	 * not a tab window or does not hold the tab. Emits `tab-window-changed` only
	 * when the shown tab actually changed.
	 */
	setTabWindowActiveTab(windowId: string, tabRef: TabWindowTabRef): boolean {
		const entry = this.windows.get(windowId);
		if (!isTabWindowEntry(entry)) return false;
		const target = entry.tabRefs.find((ref) => isSameTabRef(ref, tabRef));
		if (!target) return false;
		if (entry.activeTabRef !== target) {
			entry.activeTabRef = target;
			this.emitTabWindowChange(entry);
		}
		return true;
	}

	/**
	 * Put the strip of the tab window `windowId` in the order `tabRefs` names.
	 * Only the tab window's own order changes: each tab keeps its dock slot in
	 * the agent's `unifiedTabOrder` (TW-8). Refuses (returns false, emits
	 * nothing) when the window is not a tab window or `tabRefs` is not exactly
	 * the tabs it holds: a reorder never adds or drops a tab. Emits
	 * `tab-window-changed` only when the order actually changed.
	 */
	setTabWindowTabOrder(windowId: string, tabRefs: readonly TabWindowTabRef[]): boolean {
		const entry = this.windows.get(windowId);
		if (!isTabWindowEntry(entry)) return false;
		if (tabRefs.length !== entry.tabRefs.length) return false;
		const ordered: TabWindowTabRef[] = [];
		for (const ref of tabRefs) {
			const held = entry.tabRefs.find((candidate) => isSameTabRef(candidate, ref));
			if (!held || ordered.includes(held)) return false;
			ordered.push(held);
		}
		if (ordered.every((ref, index) => ref === entry.tabRefs[index])) return true;
		entry.tabRefs = ordered;
		this.emitTabWindowChange(entry);
		return true;
	}

	/** The primary (`isMain`) window, if one is registered. */
	getPrimary(): RegisteredWindow | undefined {
		for (const entry of this.windows.values()) {
			if (entry.isMain) return entry;
		}
		return undefined;
	}

	/** Stop tracking a window (e.g. after it is closed). */
	remove(windowId: string): void {
		if (this.windows.delete(windowId)) {
			this.emitChange({ type: 'removed', windowId });
		}
	}

	/** The ID of the window that owns `sessionId`, or `null` if none does. */
	getWindowForSession(sessionId: string): string | null {
		for (const entry of this.windows.values()) {
			if (entry.sessionIds.includes(sessionId)) return entry.id;
		}
		return null;
	}

	/**
	 * The app window that owns `agentId` right now: the window holding it in
	 * `sessionIds`, else the primary (whose catch-all shows every agent no other
	 * window claims). Read fresh on every Tab Windows relay message, so an agent
	 * moved with Move to Window keeps working (D7).
	 */
	getOwnerWindowForAgent(agentId: string): RegisteredWindow | undefined {
		const ownerId = this.getWindowForSession(agentId);
		return (ownerId ? this.windows.get(ownerId) : undefined) ?? this.getPrimary();
	}

	/** Replace the full set of sessions owned by a window. No-op if unknown. */
	setSessionsForWindow(windowId: string, sessionIds: string[]): void {
		const entry = this.windows.get(windowId);
		// Only app windows own agents (Tab Windows D1).
		if (!entry || entry.kind !== 'app') return;
		entry.sessionIds = [...sessionIds];
		this.emitChange({ type: 'sessions-changed', windowId });
	}

	/**
	 * Update a window's per-window panel-collapse UI state. Only the provided
	 * fields are changed (partial merge); a `false`/`true` value is applied, an
	 * omitted field is left untouched. No-op if the window is unknown.
	 *
	 * Emits `panel-changed` when a value actually changed so the persistence layer
	 * saves it to disk (a panel toggle triggers no window move/resize, so nothing
	 * else would). `panel-changed` is deliberately NOT forwarded by
	 * `wireWindowRegistryBroadcast` - panel collapse is window-local UI that other
	 * windows' renderers must not react to (that would fight their own state).
	 * Only app windows have side panels; any other kind is a no-op.
	 */
	setPanelState(windowId: string, panel: Partial<WindowPanelState>): void {
		const entry = this.windows.get(windowId);
		if (!entry || entry.kind !== 'app') return;
		let changed = false;
		if (
			panel.leftPanelCollapsed !== undefined &&
			entry.leftPanelCollapsed !== panel.leftPanelCollapsed
		) {
			entry.leftPanelCollapsed = panel.leftPanelCollapsed;
			changed = true;
		}
		if (
			panel.rightPanelCollapsed !== undefined &&
			entry.rightPanelCollapsed !== panel.rightPanelCollapsed
		) {
			entry.rightPanelCollapsed = panel.rightPanelCollapsed;
			changed = true;
		}
		if (changed) this.emitChange({ type: 'panel-changed', windowId });
	}

	/**
	 * Set (or clear) a window's user-assigned name. Pass an empty/whitespace name
	 * to clear it back to the default generic label. Emits `name-changed` so the
	 * broadcast forwards it to every renderer (their Left Bar / palette labels
	 * refresh) and the persistence layer saves the new name. No-op if unknown or
	 * not an app window (a tab window is titled after its agent, TW-3).
	 */
	setName(windowId: string, name: string): void {
		const entry = this.windows.get(windowId);
		if (!entry || entry.kind !== 'app') return;
		const trimmed = name.trim();
		const next = trimmed.length > 0 ? trimmed : undefined;
		if (entry.name === next) return;
		entry.name = next;
		this.emitChange({ type: 'name-changed', windowId });
	}

	/**
	 * Move a session into another window. Enqueues the move and drains the queue
	 * synchronously (see {@link moveQueue}); the queue exists only to serialize
	 * moves so a re-entrant move from a `session-moved` listener cannot mutate the
	 * ownership map mid-update. No-op if either named window is unknown, or the
	 * destination is not an app window.
	 *
	 * Each applied move enforces the single-ownership invariant: the session is
	 * stripped from EVERY window before being appended to the destination. This
	 * keeps rapid, overlapping drags consistent - a second move whose
	 * `fromWindowId` is stale (the first move already relocated the agent) would,
	 * if it only stripped the named source, leave the agent owned by two windows.
	 * Removing it everywhere makes any interleaving converge to exactly one owner.
	 */
	moveSession(sessionId: string, fromWindowId: string, toWindowId: string): void {
		this.moveQueue.push({ sessionId, fromWindowId, toWindowId });
		this.drainMoveQueue();
	}

	/** Apply every queued move in order, guarding against re-entrant draining. */
	private drainMoveQueue(): void {
		if (this.drainingMoves) return;
		this.drainingMoves = true;
		try {
			let move: QueuedMove | undefined;
			while ((move = this.moveQueue.shift()) !== undefined) {
				this.applyMove(move);
			}
		} finally {
			this.drainingMoves = false;
		}
	}

	/** Mutate the ownership map for a single move and emit its change signal. */
	private applyMove({ sessionId, fromWindowId, toWindowId }: QueuedMove): void {
		const from = this.windows.get(fromWindowId);
		const to = this.windows.get(toWindowId);
		// Only an app window can become an agent's owner (Tab Windows D1).
		if (!from || !to || to.kind !== 'app') return;
		// Single-ownership invariant: drop the session from every window first, so a
		// stale fromWindowId can never leave it owned by two windows.
		this.stripSessionFromAllWindows(sessionId);
		to.sessionIds.push(sessionId);
		this.emitChange({
			type: 'session-moved',
			sessionId,
			fromWindowId,
			toWindowId,
		});
	}

	/**
	 * Remove `sessionId` from every window's owned set. The single-ownership
	 * helper behind both {@link applyMove} and {@link registerSession}: stripping
	 * everywhere before re-assigning guarantees an agent can never end up owned by
	 * two windows, no matter how stale the caller's view of current ownership is.
	 */
	private stripSessionFromAllWindows(sessionId: string): void {
		for (const entry of this.windows.values()) {
			const idx = entry.sessionIds.indexOf(sessionId);
			if (idx !== -1) entry.sessionIds.splice(idx, 1);
		}
	}

	/**
	 * Claim a freshly-created agent for `windowId`, recording that window as its
	 * sole owner. Used at spawn time so an agent created from a specific window is
	 * owned by it BEFORE its process starts emitting output - otherwise the
	 * primary window's catch-all would momentarily surface it (spawn flicker).
	 *
	 * Enforces the single-ownership invariant (the session is stripped from every
	 * other window first), so a duplicate registration can never leave the agent
	 * owned twice. No-op - and emits nothing - when the window is unknown, is not
	 * an app window, or is already the session's sole owner. Otherwise emits `sessions-changed` so
	 * persistence and the other windows' renderers pick up the new ownership.
	 */
	registerSession(windowId: string, sessionId: string): void {
		const target = this.windows.get(windowId);
		// Only an app window can claim an agent (Tab Windows D1).
		if (!target || target.kind !== 'app') return;
		const ownedElsewhere = this.getAll().some(
			(entry) => entry.id !== windowId && entry.sessionIds.includes(sessionId)
		);
		// Already the sole owner: nothing to change, so stay silent (no redundant
		// broadcast/persist churn on a re-register of an agent this window owns).
		if (!ownedElsewhere && target.sessionIds.includes(sessionId)) return;
		this.stripSessionFromAllWindows(sessionId);
		target.sessionIds.push(sessionId);
		this.emitChange({ type: 'sessions-changed', windowId });
	}

	/**
	 * Reclaim every session owned by `windowId` into the primary window so no
	 * agent is ever orphaned when a secondary window closes. Each session is moved
	 * through {@link moveSession}, preserving the single source of truth and the
	 * per-move `session-moved` change signal every renderer reacts to.
	 *
	 * Returns the IDs that were reclaimed and the primary window they moved into.
	 * `movedSessionIds` is empty (with the primary id still set) when the window
	 * owned nothing. Returns `null` when there is nothing to reclaim *into*: the
	 * window is unknown, it IS the primary, or no primary is registered. Callers
	 * use the count to decide whether to surface a "moved" toast.
	 */
	reclaimSessionsToPrimary(
		windowId: string
	): { movedSessionIds: string[]; primaryWindowId: string } | null {
		const source = this.windows.get(windowId);
		if (!source || source.isMain) return null;
		const primary = this.getPrimary();
		if (!primary) return null;
		const movedSessionIds = [...source.sessionIds];
		for (const sessionId of movedSessionIds) {
			this.moveSession(sessionId, windowId, primary.id);
		}
		return { movedSessionIds, primaryWindowId: primary.id };
	}

	/**
	 * The ID of the first registered window whose screen bounds contain the
	 * given point, or `null` if none do. Used by tab drag (Phase 3) to find the
	 * drop-target window. Destroyed windows are skipped.
	 */
	findWindowAtPoint(screenX: number, screenY: number): string | null {
		for (const entry of this.windows.values()) {
			if (entry.browserWindow.isDestroyed()) continue;
			if (isPointInWindowBounds({ x: screenX, y: screenY }, entry.browserWindow.getBounds())) {
				return entry.id;
			}
		}
		return null;
	}

	/**
	 * Subscribe to registry changes. Returns an unsubscribe function. Thin
	 * convenience wrapper over the `EventEmitter` `'change'` event.
	 */
	onChange(listener: (change: WindowRegistryChange) => void): () => void {
		this.on('change', listener);
		return () => this.off('change', listener);
	}

	private emitTabWindowChange(entry: RegisteredWindow & { agentId: string }): void {
		this.emitChange({ type: 'tab-window-changed', windowId: entry.id, agentId: entry.agentId });
	}

	private emitChange(change: WindowRegistryChange): void {
		this.emit('change', change);
	}
}
