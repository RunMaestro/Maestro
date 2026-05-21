import { describe, expect, it } from 'vitest';
import {
	getStartupWindowStates,
	sanitizeRestoredWindowState,
} from '../../../main/app-lifecycle/window-state-restore';
import type { MultiWindowState } from '../../../main/stores/types';

function createWindowStateStore(state: MultiWindowState) {
	return {
		store: state,
	};
}

describe('app-lifecycle/window-state-restore', () => {
	it('filters deleted sessions and clears invalid active sessions', () => {
		const restoredState = sanitizeRestoredWindowState(
			{
				primaryWindowId: 'primary',
				windows: [
					{
						id: 'primary',
						x: 10,
						y: 20,
						width: 1200,
						height: 800,
						isMaximized: false,
						isFullScreen: false,
						sessionIds: ['session-1', 'deleted-session'],
						activeSessionId: 'deleted-session',
						leftPanelCollapsed: true,
						rightPanelCollapsed: false,
					},
				],
			},
			[{ id: 'session-1' }]
		);

		expect(restoredState.windows[0]).toMatchObject({
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
			leftPanelCollapsed: true,
		});
	});

	it('keeps each valid session assigned to only one restored window', () => {
		const restoredState = sanitizeRestoredWindowState(
			{
				primaryWindowId: 'primary',
				windows: [
					{
						id: 'primary',
						x: 0,
						y: 0,
						width: 1400,
						height: 900,
						isMaximized: false,
						isFullScreen: false,
						sessionIds: ['session-1'],
						activeSessionId: 'session-1',
						leftPanelCollapsed: false,
						rightPanelCollapsed: false,
					},
					{
						id: 'secondary',
						x: 100,
						y: 100,
						width: 1000,
						height: 700,
						isMaximized: false,
						isFullScreen: false,
						sessionIds: ['session-1', 'session-2'],
						activeSessionId: 'session-1',
						leftPanelCollapsed: false,
						rightPanelCollapsed: true,
					},
				],
			},
			[{ id: 'session-1' }, { id: 'session-2' }]
		);

		expect(restoredState.windows[0].sessionIds).toEqual(['session-1']);
		expect(restoredState.windows[1]).toMatchObject({
			sessionIds: ['session-2'],
			activeSessionId: 'session-2',
			rightPanelCollapsed: true,
		});
	});

	it('falls back to a primary window when no saved windows exist', () => {
		const restoredState = sanitizeRestoredWindowState(
			{
				primaryWindowId: 'primary',
				windows: [],
			},
			[]
		);

		expect(restoredState).toMatchObject({
			primaryWindowId: 'primary',
			windows: [
				{
					id: 'primary',
					width: 1400,
					height: 900,
					sessionIds: [],
					activeSessionId: null,
				},
			],
		});
	});

	it('orders the primary window first for startup creation', () => {
		const restoredState = sanitizeRestoredWindowState(
			{
				primaryWindowId: 'primary',
				windows: [
					{
						id: 'secondary',
						x: 100,
						y: 100,
						width: 1000,
						height: 700,
						isMaximized: false,
						isFullScreen: false,
						sessionIds: ['session-2'],
						activeSessionId: 'session-2',
						leftPanelCollapsed: false,
						rightPanelCollapsed: false,
					},
					{
						id: 'primary',
						x: 0,
						y: 0,
						width: 1400,
						height: 900,
						isMaximized: false,
						isFullScreen: false,
						sessionIds: ['session-1'],
						activeSessionId: 'session-1',
						leftPanelCollapsed: false,
						rightPanelCollapsed: false,
					},
				],
			},
			[{ id: 'session-1' }, { id: 'session-2' }]
		);

		expect(restoredState.windows.map((windowState) => windowState.id)).toEqual([
			'primary',
			'secondary',
		]);
	});

	it('writes sanitized startup state back to the store', () => {
		const windowStateStore = createWindowStateStore({
			primaryWindowId: 'primary',
			windows: [
				{
					id: 'primary',
					x: 0,
					y: 0,
					width: 1400,
					height: 900,
					isMaximized: false,
					isFullScreen: false,
					sessionIds: ['deleted-session'],
					activeSessionId: 'deleted-session',
					leftPanelCollapsed: false,
					rightPanelCollapsed: false,
				},
			],
		});

		const startupWindows = getStartupWindowStates(windowStateStore as never, []);

		expect(startupWindows).toEqual([
			{
				id: 'primary',
				x: 0,
				y: 0,
				width: 1400,
				height: 900,
				isMaximized: false,
				isFullScreen: false,
				sessionIds: [],
				activeSessionId: null,
				leftPanelCollapsed: false,
				rightPanelCollapsed: false,
			},
		]);
		expect(windowStateStore.store.windows[0].activeSessionId).toBeNull();
	});
});
