import type Store from 'electron-store';
import type { MultiWindowState, WindowState } from '../stores/types';

export interface StoredSessionRef {
	id: string;
}

interface DisplayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface StartupDisplay {
	workArea: DisplayBounds;
}

export interface StartupDisplayProvider {
	getAllDisplays: () => StartupDisplay[];
	getPrimaryDisplay: () => StartupDisplay;
}

function createPrimaryWindowState(): WindowState {
	return {
		id: 'primary',
		x: 0,
		y: 0,
		width: 1400,
		height: 900,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
}

function hasVisibleIntersection(bounds: DisplayBounds, displayBounds: DisplayBounds): boolean {
	return (
		bounds.x < displayBounds.x + displayBounds.width &&
		bounds.x + bounds.width > displayBounds.x &&
		bounds.y < displayBounds.y + displayBounds.height &&
		bounds.y + bounds.height > displayBounds.y
	);
}

function repositionWindowToPrimaryDisplay(
	windowState: WindowState,
	displayProvider?: StartupDisplayProvider
): WindowState {
	if (!displayProvider) {
		return windowState;
	}

	const displays = displayProvider.getAllDisplays();
	const bounds = {
		x: windowState.x,
		y: windowState.y,
		width: windowState.width,
		height: windowState.height,
	};
	const isVisibleOnAnyDisplay = displays.some((display) =>
		hasVisibleIntersection(bounds, display.workArea)
	);

	if (isVisibleOnAnyDisplay) {
		return windowState;
	}

	const primaryWorkArea = displayProvider.getPrimaryDisplay().workArea;
	const width = Math.min(windowState.width, primaryWorkArea.width);
	const height = Math.min(windowState.height, primaryWorkArea.height);

	return {
		...windowState,
		x: primaryWorkArea.x + Math.max(0, Math.floor((primaryWorkArea.width - width) / 2)),
		y: primaryWorkArea.y + Math.max(0, Math.floor((primaryWorkArea.height - height) / 2)),
		width,
		height,
	};
}

function sanitizeWindowState(
	windowState: WindowState,
	validSessionIds: Set<string>,
	claimedSessionIds: Set<string>,
	displayProvider?: StartupDisplayProvider
): WindowState {
	const sessionIds = windowState.sessionIds.filter((sessionId) => {
		if (!validSessionIds.has(sessionId) || claimedSessionIds.has(sessionId)) {
			return false;
		}

		claimedSessionIds.add(sessionId);
		return true;
	});
	const displaySafeWindowState = repositionWindowToPrimaryDisplay(windowState, displayProvider);

	return {
		...displaySafeWindowState,
		sessionIds,
		activeSessionId:
			windowState.activeSessionId && sessionIds.includes(windowState.activeSessionId)
				? windowState.activeSessionId
				: (sessionIds[0] ?? null),
	};
}

function hasStateChanged(previousState: MultiWindowState, nextState: MultiWindowState): boolean {
	return JSON.stringify(previousState) !== JSON.stringify(nextState);
}

function orderPrimaryWindowFirst(windows: WindowState[], primaryWindowId: string): WindowState[] {
	const primaryWindow = windows.find((windowState) => windowState.id === primaryWindowId);
	if (!primaryWindow) {
		return windows;
	}

	return [primaryWindow, ...windows.filter((windowState) => windowState.id !== primaryWindowId)];
}

export function sanitizeRestoredWindowState(
	savedState: MultiWindowState,
	sessions: StoredSessionRef[],
	displayProvider?: StartupDisplayProvider
): MultiWindowState {
	const validSessionIds = new Set(sessions.map((session) => session.id));
	const claimedSessionIds = new Set<string>();
	const savedWindows =
		savedState.windows.length > 0 ? savedState.windows : [createPrimaryWindowState()];
	const windows = savedWindows.map((windowState) =>
		sanitizeWindowState(windowState, validSessionIds, claimedSessionIds, displayProvider)
	);
	const hasPrimaryWindow = windows.some(
		(windowState) => windowState.id === savedState.primaryWindowId
	);
	const primaryWindowId = hasPrimaryWindow
		? savedState.primaryWindowId
		: (windows[0]?.id ?? 'primary');

	return {
		primaryWindowId,
		windows: orderPrimaryWindowFirst(windows, primaryWindowId),
	};
}

export function getStartupWindowStates(
	windowStateStore: Store<MultiWindowState>,
	sessions: StoredSessionRef[],
	displayProvider?: StartupDisplayProvider
): WindowState[] {
	const savedState = windowStateStore.store;
	const nextState = sanitizeRestoredWindowState(savedState, sessions, displayProvider);

	if (hasStateChanged(savedState, nextState)) {
		windowStateStore.store = nextState;
	}

	return nextState.windows;
}
