// src/main/window-registry.ts

import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import { isPointInWindowBounds, type WindowPanelState } from '../shared/window-types';
import { generateUUID } from '../shared/uuid';

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
	leftPanelCollapsed: boolean;
	rightPanelCollapsed: boolean;
	/** User-assigned window name; undefined for the default generic label. */
	name?: string;
}

/** The kinds of mutations the registry emits a change signal for. */
export type WindowRegistryChangeType =
	| 'created'
	| 'removed'
	| 'sessions-changed'
	| 'session-moved'
	| 'name-changed'
	| 'panel-changed';

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
	 */
	create(options: {
		windowId?: string;
		sessionIds?: string[];
		isMain?: boolean;
		browserWindow: BrowserWindow;
		name?: string;
		leftPanelCollapsed?: boolean;
		rightPanelCollapsed?: boolean;
	}): string {
		const id = options.windowId ?? generateUUID();
		this.windows.set(id, {
			id,
			browserWindow: options.browserWindow,
			sessionIds: [...(options.sessionIds ?? [])],
			isMain: options.isMain ?? false,
			// Default to expanded for a fresh window; a restore passes the saved
			// per-window collapse state so panels come back as the user left them.
			leftPanelCollapsed: options.leftPanelCollapsed ?? false,
			rightPanelCollapsed: options.rightPanelCollapsed ?? false,
			name: options.name,
		});
		this.emitChange({ type: 'created', windowId: id });
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

	/** Replace the full set of sessions owned by a window. No-op if unknown. */
	setSessionsForWindow(windowId: string, sessionIds: string[]): void {
		const entry = this.windows.get(windowId);
		if (!entry) return;
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
	 */
	setPanelState(windowId: string, panel: Partial<WindowPanelState>): void {
		const entry = this.windows.get(windowId);
		if (!entry) return;
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
	 * refresh) and the persistence layer saves the new name. No-op if unknown.
	 */
	setName(windowId: string, name: string): void {
		const entry = this.windows.get(windowId);
		if (!entry) return;
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
	 * ownership map mid-update. No-op if either named window is unknown.
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
		if (!from || !to) return;
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
	 * owned twice. No-op - and emits nothing - when the window is unknown or it is
	 * already the session's sole owner. Otherwise emits `sessions-changed` so
	 * persistence and the other windows' renderers pick up the new ownership.
	 */
	registerSession(windowId: string, sessionId: string): void {
		const target = this.windows.get(windowId);
		if (!target) return;
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

	private emitChange(change: WindowRegistryChange): void {
		this.emit('change', change);
	}
}
