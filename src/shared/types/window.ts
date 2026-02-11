/**
 * Shared window state definitions for multi-window support across
 * the main and renderer processes.
 */

export interface WindowState {
	id: string;
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized: boolean;
	isFullScreen: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
	leftPanelCollapsed: boolean;
	rightPanelCollapsed: boolean;
}

export interface MultiWindowState {
	windows: WindowState[];
	primaryWindowId: string;
}

export interface WindowInfo {
	id: string;
	isMain: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
}

export interface WindowSessionMovedEvent {
	sessionId: string;
	fromWindowId: string;
	toWindowId: string;
}

export interface WindowSessionsReassignedEvent {
	fromWindowId: string;
	toWindowId: string;
	sessionIds: string[];
}

export interface WindowDropZoneHighlightEvent {
	highlight: boolean;
	sourceWindowId: string | null;
}
