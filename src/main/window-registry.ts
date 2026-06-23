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
}

/** The kinds of mutations the registry emits a change signal for. */
export type WindowRegistryChangeType = 'created' | 'removed' | 'sessions-changed' | 'session-moved';

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
	 * Register a window. The `BrowserWindow` itself is built by
	 * `window-manager.ts`; the registry only tracks it. Generates an ID with
	 * {@link generateUUID} when one is not supplied. Returns the window ID.
	 */
	create(options: {
		windowId?: string;
		sessionIds?: string[];
		isMain?: boolean;
		browserWindow: BrowserWindow;
	}): string {
		const id = options.windowId ?? generateUUID();
		this.windows.set(id, {
			id,
			browserWindow: options.browserWindow,
			sessionIds: [...(options.sessionIds ?? [])],
			isMain: options.isMain ?? false,
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
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
	 * omitted field is left untouched. No-op if the window is unknown. This emits
	 * no change signal - panel collapse is window-local UI that does not affect
	 * session ownership, the cross-window badges, or any other window's view.
	 */
	setPanelState(windowId: string, panel: Partial<WindowPanelState>): void {
		const entry = this.windows.get(windowId);
		if (!entry) return;
		if (panel.leftPanelCollapsed !== undefined) {
			entry.leftPanelCollapsed = panel.leftPanelCollapsed;
		}
		if (panel.rightPanelCollapsed !== undefined) {
			entry.rightPanelCollapsed = panel.rightPanelCollapsed;
		}
	}

	/**
	 * Move a session from one window to another. Removes it from the source
	 * window (if present) and appends it to the destination (avoiding
	 * duplicates). No-op if either window is unknown.
	 */
	moveSession(sessionId: string, fromWindowId: string, toWindowId: string): void {
		const from = this.windows.get(fromWindowId);
		const to = this.windows.get(toWindowId);
		if (!from || !to) return;
		from.sessionIds = from.sessionIds.filter((id) => id !== sessionId);
		if (!to.sessionIds.includes(sessionId)) {
			to.sessionIds.push(sessionId);
		}
		this.emitChange({
			type: 'session-moved',
			sessionId,
			fromWindowId,
			toWindowId,
		});
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
