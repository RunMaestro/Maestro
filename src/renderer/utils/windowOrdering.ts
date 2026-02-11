import type { WindowInfo } from '../../shared/types/window';

/**
 * Orders windows for display by surfacing the primary window first
 * while keeping the remaining windows in their existing order.
 */
export function orderWindowsForDisplay(windows: WindowInfo[]): WindowInfo[] {
	if (!windows.length) {
		return [];
	}

	const mainWindow = windows.find((entry) => entry.isMain);

	if (!mainWindow) {
		return [...windows];
	}

	const ordered: WindowInfo[] = [mainWindow];

	for (const entry of windows) {
		if (entry.id !== mainWindow.id) {
			ordered.push(entry);
		}
	}

	return ordered;
}

/**
 * Resolves the display number for a window ID based on the ordered
 * window list. Returns null if the window could not be found.
 */
export function getWindowNumberForId(
	windows: WindowInfo[],
	windowId: string | null
): number | null {
	if (!windowId) {
		return null;
	}

	const ordered = orderWindowsForDisplay(windows);
	const index = ordered.findIndex((entry) => entry.id === windowId);
	return index === -1 ? null : index + 1;
}
