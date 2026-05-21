import { describe, expect, it } from 'vitest';
import type {
	MultiWindowState,
	WindowInfo,
	WindowSessionsMovedToPrimaryEvent,
	WindowState,
} from '../../shared/types/window';
import type {
	MultiWindowState as ExportedMultiWindowState,
	WindowInfo as ExportedWindowInfo,
	WindowSessionsMovedToPrimaryEvent as ExportedWindowSessionsMovedToPrimaryEvent,
	WindowState as ExportedWindowState,
} from '../../shared/types';

describe('shared/types/window', () => {
	it('supports persisted window layout state', () => {
		const windowState = {
			id: 'primary',
			x: 10,
			y: 20,
			width: 1200,
			height: 800,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
			leftPanelCollapsed: false,
			rightPanelCollapsed: true,
		} satisfies WindowState;

		const multiWindowState = {
			windows: [windowState],
			primaryWindowId: 'primary',
		} satisfies MultiWindowState;

		expect(multiWindowState.windows[0].activeSessionId).toBe('session-1');
	});

	it('supports lightweight runtime window info', () => {
		const windowInfo = {
			id: 'secondary',
			isMain: false,
			sessionIds: ['session-2'],
			activeSessionId: null,
		} satisfies WindowInfo;

		expect(windowInfo.isMain).toBe(false);
	});

	it('supports secondary close session transfer events', () => {
		const event = {
			sessionIds: ['session-2'],
			fromWindowId: 'secondary',
			toWindowId: 'primary',
			windows: [
				{
					id: 'primary',
					isMain: true,
					sessionIds: ['session-1', 'session-2'],
					activeSessionId: 'session-1',
				},
			],
		} satisfies WindowSessionsMovedToPrimaryEvent;

		expect(event.toWindowId).toBe('primary');
	});

	it('re-exports window types from shared/types', () => {
		const windowState: ExportedWindowState = {
			id: 'primary',
			x: 0,
			y: 0,
			width: 1000,
			height: 700,
			isMaximized: true,
			isFullScreen: false,
			sessionIds: [],
			activeSessionId: null,
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		};
		const multiWindowState: ExportedMultiWindowState = {
			windows: [windowState],
			primaryWindowId: windowState.id,
		};
		const windowInfo: ExportedWindowInfo = {
			id: windowState.id,
			isMain: true,
			sessionIds: windowState.sessionIds,
			activeSessionId: windowState.activeSessionId,
		};
		const movedEvent: ExportedWindowSessionsMovedToPrimaryEvent = {
			sessionIds: [],
			fromWindowId: 'secondary',
			toWindowId: windowState.id,
			windows: [windowInfo],
		};

		expect(multiWindowState.primaryWindowId).toBe(windowInfo.id);
		expect(movedEvent.toWindowId).toBe(windowInfo.id);
	});
});
