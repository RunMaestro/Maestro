import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react';
import type { WindowInfo, WindowState } from '../../shared/types/window';
import { notifyToast } from '../stores/notificationStore';
import { getWindowNumberById } from '../utils/windowSessionOwnership';

export interface WindowContextValue {
	windowId: string | null;
	windowNumber: number | null;
	isMainWindow: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
	isDropZoneHighlighted: boolean;
	openSession: (sessionId: string) => Promise<void>;
	closeTab: (sessionId: string) => void;
	moveSessionToNewWindow: (sessionId: string) => Promise<WindowInfo>;
}

interface WindowProviderProps {
	children: ReactNode;
}

const WindowContext = createContext<WindowContextValue | null>(null);

function getNextActiveSessionId(
	currentSessionIds: string[],
	closingSessionId: string,
	activeSessionId: string | null
): string | null {
	if (activeSessionId !== closingSessionId) {
		return activeSessionId;
	}

	const closingIndex = currentSessionIds.indexOf(closingSessionId);
	const nextSessionIds = currentSessionIds.filter((sessionId) => sessionId !== closingSessionId);
	if (nextSessionIds.length === 0) {
		return null;
	}

	return nextSessionIds[Math.min(closingIndex, nextSessionIds.length - 1)] ?? null;
}

function getValidActiveSessionId(
	nextSessionIds: string[],
	nextActiveSessionId: string | null,
	currentActiveSessionId: string | null
): string | null {
	if (nextActiveSessionId && nextSessionIds.includes(nextActiveSessionId)) {
		return nextActiveSessionId;
	}
	if (currentActiveSessionId && nextSessionIds.includes(currentActiveSessionId)) {
		return currentActiveSessionId;
	}

	return nextSessionIds[0] ?? null;
}

export function WindowProvider({ children }: WindowProviderProps) {
	const [windowId, setWindowId] = useState<string | null>(null);
	const [windowNumber, setWindowNumber] = useState<number | null>(null);
	const [isMainWindow, setIsMainWindow] = useState(false);
	const [sessionIds, setSessionIds] = useState<string[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	const [isDropZoneHighlighted, setIsDropZoneHighlighted] = useState(false);

	useEffect(() => {
		let cancelled = false;

		async function initializeWindowState() {
			const state: WindowState = await window.maestro.windows.getState();
			const windows = await window.maestro.windows.list();
			const windowInfo = windows.find((candidate) => candidate.id === state.id);

			if (cancelled) {
				return;
			}

			setWindowId(state.id);
			setWindowNumber(getWindowNumberById(windows).get(state.id) ?? null);
			setIsMainWindow(windowInfo?.isMain ?? false);
			setSessionIds(state.sessionIds);
			setActiveSessionId(state.activeSessionId);
		}

		void initializeWindowState();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!windowId) {
			return undefined;
		}

		return window.maestro.windows.onSessionMoved((event) => {
			const currentWindow = event.windows.find((candidate) => candidate.id === windowId);
			if (!currentWindow) {
				return;
			}

			setSessionIds(currentWindow.sessionIds);
			setWindowNumber(getWindowNumberById(event.windows).get(windowId) ?? null);
			setIsMainWindow(currentWindow.isMain);
			setActiveSessionId((currentActiveSessionId) =>
				getValidActiveSessionId(
					currentWindow.sessionIds,
					currentWindow.activeSessionId,
					currentActiveSessionId
				)
			);
		});
	}, [windowId]);

	useEffect(() => {
		if (!windowId) {
			return undefined;
		}

		return window.maestro.windows.onSessionsMovedToPrimary((event) => {
			const currentWindow = event.windows.find((candidate) => candidate.id === windowId);
			if (!currentWindow) {
				return;
			}

			setSessionIds(currentWindow.sessionIds);
			setWindowNumber(getWindowNumberById(event.windows).get(windowId) ?? null);
			setIsMainWindow(currentWindow.isMain);
			setActiveSessionId((currentActiveSessionId) =>
				getValidActiveSessionId(
					currentWindow.sessionIds,
					currentWindow.activeSessionId,
					currentActiveSessionId
				)
			);

			if (windowId === event.toWindowId) {
				const sessionCount = event.sessionIds.length;
				notifyToast({
					type: 'info',
					title: `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'} moved to main window`,
					message: '',
					duration: 4000,
				});
			}
		});
	}, [windowId]);

	useEffect(() => {
		return window.maestro.windows.onDropZoneHighlightChanged((event) => {
			setIsDropZoneHighlighted(event.highlighted);
		});
	}, []);

	const closeTab = useCallback((sessionId: string) => {
		setSessionIds((currentSessionIds) => {
			setActiveSessionId((currentActiveSessionId) =>
				getNextActiveSessionId(currentSessionIds, sessionId, currentActiveSessionId)
			);
			return currentSessionIds.filter((currentSessionId) => currentSessionId !== sessionId);
		});
	}, []);

	const openSession = useCallback(
		async (sessionId: string) => {
			if (sessionIds.includes(sessionId)) {
				setActiveSessionId(sessionId);
				return;
			}

			const ownerWindowId = await window.maestro.windows.getForSession(sessionId);
			if (ownerWindowId && ownerWindowId !== windowId) {
				await window.maestro.windows.focusWindow(ownerWindowId);
				return;
			}

			setSessionIds((currentSessionIds) =>
				currentSessionIds.includes(sessionId)
					? currentSessionIds
					: [...currentSessionIds, sessionId]
			);
			setActiveSessionId(sessionId);
		},
		[sessionIds, windowId]
	);

	const moveSessionToNewWindow = useCallback(
		async (sessionId: string): Promise<WindowInfo> => {
			if (!windowId) {
				throw new Error('Cannot move session before window state is initialized');
			}

			const newWindow = await window.maestro.windows.create([sessionId]);
			setSessionIds((currentSessionIds) =>
				currentSessionIds.filter((currentSessionId) => currentSessionId !== sessionId)
			);
			setActiveSessionId((currentActiveSessionId) =>
				getNextActiveSessionId(sessionIds, sessionId, currentActiveSessionId)
			);
			return newWindow;
		},
		[sessionIds, windowId]
	);

	const value = useMemo<WindowContextValue>(
		() => ({
			windowId,
			windowNumber,
			isMainWindow,
			sessionIds,
			activeSessionId,
			isDropZoneHighlighted,
			openSession,
			closeTab,
			moveSessionToNewWindow,
		}),
		[
			windowId,
			windowNumber,
			isMainWindow,
			sessionIds,
			activeSessionId,
			isDropZoneHighlighted,
			openSession,
			closeTab,
			moveSessionToNewWindow,
		]
	);

	return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

export function useWindowContext(): WindowContextValue {
	const context = useContext(WindowContext);

	if (!context) {
		throw new Error('useWindowContext must be used within a WindowProvider');
	}

	return context;
}

export function useOptionalWindowContext(): WindowContextValue | null {
	return useContext(WindowContext);
}
