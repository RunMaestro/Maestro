import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../stores/uiStore';

export interface UseWindowStateOptions {
	windowId: string | null;
}

/**
 * Hydrates and persists UI state that belongs to the current Electron window.
 */
export function useWindowState({ windowId }: UseWindowStateOptions): void {
	const [hydratedWindowId, setHydratedWindowId] = useState<string | null>(null);
	const applyingRemoteStateRef = useRef(false);

	useEffect(() => {
		if (!windowId) {
			setHydratedWindowId(null);
			return;
		}

		let cancelled = false;

		async function hydrateWindowState() {
			const state = await window.maestro.windows.getState();
			if (cancelled || state.id !== windowId) {
				return;
			}

			applyingRemoteStateRef.current = true;
			useUIStore.setState({
				leftSidebarOpen: !state.leftPanelCollapsed,
				rightPanelOpen: !state.rightPanelCollapsed,
			});
			applyingRemoteStateRef.current = false;
			setHydratedWindowId(windowId);
		}

		void hydrateWindowState();

		return () => {
			cancelled = true;
		};
	}, [windowId]);

	useEffect(() => {
		if (!hydratedWindowId || hydratedWindowId !== windowId) {
			return undefined;
		}

		return useUIStore.subscribe((state, previousState) => {
			if (applyingRemoteStateRef.current) {
				return;
			}

			const leftPanelChanged = state.leftSidebarOpen !== previousState.leftSidebarOpen;
			const rightPanelChanged = state.rightPanelOpen !== previousState.rightPanelOpen;
			if (!leftPanelChanged && !rightPanelChanged) {
				return;
			}

			void window.maestro.windows.updateState({
				...(leftPanelChanged ? { leftPanelCollapsed: !state.leftSidebarOpen } : {}),
				...(rightPanelChanged ? { rightPanelCollapsed: !state.rightPanelOpen } : {}),
			});
		});
	}, [hydratedWindowId, windowId]);
}
