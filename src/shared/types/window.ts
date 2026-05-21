export interface WindowState {
	id: string;
	x: number;
	y: number;
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

export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowPoint {
	screenX: number;
	screenY: number;
}

export interface WindowSessionMovedEvent {
	sessionId: string;
	fromWindowId: string;
	toWindowId: string;
	windows: WindowInfo[];
}

export interface WindowDropZoneHighlightEvent {
	highlighted: boolean;
}

export type WindowStateUpdate = Partial<
	Pick<WindowState, 'activeSessionId' | 'leftPanelCollapsed' | 'rightPanelCollapsed'>
>;
