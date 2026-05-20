import type { WindowInfo } from '../../shared/types/window';

export interface SessionWindowOwnership {
	ownerWindowId: string | null;
	windowNumber: number | null;
	isCurrentWindow: boolean;
	isOpenInOtherWindow: boolean;
	badgeLabel: string | null;
}

export function getWindowNumberById(windows: WindowInfo[]): Map<string, number> {
	return new Map(windows.map((windowInfo, index) => [windowInfo.id, index + 1]));
}

export function getSessionWindowOwnership(
	sessionId: string,
	currentWindowId: string | null,
	windows: WindowInfo[]
): SessionWindowOwnership {
	const ownerWindow = windows.find((windowInfo) => windowInfo.sessionIds.includes(sessionId));
	const ownerWindowId = ownerWindow?.id ?? null;
	const windowNumber = ownerWindowId
		? (getWindowNumberById(windows).get(ownerWindowId) ?? null)
		: null;
	const isCurrentWindow = !!ownerWindowId && ownerWindowId === currentWindowId;
	const isOpenInOtherWindow = !!ownerWindowId && ownerWindowId !== currentWindowId;

	return {
		ownerWindowId,
		windowNumber,
		isCurrentWindow,
		isOpenInOtherWindow,
		badgeLabel: isOpenInOtherWindow && windowNumber ? `W${windowNumber}` : null,
	};
}
