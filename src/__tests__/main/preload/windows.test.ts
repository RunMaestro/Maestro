/**
 * Tests for the windows preload API.
 *
 * Verifies each method on window.maestro.windows forwards to the matching
 * `windows:*` IPC channel with the expected arguments and returns the invoke
 * result unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createWindowsApi } from '../../../main/preload/windows';

describe('Windows Preload API', () => {
	let api: ReturnType<typeof createWindowsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createWindowsApi();
	});

	it('create forwards sessionIds and bounds', async () => {
		mockInvoke.mockResolvedValue({
			id: 'w1',
			isMain: false,
			sessionIds: ['a'],
			activeSessionId: null,
		});

		const result = await api.create(['a'], { width: 800 });

		expect(mockInvoke).toHaveBeenCalledWith('windows:create', ['a'], { width: 800 });
		expect(result).toEqual({ id: 'w1', isMain: false, sessionIds: ['a'], activeSessionId: null });
	});

	it('create works with no arguments', async () => {
		mockInvoke.mockResolvedValue(null);

		await api.create();

		expect(mockInvoke).toHaveBeenCalledWith('windows:create', undefined, undefined);
	});

	it('close forwards the window id', async () => {
		mockInvoke.mockResolvedValue({ closed: true });

		const result = await api.close('w2');

		expect(mockInvoke).toHaveBeenCalledWith('windows:close', 'w2');
		expect(result).toEqual({ closed: true });
	});

	it('list invokes windows:list', async () => {
		mockInvoke.mockResolvedValue([]);

		await api.list();

		expect(mockInvoke).toHaveBeenCalledWith('windows:list');
	});

	it('getForSession forwards the session id', async () => {
		mockInvoke.mockResolvedValue('w3');

		const result = await api.getForSession('agent-1');

		expect(mockInvoke).toHaveBeenCalledWith('windows:getForSession', 'agent-1');
		expect(result).toBe('w3');
	});

	it('moveSession forwards all three ids', async () => {
		mockInvoke.mockResolvedValue({ moved: true });

		await api.moveSession('agent-1', 'from', 'to');

		expect(mockInvoke).toHaveBeenCalledWith('windows:moveSession', 'agent-1', 'from', 'to');
	});

	it('focusWindow forwards the window id', async () => {
		mockInvoke.mockResolvedValue({ focused: true });

		await api.focusWindow('w4');

		expect(mockInvoke).toHaveBeenCalledWith('windows:focusWindow', 'w4');
	});

	it('getState invokes windows:getState', async () => {
		mockInvoke.mockResolvedValue(null);

		await api.getState();

		expect(mockInvoke).toHaveBeenCalledWith('windows:getState');
	});

	it('setPanelState forwards the panel state', async () => {
		mockInvoke.mockResolvedValue(undefined);

		await api.setPanelState({ leftPanelCollapsed: true, rightPanelCollapsed: false });

		expect(mockInvoke).toHaveBeenCalledWith('windows:setPanelState', {
			leftPanelCollapsed: true,
			rightPanelCollapsed: false,
		});
	});

	it('setPanelState forwards a partial update', async () => {
		mockInvoke.mockResolvedValue(undefined);

		await api.setPanelState({ rightPanelCollapsed: true });

		expect(mockInvoke).toHaveBeenCalledWith('windows:setPanelState', { rightPanelCollapsed: true });
	});

	it('getBounds defaults windowId to undefined', async () => {
		mockInvoke.mockResolvedValue({ x: 0, y: 0, width: 100, height: 100 });

		await api.getBounds();

		expect(mockInvoke).toHaveBeenCalledWith('windows:getBounds', undefined);
	});

	it('getBounds forwards a specific window id', async () => {
		mockInvoke.mockResolvedValue({ x: 0, y: 0, width: 100, height: 100 });

		await api.getBounds('w5');

		expect(mockInvoke).toHaveBeenCalledWith('windows:getBounds', 'w5');
	});

	it('findWindowAtPoint forwards coordinates', async () => {
		mockInvoke.mockResolvedValue('w6');

		const result = await api.findWindowAtPoint(120, 240);

		expect(mockInvoke).toHaveBeenCalledWith('windows:findWindowAtPoint', 120, 240);
		expect(result).toBe('w6');
	});

	it('highlightDropZone forwards the window id and active flag', async () => {
		mockInvoke.mockResolvedValue(undefined);

		await api.highlightDropZone('w7', true);
		expect(mockInvoke).toHaveBeenCalledWith('windows:highlightDropZone', 'w7', true);

		await api.highlightDropZone('w7', false);
		expect(mockInvoke).toHaveBeenCalledWith('windows:highlightDropZone', 'w7', false);
	});

	describe('onHighlightDropZone', () => {
		it('subscribes to the windows:highlightDropZone channel and forwards the payload', () => {
			const callback = vi.fn();

			api.onHighlightDropZone(callback);

			expect(mockOn).toHaveBeenCalledWith('windows:highlightDropZone', expect.any(Function));

			// The preload strips the IPC event arg and hands the renderer just the payload.
			const handler = mockOn.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
			const payload = { windowId: 'w7', active: true };
			handler({}, payload);

			expect(callback).toHaveBeenCalledWith(payload);
		});

		it('returns an unsubscribe function that removes the same listener', () => {
			const callback = vi.fn();

			const unsubscribe = api.onHighlightDropZone(callback);
			const handler = mockOn.mock.calls[0][1];

			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('windows:highlightDropZone', handler);
		});
	});

	describe('onSessionMoved', () => {
		it('subscribes to the windows:sessionMoved channel and forwards the payload', () => {
			const callback = vi.fn();

			api.onSessionMoved(callback);

			expect(mockOn).toHaveBeenCalledWith('windows:sessionMoved', expect.any(Function));

			// The preload strips the IPC event arg and hands the renderer just the payload.
			const handler = mockOn.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
			const payload = {
				type: 'session-moved' as const,
				sessionId: 'agent-1',
				fromWindowId: 'w1',
				toWindowId: 'w2',
			};
			handler({}, payload);

			expect(callback).toHaveBeenCalledWith(payload);
		});

		it('returns an unsubscribe function that removes the same listener', () => {
			const callback = vi.fn();

			const unsubscribe = api.onSessionMoved(callback);
			const handler = mockOn.mock.calls[0][1];

			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('windows:sessionMoved', handler);
		});
	});
});
