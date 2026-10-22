/**
 * Tests for the floating widgets preload API.
 *
 * Verifies each method on window.maestro.floatingWidgets forwards to the
 * matching `floatingWidgets:*` IPC channel with its arguments, and that the
 * state and command subscriptions call back only for their own widget and
 * detach on unsubscribe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
const mockSend = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		send: (...args: unknown[]) => mockSend(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createFloatingWidgetsApi } from '../../../main/preload/floatingWidgets';

/** The handler the API registered on `channel` (the most recent one). */
function handlerFor(channel: string): (...args: unknown[]) => void {
	const call = mockOn.mock.calls.filter(([registered]) => registered === channel).at(-1);
	if (!call) throw new Error(`No listener on ${channel}`);
	return call[1] as (...args: unknown[]) => void;
}

describe('Floating widgets preload API', () => {
	let api: ReturnType<typeof createFloatingWidgetsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createFloatingWidgetsApi();
	});

	describe('window control', () => {
		it.each(['show', 'hide', 'toggle', 'isVisible'] as const)(
			'%s invokes its channel with the id and returns the result',
			async (method) => {
				mockInvoke.mockResolvedValue(true);

				const result = await api[method]('throughput-gauge');

				expect(mockInvoke).toHaveBeenCalledWith(`floatingWidgets:${method}`, 'throughput-gauge');
				expect(result).toBe(true);
			}
		);

		it('getBounds invokes with the id and returns the rectangle', async () => {
			const rect = { x: 10, y: 20, width: 300, height: 220 };
			mockInvoke.mockResolvedValue(rect);

			const result = await api.getBounds('media-player');

			expect(mockInvoke).toHaveBeenCalledWith('floatingWidgets:getBounds', 'media-player');
			expect(result).toEqual(rect);
		});

		it('setBounds passes the id and the partial bounds', async () => {
			mockInvoke.mockResolvedValue({ x: 0, y: 0, width: 500, height: 96 });

			const result = await api.setBounds('media-player', { width: 500 });

			expect(mockInvoke).toHaveBeenCalledWith('floatingWidgets:setBounds', 'media-player', {
				width: 500,
			});
			expect(result).toEqual({ x: 0, y: 0, width: 500, height: 96 });
		});
	});

	describe('state', () => {
		it('getState invokes with the id and returns the latest state', async () => {
			mockInvoke.mockResolvedValue({ peak: 42 });

			const result = await api.getState<{ peak: number }>('throughput-gauge');

			expect(mockInvoke).toHaveBeenCalledWith('floatingWidgets:getState', 'throughput-gauge');
			expect(result).toEqual({ peak: 42 });
		});

		it('publishState sends the id and the state', () => {
			api.publishState('throughput-gauge', { peak: 7 });

			expect(mockSend).toHaveBeenCalledWith('floatingWidgets:publishState', 'throughput-gauge', {
				peak: 7,
			});
		});

		it('onState calls back only for its own widget', () => {
			const callback = vi.fn();
			api.onState('throughput-gauge', callback);
			const handler = handlerFor('floatingWidgets:state');

			handler({}, 'media-player', { playing: true });
			handler({}, 'throughput-gauge', { peak: 3 });

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith({ peak: 3 });
		});

		it('onState returns an unsubscribe that removes the same handler', () => {
			const unsubscribe = api.onState('throughput-gauge', vi.fn());
			const handler = handlerFor('floatingWidgets:state');

			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('floatingWidgets:state', handler);
		});
	});

	describe('commands', () => {
		it('sendCommand sends the id and the command', () => {
			api.sendCommand('media-player', { type: 'pause' });

			expect(mockSend).toHaveBeenCalledWith('floatingWidgets:command', 'media-player', {
				type: 'pause',
			});
		});

		it('onCommand calls back only for its own widget', () => {
			const callback = vi.fn();
			api.onCommand('media-player', callback);
			const handler = handlerFor('floatingWidgets:command');

			handler({}, 'throughput-gauge', { type: 'reset-peak' });
			handler({}, 'media-player', { type: 'pause' });

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith({ type: 'pause' });
		});

		it('onCommand returns an unsubscribe that removes the same handler', () => {
			const unsubscribe = api.onCommand('media-player', vi.fn());
			const handler = handlerFor('floatingWidgets:command');

			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('floatingWidgets:command', handler);
		});

		it('two subscriptions for different widgets stay independent', () => {
			const gauge = vi.fn();
			const player = vi.fn();
			api.onCommand('throughput-gauge', gauge);
			const gaugeHandler = handlerFor('floatingWidgets:command');
			api.onCommand('media-player', player);
			const playerHandler = handlerFor('floatingWidgets:command');

			gaugeHandler({}, 'throughput-gauge', { type: 'hide' });
			playerHandler({}, 'throughput-gauge', { type: 'hide' });

			expect(gauge).toHaveBeenCalledTimes(1);
			expect(player).not.toHaveBeenCalled();
		});

		it('ready sends the id', () => {
			api.ready('media-player');

			expect(mockSend).toHaveBeenCalledWith('floatingWidgets:ready', 'media-player');
		});
	});
});
