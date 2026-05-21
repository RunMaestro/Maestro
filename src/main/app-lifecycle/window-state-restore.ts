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
	id: number;
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

function fitBoundsInsideDisplay(
	bounds: DisplayBounds,
	displayBounds: DisplayBounds
): DisplayBounds {
	const width = Math.min(bounds.width, displayBounds.width);
	const height = Math.min(bounds.height, displayBounds.height);
	const maxX = displayBounds.x + displayBounds.width - width;
	const maxY = displayBounds.y + displayBounds.height - height;

	return {
		x: Math.min(Math.max(bounds.x, displayBounds.x), maxX),
		y: Math.min(Math.max(bounds.y, displayBounds.y), maxY),
		width,
		height,
	};
}

function centerWindowOnDisplay(
	windowState: WindowState,
	displayBounds: DisplayBounds
): DisplayBounds {
	const width = Math.min(windowState.width, displayBounds.width);
	const height = Math.min(windowState.height, displayBounds.height);

	return {
		x: displayBounds.x + Math.max(0, Math.floor((displayBounds.width - width) / 2)),
		y: displayBounds.y + Math.max(0, Math.floor((displayBounds.height - height) / 2)),
		width,
		height,
	};
}

function getWindowBounds(windowState: WindowState): DisplayBounds {
	return {
		x: windowState.x,
		y: windowState.y,
		width: windowState.width,
		height: windowState.height,
	};
}

function repositionWindowForDisplays(
	windowState: WindowState,
	displayProvider?: StartupDisplayProvider
): WindowState {
	if (!displayProvider) {
		return windowState;
	}

	const displays = displayProvider.getAllDisplays();
	const bounds = getWindowBounds(windowState);
	const matchingDisplay = displays.find((display) => display.id === windowState.displayId);

	if (matchingDisplay) {
		if (hasVisibleIntersection(bounds, matchingDisplay.workArea)) {
			return windowState;
		}

		const translatedBounds = windowState.displayWorkArea
			? {
					...bounds,
					x: matchingDisplay.workArea.x + (windowState.x - windowState.displayWorkArea.x),
					y: matchingDisplay.workArea.y + (windowState.y - windowState.displayWorkArea.y),
				}
			: centerWindowOnDisplay(windowState, matchingDisplay.workArea);
		const nextBounds = fitBoundsInsideDisplay(translatedBounds, matchingDisplay.workArea);

		return {
			...windowState,
			...nextBounds,
			displayId: matchingDisplay.id,
			displayWorkArea: matchingDisplay.workArea,
		};
	}

	const isVisibleOnAnyDisplay = displays.some((display) =>
		hasVisibleIntersection(bounds, display.workArea)
	);

	if (isVisibleOnAnyDisplay) {
		return windowState;
	}

	const primaryWorkArea = displayProvider.getPrimaryDisplay().workArea;
	const nextBounds = centerWindowOnDisplay(windowState, primaryWorkArea);

	return {
		...windowState,
		...nextBounds,
		displayId: displayProvider.getPrimaryDisplay().id,
		displayWorkArea: primaryWorkArea,
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
	const displaySafeWindowState = repositionWindowForDisplays(windowState, displayProvider);

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
