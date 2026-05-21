import type Store from 'electron-store';
import type { MultiWindowState, WindowState } from '../stores/types';

export interface StoredSessionRef {
	id: string;
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

function sanitizeWindowState(
	windowState: WindowState,
	validSessionIds: Set<string>,
	claimedSessionIds: Set<string>
): WindowState {
	const sessionIds = windowState.sessionIds.filter((sessionId) => {
		if (!validSessionIds.has(sessionId) || claimedSessionIds.has(sessionId)) {
			return false;
		}

		claimedSessionIds.add(sessionId);
		return true;
	});

	return {
		...windowState,
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
	sessions: StoredSessionRef[]
): MultiWindowState {
	const validSessionIds = new Set(sessions.map((session) => session.id));
	const claimedSessionIds = new Set<string>();
	const savedWindows =
		savedState.windows.length > 0 ? savedState.windows : [createPrimaryWindowState()];
	const windows = savedWindows.map((windowState) =>
		sanitizeWindowState(windowState, validSessionIds, claimedSessionIds)
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
	sessions: StoredSessionRef[]
): WindowState[] {
	const savedState = windowStateStore.store;
	const nextState = sanitizeRestoredWindowState(savedState, sessions);

	if (hasStateChanged(savedState, nextState)) {
		windowStateStore.store = nextState;
	}

	return nextState.windows;
}
