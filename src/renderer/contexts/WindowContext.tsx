import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';

import type { WindowState } from '../../shared/types/window';

export interface WindowContextValue {
	windowId: string | null;
	isMainWindow: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
	openSession: (sessionId: string) => Promise<void>;
	closeTab: (sessionId: string) => Promise<void>;
	moveSessionToNewWindow: (sessionId: string) => Promise<string | null>;
}

interface WindowProviderProps {
	children: ReactNode;
	initialWindowId?: string;
}

const WindowContext = createContext<WindowContextValue | null>(null);

export function WindowProvider({ children, initialWindowId }: WindowProviderProps) {
	const [windowState, setWindowState] = useState<WindowState | null>(null);
	const [windowId, setWindowId] = useState<string | null>(initialWindowId ?? null);
	const [isMainWindow, setIsMainWindow] = useState(false);
	const mountedRef = useRef(true);

	const refreshIsMainWindow = useCallback(async (id: string) => {
		try {
			const windows = await window.maestro.windows.list();
			if (!mountedRef.current) {
				return;
			}
			const current = windows.find((entry) => entry.id === id);
			setIsMainWindow(current?.isMain ?? id === 'primary');
		} catch (error) {
			console.error('Failed to fetch window list', error);
		}
	}, []);

	const hydrateState = useCallback(async () => {
		try {
			const state = await window.maestro.windows.getState();
			if (!mountedRef.current) {
				return;
			}

			if (!state) {
				setWindowState(null);
				setIsMainWindow(false);
				return;
			}

			setWindowState(state);
			setWindowId(state.id);
			await refreshIsMainWindow(state.id);
		} catch (error) {
			console.error('Failed to load window state', error);
		}
	}, [refreshIsMainWindow]);

	useEffect(() => {
		mountedRef.current = true;
		hydrateState();
		return () => {
			mountedRef.current = false;
		};
	}, [hydrateState]);

	const openSession = useCallback(
		async (sessionId: string) => {
			if (!sessionId || !windowId) {
				return;
			}

			try {
				await window.maestro.windows.moveSession({ sessionId, toWindowId: windowId });
			} catch (error) {
				console.error('Failed to assign session to current window', error);
			}

			setWindowState((prev) => {
				if (!prev) {
					return prev;
				}

				const alreadyOpen = prev.sessionIds.includes(sessionId);
				const nextSessionIds = alreadyOpen ? prev.sessionIds : [...prev.sessionIds, sessionId];

				return {
					...prev,
					sessionIds: nextSessionIds,
					activeSessionId: sessionId,
				};
			});

			await hydrateState();
		},
		[windowId, hydrateState]
	);

	const closeTab = useCallback(async (sessionId: string) => {
		setWindowState((prev) => {
			if (!prev || !prev.sessionIds.includes(sessionId)) {
				return prev;
			}

			const nextSessionIds = prev.sessionIds.filter((id) => id !== sessionId);
			const nextActiveSessionId =
				prev.activeSessionId === sessionId
					? nextSessionIds[nextSessionIds.length - 1] ?? null
					: prev.activeSessionId;

			return {
				...prev,
				sessionIds: nextSessionIds,
				activeSessionId: nextActiveSessionId,
			};
		});
	}, []);

	const moveSessionToNewWindow = useCallback(
		async (sessionId: string) => {
			if (!sessionId || !windowId) {
				return null;
			}

			try {
				const result = await window.maestro.windows.create({ sessionIds: [sessionId] });
				await window.maestro.windows.moveSession({
					sessionId,
					toWindowId: result.windowId,
					fromWindowId: windowId,
				});

				setWindowState((prev) => {
					if (!prev) {
						return prev;
					}

					const nextSessionIds = prev.sessionIds.filter((id) => id !== sessionId);
					const nextActiveSessionId =
						prev.activeSessionId === sessionId
							? nextSessionIds[nextSessionIds.length - 1] ?? null
							: prev.activeSessionId;

					return {
						...prev,
						sessionIds: nextSessionIds,
						activeSessionId: nextActiveSessionId,
					};
				});

				await hydrateState();
				return result.windowId;
			} catch (error) {
				console.error('Failed to move session to new window', error);
				return null;
			}
		},
		[windowId, hydrateState]
	);

	const sessionIds = windowState?.sessionIds ?? [];
	const activeSessionId = windowState?.activeSessionId ?? null;

	const value = useMemo<WindowContextValue>(
		() => ({
			windowId,
			isMainWindow,
			sessionIds,
			activeSessionId,
			openSession,
			closeTab,
			moveSessionToNewWindow,
		}),
		[windowId, isMainWindow, sessionIds, activeSessionId, openSession, closeTab, moveSessionToNewWindow]
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
