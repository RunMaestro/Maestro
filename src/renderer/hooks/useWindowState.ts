import { useEffect, useRef } from 'react';

import { useUIStore } from '../stores/uiStore';

/**
 * Synchronizes per-window UI state (panel collapse) with the main process store.
 */
export function useWindowState(): void {
	const leftSidebarOpen = useUIStore((state) => state.leftSidebarOpen);
	const rightPanelOpen = useUIStore((state) => state.rightPanelOpen);
	const setLeftSidebarOpen = useUIStore((state) => state.setLeftSidebarOpen);
	const setRightPanelOpen = useUIStore((state) => state.setRightPanelOpen);

	const hasHydratedRef = useRef(false);
	const previousLeftRef = useRef(leftSidebarOpen);
	const previousRightRef = useRef(rightPanelOpen);
	const initialLeftRef = useRef(leftSidebarOpen);
	const initialRightRef = useRef(rightPanelOpen);

	useEffect(() => {
		let cancelled = false;

		async function hydratePanelState() {
			const windowsApi = window.maestro?.windows;
			if (!windowsApi?.getState) {
				hasHydratedRef.current = true;
				return;
			}

			try {
				const state = await windowsApi.getState();
				if (cancelled) {
					return;
				}

				if (state) {
					const leftOpen = !state.leftPanelCollapsed;
					const rightOpen = !state.rightPanelCollapsed;

					previousLeftRef.current = leftOpen;
					previousRightRef.current = rightOpen;

					setLeftSidebarOpen(leftOpen);
					setRightPanelOpen(rightOpen);
				} else {
					previousLeftRef.current = initialLeftRef.current;
					previousRightRef.current = initialRightRef.current;
				}
			} catch (error) {
				if (!cancelled) {
					console.error('Failed to hydrate window panel state', error);
				}
			} finally {
				if (!cancelled) {
					hasHydratedRef.current = true;
				}
			}
		}

		hydratePanelState();

		return () => {
			cancelled = true;
		};
	}, [setLeftSidebarOpen, setRightPanelOpen]);

	useEffect(() => {
		const windowsApi = window.maestro?.windows;
		if (!hasHydratedRef.current || !windowsApi?.updateState) {
			return;
		}

		if (leftSidebarOpen === previousLeftRef.current) {
			return;
		}

		previousLeftRef.current = leftSidebarOpen;

		windowsApi
			.updateState({ leftPanelCollapsed: !leftSidebarOpen })
			.catch((error) => console.error('Failed to persist left panel state', error));
	}, [leftSidebarOpen]);

	useEffect(() => {
		const windowsApi = window.maestro?.windows;
		if (!hasHydratedRef.current || !windowsApi?.updateState) {
			return;
		}

		if (rightPanelOpen === previousRightRef.current) {
			return;
		}

		previousRightRef.current = rightPanelOpen;

		windowsApi
			.updateState({ rightPanelCollapsed: !rightPanelOpen })
			.catch((error) => console.error('Failed to persist right panel state', error));
	}, [rightPanelOpen]);
}
