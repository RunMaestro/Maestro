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
import { useToast } from './ToastContext';
import { getWindowNumberForId } from '../utils/windowOrdering';

const WINDOW_TITLE_SUFFIX = ' - Agent Orchestration Command Center';

export interface WindowContextValue {
	windowId: string | null;
	windowNumber: number | null;
	isMainWindow: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
	openSession: (sessionId: string) => Promise<void>;
	closeTab: (sessionId: string) => Promise<void>;
	moveSessionToNewWindow: (sessionId: string) => Promise<string | null>;
	assignSessionsToWindow: (sessionIds: string[]) => Promise<void>;
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
	const [windowNumber, setWindowNumber] = useState<number | null>(null);
	const mountedRef = useRef(true);
	const windowIdRef = useRef<string | null>(initialWindowId ?? null);
	const { addToast } = useToast();

	const refreshWindowMetadata = useCallback(async (id: string) => {
		try {
			const windows = await window.maestro.windows.list();
			if (!mountedRef.current) {
				return;
			}
			const current = windows.find((entry) => entry.id === id);
			setIsMainWindow(current?.isMain ?? id === 'primary');
			setWindowNumber(getWindowNumberForId(windows, id));
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
				setWindowNumber(null);
				return;
			}

			setWindowState(state);
			setWindowId(state.id);
			await refreshWindowMetadata(state.id);
		} catch (error) {
			console.error('Failed to load window state', error);
		}
	}, [refreshWindowMetadata]);

	useEffect(() => {
		mountedRef.current = true;
		hydrateState();
		return () => {
			mountedRef.current = false;
		};
	}, [hydrateState]);

	useEffect(() => {
		windowIdRef.current = windowId;
	}, [windowId]);

	useEffect(() => {
		const unsubscribe = window.maestro.windows.onSessionMoved((event) => {
			const currentWindowId = windowIdRef.current;
			if (!currentWindowId) {
				return;
			}
			if (
				event.fromWindowId !== currentWindowId &&
				event.toWindowId !== currentWindowId
			) {
				return;
			}
			hydrateState();
		});
		return () => {
			unsubscribe();
		};
	}, [hydrateState]);

	useEffect(() => {
		if (!window.maestro?.windows?.onSessionsReassigned) {
			return undefined;
		}
		const unsubscribe = window.maestro.windows.onSessionsReassigned((event) => {
			const currentWindowId = windowIdRef.current;
			if (!currentWindowId || event.toWindowId !== currentWindowId) {
				return;
			}
			if (!event.sessionIds?.length) {
				return;
			}
			void hydrateState();
			const movedCount = event.sessionIds.length;
			const label = movedCount === 1 ? 'session' : 'sessions';
			addToast({
				type: 'info',
				title: 'Sessions moved',
				message: `${movedCount} ${label} moved to main window`,
				windowId: currentWindowId,
			});
		});
		return () => {
			unsubscribe();
		};
	}, [hydrateState, addToast]);

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

	const assignSessionsToWindow = useCallback(
		async (sessionIdsToAssign: string[]) => {
			if (!windowId || !sessionIdsToAssign.length) {
				return;
			}

			setWindowState((prev) => {
				if (!prev) {
					return prev;
				}

				const existing = new Set(prev.sessionIds);
				let changed = false;
				for (const sessionId of sessionIdsToAssign) {
					if (!existing.has(sessionId)) {
						existing.add(sessionId);
						changed = true;
					}
				}

				if (!changed) {
					return prev;
				}

				return {
					...prev,
					sessionIds: Array.from(existing),
				};
			});

			if (!window.maestro?.windows?.assignSessions) {
				return;
			}

			try {
				await window.maestro.windows.assignSessions({
					sessionIds: sessionIdsToAssign,
					windowId,
				});
			} catch (error) {
				console.error('Failed to assign sessions to window', error);
			} finally {
				await hydrateState();
			}
		},
		[windowId, hydrateState]
	);

	const value = useMemo<WindowContextValue>(
		() => ({
			windowId,
			windowNumber,
			isMainWindow,
			sessionIds,
			activeSessionId,
			openSession,
			closeTab,
			moveSessionToNewWindow,
			assignSessionsToWindow,
		}),
		[
			windowId,
			windowNumber,
			isMainWindow,
			sessionIds,
			activeSessionId,
			openSession,
			closeTab,
			moveSessionToNewWindow,
			assignSessionsToWindow,
		]
	);

	useEffect(() => {
		const resolvedBase =
			typeof windowNumber === 'number' ? `Maestro [${windowNumber}]` : 'Maestro';
		document.title = `${resolvedBase}${WINDOW_TITLE_SUFFIX}`;
	}, [windowNumber]);

	useEffect(() => {
		return () => {
			document.title = `Maestro${WINDOW_TITLE_SUFFIX}`;
		};
	}, []);

	return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

export function useWindowContext(): WindowContextValue {
	const context = useContext(WindowContext);
	if (!context) {
		throw new Error('useWindowContext must be used within a WindowProvider');
	}
	return context;
}
