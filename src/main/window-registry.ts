import { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type Store from 'electron-store';

import { WINDOW_STATE_DEFAULTS } from './stores/defaults';
import type { WindowState as WindowStateStoreShape } from './stores/types';
import type {
	MultiWindowState as PersistedMultiWindowState,
	WindowState as PersistedWindowState,
	WindowSessionMovedEvent,
	WindowSessionsReassignedEvent,
} from '../shared/types/window';
import { logger } from './utils/logger';
import { isWebContentsAvailable } from './utils/safe-send';

export interface RegisteredWindow {
	browserWindow: BrowserWindow;
	sessionIds: string[];
	isMain: boolean;
}

export interface CreateWindowOptions {
	windowId?: string;
	browserWindowOptions: BrowserWindowConstructorOptions;
	isMain?: boolean;
	sessionIds?: string[];
}

interface SaveWindowStateOptions {
	immediate?: boolean;
}

interface WindowRegistryOptions {
	windowStateStore: Store<WindowStateStoreShape>;
	saveDebounceMs?: number;
}

export class WindowRegistry {
	private readonly windows = new Map<string, RegisteredWindow>();

	private readonly windowStateStore: Store<WindowStateStoreShape>;

	private readonly saveDebounceMs: number;

	private readonly pendingSaveTimers = new Map<string, NodeJS.Timeout>();

	private primaryWindowId: string | null = null;

	constructor(options: WindowRegistryOptions) {
		this.windowStateStore = options.windowStateStore;
		this.saveDebounceMs = options.saveDebounceMs ?? 250;
	}

	create(options: CreateWindowOptions): BrowserWindow {
		const {
			windowId,
			browserWindowOptions,
			isMain = false,
			sessionIds = [],
		} = options;

		const browserWindow = new BrowserWindow(browserWindowOptions);
		const resolvedWindowId = windowId ?? browserWindow.id.toString();

		if (this.windows.has(resolvedWindowId)) {
			throw new Error(`Window with id ${resolvedWindowId} already exists`);
		}

		const windowEntry: RegisteredWindow = {
			browserWindow,
			sessionIds: [...new Set(sessionIds)],
			isMain,
		};

		this.windows.set(resolvedWindowId, windowEntry);

		if (isMain) {
			this.primaryWindowId = resolvedWindowId;
		} else if (!this.primaryWindowId) {
			this.primaryWindowId = resolvedWindowId;
			windowEntry.isMain = true;
		}

		const scheduleWindowStateSave = () => {
			this.saveWindowState(resolvedWindowId);
		};

		browserWindow.on('move', scheduleWindowStateSave);
		browserWindow.on('resize', scheduleWindowStateSave);
		browserWindow.on('maximize', scheduleWindowStateSave);
		browserWindow.on('unmaximize', scheduleWindowStateSave);
		browserWindow.on('enter-full-screen', scheduleWindowStateSave);
		browserWindow.on('leave-full-screen', scheduleWindowStateSave);
		browserWindow.on('close', () => {
			this.saveWindowState(resolvedWindowId, { immediate: true });
			this.reassignSessionsToPrimary(resolvedWindowId);
		});

		browserWindow.on('closed', () => {
			this.remove(resolvedWindowId);
		});

		return browserWindow;
	}

	saveWindowState(windowId: string, options: SaveWindowStateOptions = {}): void {
		const entry = this.windows.get(windowId);

		if (!entry) {
			return;
		}

		if (options.immediate) {
			this.clearPendingSave(windowId);
			this.persistWindowState(entry, windowId);
			return;
		}

		const existingTimer = this.pendingSaveTimers.get(windowId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(() => {
			this.pendingSaveTimers.delete(windowId);
			this.persistWindowState(entry, windowId);
		}, this.saveDebounceMs);

		this.pendingSaveTimers.set(windowId, timer);
	}

	get(windowId: string): RegisteredWindow | undefined {
		return this.windows.get(windowId);
	}

	getAll(): Array<{ windowId: string } & RegisteredWindow> {
		return Array.from(this.windows.entries()).map(([id, entry]) => ({
			windowId: id,
			...entry,
		}));
	}

	getPrimary(): ({ windowId: string } & RegisteredWindow) | undefined {
		if (!this.primaryWindowId) {
			return undefined;
		}

		const entry = this.windows.get(this.primaryWindowId);

		if (!entry) {
			return undefined;
		}

		return {
			windowId: this.primaryWindowId,
			...entry,
		};
	}

	remove(windowId: string): void {
		const removed = this.windows.get(windowId);

		if (!removed) {
			return;
		}

		this.clearPendingSave(windowId);
		this.windows.delete(windowId);

		if (this.primaryWindowId === windowId) {
			this.primaryWindowId = null;
		}
	}

	getWindowForSession(sessionId: string): string | undefined {
		for (const [windowId, entry] of this.windows.entries()) {
			if (entry.sessionIds.includes(sessionId)) {
				return windowId;
			}
		}

		return undefined;
	}

	setSessionsForWindow(windowId: string, sessionIds: string[]): void {
		const entry = this.windows.get(windowId);

		if (!entry) {
			throw new Error(`Window with id ${windowId} not found`);
		}

		entry.sessionIds = [...new Set(sessionIds)];
	}

	moveSession(sessionId: string, fromWindowId: string, toWindowId: string): void {
		if (fromWindowId === toWindowId) {
			return;
		}

		const fromWindow = this.windows.get(fromWindowId);
		const toWindow = this.windows.get(toWindowId);

		if (!fromWindow || !toWindow) {
			throw new Error('Invalid window id provided for moving session');
		}

		fromWindow.sessionIds = fromWindow.sessionIds.filter((id) => id !== sessionId);

		if (!toWindow.sessionIds.includes(sessionId)) {
			toWindow.sessionIds = [...toWindow.sessionIds, sessionId];
		}
	}

	private reassignSessionsToPrimary(windowId: string): void {
		const closingEntry = this.windows.get(windowId);

		if (!closingEntry || closingEntry.isMain) {
			return;
		}

		const primaryEntry = this.getPrimary();
		if (!primaryEntry || primaryEntry.windowId === windowId) {
			return;
		}

		const sessionsToMove = [...closingEntry.sessionIds];

		if (sessionsToMove.length > 0) {
			const existingSessions = new Set(primaryEntry.sessionIds);
			for (const sessionId of sessionsToMove) {
				if (existingSessions.has(sessionId)) {
					continue;
				}
				primaryEntry.sessionIds.push(sessionId);
				existingSessions.add(sessionId);
			}
		}

		this.persistSessionsFromClosedWindow(
			windowId,
			primaryEntry.windowId,
			sessionsToMove
		);

		if (!sessionsToMove.length) {
			return;
		}

		for (const sessionId of sessionsToMove) {
			this.broadcastSessionMoved({
				sessionId,
				fromWindowId: windowId,
				toWindowId: primaryEntry.windowId,
			});
		}

		this.broadcastSessionsReassigned({
			fromWindowId: windowId,
			toWindowId: primaryEntry.windowId,
			sessionIds: sessionsToMove,
		});
	}

	private persistSessionsFromClosedWindow(
		closedWindowId: string,
		targetWindowId: string,
		movedSessionIds: string[]
	): void {
		try {
			const multiWindowState = getMultiWindowStateSnapshot(this.windowStateStore);
			const remainingWindows: PersistedWindowState[] = [];
			let targetState: PersistedWindowState | null = null;

			for (const windowState of multiWindowState.windows) {
				if (windowState.id === closedWindowId) {
					continue;
				}

				if (windowState.id === targetWindowId) {
					targetState = cloneWindowState(windowState);
					remainingWindows.push(targetState);
					continue;
				}

				remainingWindows.push(cloneWindowState(windowState));
			}

			if (!targetState) {
				targetState = createDefaultWindowStateSnapshot(targetWindowId);
				remainingWindows.push(targetState);
			}

			if (movedSessionIds.length > 0) {
				const uniqueSessions = new Set(targetState.sessionIds);
				for (const sessionId of movedSessionIds) {
					if (uniqueSessions.has(sessionId)) {
						continue;
					}
					targetState.sessionIds.push(sessionId);
					uniqueSessions.add(sessionId);
				}

				if (!targetState.activeSessionId) {
					targetState.activeSessionId = targetState.sessionIds[0] ?? null;
				}
			}

			const nextState: PersistedMultiWindowState = {
				primaryWindowId:
					multiWindowState.primaryWindowId === closedWindowId
						? targetWindowId
						: multiWindowState.primaryWindowId ?? targetWindowId,
				windows: remainingWindows.map(cloneWindowState),
			};

			this.windowStateStore.set('multiWindowState', nextState);
		} catch (error) {
			logger.warn('Failed to persist window close reassignment', 'WindowRegistry', {
				closedWindowId,
				targetWindowId,
				movedCount: movedSessionIds.length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private broadcastSessionMoved(event: WindowSessionMovedEvent): void {
		for (const { browserWindow } of this.getAll()) {
			if (!isWebContentsAvailable(browserWindow)) {
				continue;
			}
			browserWindow.webContents.send('windows:sessionMoved', event);
		}
	}

	private broadcastSessionsReassigned(event: WindowSessionsReassignedEvent): void {
		for (const { browserWindow } of this.getAll()) {
			if (!isWebContentsAvailable(browserWindow)) {
				continue;
			}
			browserWindow.webContents.send('windows:sessionsReassigned', event);
		}
	}

	private clearPendingSave(windowId: string): void {
		const timer = this.pendingSaveTimers.get(windowId);

		if (timer) {
			clearTimeout(timer);
			this.pendingSaveTimers.delete(windowId);
		}
	}

	private persistWindowState(entry: RegisteredWindow, windowId: string): void {
		try {
			const multiWindowState = getMultiWindowStateSnapshot(this.windowStateStore);
			const previousState = multiWindowState.windows.find((window) => window.id === windowId);
			const sessionIds = Array.from(new Set(entry.sessionIds));
			const baseState = previousState ?? createDefaultWindowStateSnapshot(windowId);
			const nextState: PersistedWindowState = {
				...baseState,
				id: windowId,
				sessionIds,
				activeSessionId: resolveActiveSessionId(baseState.activeSessionId, sessionIds),
			};

			if (!entry.browserWindow.isDestroyed()) {
				const isMaximized = entry.browserWindow.isMaximized();
				const isFullScreen = entry.browserWindow.isFullScreen();
				nextState.isMaximized = isMaximized;
				nextState.isFullScreen = isFullScreen;

				if (!isMaximized && !isFullScreen) {
					const bounds = entry.browserWindow.getBounds();
					nextState.x = bounds.x;
					nextState.y = bounds.y;
					nextState.width = bounds.width;
					nextState.height = bounds.height;
				}
			}

			const windowExists = multiWindowState.windows.some((window) => window.id === windowId);
			const nextWindows = windowExists
				? multiWindowState.windows.map((window) => (window.id === windowId ? nextState : window))
				: [...multiWindowState.windows, nextState];

			const nextPrimaryWindowId = entry.isMain
				? windowId
				: multiWindowState.primaryWindowId ?? windowId;

			this.windowStateStore.set('multiWindowState', {
				primaryWindowId: nextPrimaryWindowId,
				windows: nextWindows.map(cloneWindowState),
			});

			if (nextPrimaryWindowId === windowId) {
				syncLegacyWindowStateSnapshot(this.windowStateStore, nextState);
			}
		} catch (error) {
			logger.warn('Failed to persist window state', 'WindowRegistry', {
				windowId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function getMultiWindowStateSnapshot(
	windowStateStore: Store<WindowStateStoreShape>
): PersistedMultiWindowState {
	const fallback = WINDOW_STATE_DEFAULTS.multiWindowState ?? {
		primaryWindowId: 'primary',
		windows: [],
	};
	const persisted =
		windowStateStore.get('multiWindowState') ??
		windowStateStore.store.multiWindowState ??
		fallback;

	return {
		primaryWindowId:
			persisted.primaryWindowId ||
			fallback.primaryWindowId ||
			persisted.windows?.[0]?.id ||
			'primary',
		windows: (persisted.windows ?? fallback.windows ?? []).map(cloneWindowState),
	};
}

function cloneWindowState(windowState: PersistedWindowState): PersistedWindowState {
	return {
		...windowState,
		sessionIds: [...windowState.sessionIds],
	};
}

function createDefaultWindowStateSnapshot(windowId: string): PersistedWindowState {
	const template = WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0];
	return {
		id: windowId,
		x: template?.x,
		y: template?.y,
		width: template?.width ?? WINDOW_STATE_DEFAULTS.width,
		height: template?.height ?? WINDOW_STATE_DEFAULTS.height,
		isMaximized: template?.isMaximized ?? WINDOW_STATE_DEFAULTS.isMaximized,
		isFullScreen: template?.isFullScreen ?? WINDOW_STATE_DEFAULTS.isFullScreen,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: template?.leftPanelCollapsed ?? false,
		rightPanelCollapsed: template?.rightPanelCollapsed ?? false,
	};
}

function resolveActiveSessionId(
	previousActive: string | null,
	sessionIds: string[]
): string | null {
	if (previousActive && sessionIds.includes(previousActive)) {
		return previousActive;
	}
	return sessionIds[0] ?? null;
}

function syncLegacyWindowStateSnapshot(
	windowStateStore: Store<WindowStateStoreShape>,
	windowState: PersistedWindowState
): void {
	if (typeof windowState.x === 'number') {
		windowStateStore.set('x', windowState.x);
	}
	if (typeof windowState.y === 'number') {
		windowStateStore.set('y', windowState.y);
	}
	windowStateStore.set('width', windowState.width);
	windowStateStore.set('height', windowState.height);
	windowStateStore.set('isMaximized', windowState.isMaximized);
	windowStateStore.set('isFullScreen', windowState.isFullScreen);
}
