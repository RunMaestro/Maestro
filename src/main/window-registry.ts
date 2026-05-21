import { BrowserWindow, screen } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import type Store from 'electron-store';
import type { MultiWindowState, WindowState } from './stores/types';

export interface WindowRegistryEntry {
	browserWindow: BrowserWindow;
	sessionIds: string[];
	isMain: boolean;
}

export interface WindowRegistryCreateOptions extends BrowserWindowConstructorOptions {
	id?: string;
	sessionIds?: string[];
	isMain?: boolean;
}

export class WindowRegistry {
	private windows = new Map<string, WindowRegistryEntry>();
	private primaryWindowId: string | null = null;

	constructor(private windowStateStore?: Store<MultiWindowState>) {}

	setWindowStateStore(windowStateStore: Store<MultiWindowState>): void {
		this.windowStateStore = windowStateStore;
	}

	create(options: WindowRegistryCreateOptions = {}): WindowRegistryEntry {
		const { id, sessionIds = [], isMain, ...browserWindowOptions } = options;
		const browserWindow = new BrowserWindow(browserWindowOptions);
		const windowId = id ?? String(browserWindow.id);
		const shouldBeMain = isMain ?? this.primaryWindowId === null;

		if (this.windows.has(windowId)) {
			throw new Error(`Window already registered: ${windowId}`);
		}
		if (shouldBeMain && this.primaryWindowId !== null) {
			throw new Error(`Primary window already registered: ${this.primaryWindowId}`);
		}

		const entry: WindowRegistryEntry = {
			browserWindow,
			sessionIds: [],
			isMain: shouldBeMain,
		};

		this.windows.set(windowId, entry);
		if (shouldBeMain) {
			this.primaryWindowId = windowId;
		}
		this.setSessionsForWindow(windowId, sessionIds);

		return entry;
	}

	get(windowId: string): WindowRegistryEntry | undefined {
		return this.windows.get(windowId);
	}

	getAll(): WindowRegistryEntry[] {
		return Array.from(this.windows.values());
	}

	getEntries(): Array<[string, WindowRegistryEntry]> {
		return Array.from(this.windows.entries());
	}

	getWindowId(browserWindow: BrowserWindow): string | undefined {
		for (const [windowId, entry] of this.windows) {
			if (entry.browserWindow === browserWindow) {
				return windowId;
			}
		}

		return undefined;
	}

	getPrimary(): WindowRegistryEntry | undefined {
		return this.primaryWindowId ? this.windows.get(this.primaryWindowId) : undefined;
	}

	remove(windowId: string): void {
		const entry = this.windows.get(windowId);
		if (!entry) {
			return;
		}

		this.windows.delete(windowId);
		if (entry.isMain) {
			this.primaryWindowId = null;
		}
	}

	moveSessionsToPrimary(fromWindowId: string): { sessionIds: string[]; toWindowId: string } | null {
		const fromWindow = this.windows.get(fromWindowId);
		const primaryWindowId = this.primaryWindowId;
		const primaryWindow = primaryWindowId ? this.windows.get(primaryWindowId) : undefined;
		if (
			!fromWindow ||
			!primaryWindow ||
			!primaryWindowId ||
			fromWindow.isMain ||
			fromWindowId === primaryWindowId ||
			fromWindow.sessionIds.length === 0
		) {
			return null;
		}

		const movedSessionIds = [...fromWindow.sessionIds];
		fromWindow.sessionIds = [];
		for (const sessionId of movedSessionIds) {
			if (!primaryWindow.sessionIds.includes(sessionId)) {
				primaryWindow.sessionIds.push(sessionId);
			}
		}

		return {
			sessionIds: movedSessionIds,
			toWindowId: primaryWindowId,
		};
	}

	getWindowForSession(sessionId: string): string | undefined {
		for (const [windowId, entry] of this.windows) {
			if (entry.sessionIds.includes(sessionId)) {
				return windowId;
			}
		}

		return undefined;
	}

	setSessionsForWindow(windowId: string, sessionIds: string[]): void {
		const entry = this.windows.get(windowId);
		if (!entry) {
			throw new Error(`Window not registered: ${windowId}`);
		}

		const uniqueSessionIds = Array.from(new Set(sessionIds));
		for (const [otherWindowId, otherEntry] of this.windows) {
			if (otherWindowId === windowId) {
				continue;
			}
			otherEntry.sessionIds = otherEntry.sessionIds.filter(
				(sessionId) => !uniqueSessionIds.includes(sessionId)
			);
		}

		entry.sessionIds = uniqueSessionIds;
	}

	moveSession(sessionId: string, fromWindowId: string, toWindowId: string): void {
		const fromWindow = this.windows.get(fromWindowId);
		const toWindow = this.windows.get(toWindowId);
		if (!fromWindow) {
			throw new Error(`Source window not registered: ${fromWindowId}`);
		}
		if (!toWindow) {
			throw new Error(`Destination window not registered: ${toWindowId}`);
		}

		fromWindow.sessionIds = fromWindow.sessionIds.filter((id) => id !== sessionId);
		for (const [windowId, entry] of this.windows) {
			if (windowId === toWindowId || windowId === fromWindowId) {
				continue;
			}
			entry.sessionIds = entry.sessionIds.filter((id) => id !== sessionId);
		}

		if (!toWindow.sessionIds.includes(sessionId)) {
			toWindow.sessionIds.push(sessionId);
		}
	}

	saveWindowState(windowId: string): WindowState | null {
		if (!this.windowStateStore) {
			return null;
		}

		const entry = this.windows.get(windowId);
		if (!entry || entry.browserWindow.isDestroyed()) {
			return null;
		}

		const isMaximized = entry.browserWindow.isMaximized();
		const isFullScreen = entry.browserWindow.isFullScreen();
		const isMinimized = entry.browserWindow.isMinimized();
		const bounds = entry.browserWindow.getBounds();
		const display = screen.getDisplayMatching(bounds);
		const currentState = this.windowStateStore.store;
		const existingWindowState = currentState.windows.find(
			(windowState) => windowState.id === windowId
		);
		const nextWindowState: WindowState = {
			id: windowId,
			x: existingWindowState?.x ?? bounds.x,
			y: existingWindowState?.y ?? bounds.y,
			width: existingWindowState?.width ?? bounds.width,
			height: existingWindowState?.height ?? bounds.height,
			displayId: existingWindowState?.displayId ?? display.id,
			displayWorkArea: existingWindowState?.displayWorkArea ?? display.workArea,
			isMaximized,
			isFullScreen,
			sessionIds: entry.sessionIds,
			activeSessionId: existingWindowState?.activeSessionId ?? null,
			leftPanelCollapsed: existingWindowState?.leftPanelCollapsed ?? false,
			rightPanelCollapsed: existingWindowState?.rightPanelCollapsed ?? false,
		};

		if (!isMaximized && !isFullScreen && !isMinimized) {
			nextWindowState.x = bounds.x;
			nextWindowState.y = bounds.y;
			nextWindowState.width = bounds.width;
			nextWindowState.height = bounds.height;
			nextWindowState.displayId = display.id;
			nextWindowState.displayWorkArea = display.workArea;
		}

		const hasWindowState = currentState.windows.some((windowState) => windowState.id === windowId);
		this.windowStateStore.store = {
			...currentState,
			primaryWindowId: entry.isMain ? windowId : currentState.primaryWindowId,
			windows: hasWindowState
				? currentState.windows.map((windowState) =>
						windowState.id === windowId ? nextWindowState : windowState
					)
				: [...currentState.windows, nextWindowState],
		};

		return nextWindowState;
	}

	removeWindowState(windowId: string): void {
		if (!this.windowStateStore) {
			return;
		}

		const currentState = this.windowStateStore.store;
		if (currentState.primaryWindowId === windowId) {
			return;
		}

		const windows = currentState.windows.filter((windowState) => windowState.id !== windowId);
		if (windows.length === currentState.windows.length) {
			return;
		}

		this.windowStateStore.store = {
			...currentState,
			windows,
		};
	}
}
