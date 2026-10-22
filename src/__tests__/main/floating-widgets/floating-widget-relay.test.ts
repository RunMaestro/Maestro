/**
 * Floating widget relay tests.
 *
 * Driven two ways: through the IPC handlers `init()` registers on a mocked
 * `ipcMain` (what the renderers actually hit), and through the core methods
 * and pure helpers directly.
 *
 * - Unknown widget ids are refused on every channel.
 * - Published state is cached per widget and forwarded to every other live
 *   window, never echoed back to the sender; `getState` returns the latest.
 * - A command to an authority that is not ready yet is queued, delivered in
 *   order once that window says it is ready, and capped at
 *   `MAX_QUEUED_COMMANDS` (oldest dropped). A command to a ready authority
 *   goes straight through.
 * - A destroyed window or webContents is skipped without throwing.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { FloatingWidgetId } from '../../../shared/floatingWidgets';

type Listener = (...args: unknown[]) => unknown;

const { handlers, listeners } = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, fn: Listener) => {
			handlers.set(channel, fn);
		}),
		on: vi.fn((channel: string, fn: Listener) => {
			listeners.set(channel, fn);
		}),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ipcMain } from 'electron';
import { logger } from '../../../main/utils/logger';
import {
	createFloatingWidgetRelay,
	enqueueBounded,
	stateRecipients,
	requireFloatingWidgetId,
	MAX_QUEUED_COMMANDS,
	FLOATING_WIDGET_STATE_CHANNEL,
	FLOATING_WIDGET_COMMAND_CHANNEL,
} from '../../../main/floating-widgets/floating-widget-relay';
import type { FloatingWidgetController } from '../../../main/floating-widgets/floating-widget-window';

type FakeWindow = {
	destroyed: boolean;
	isDestroyed: () => boolean;
	webContents: {
		id: number;
		destroyed: boolean;
		isDestroyed: () => boolean;
		send: ReturnType<typeof vi.fn>;
	};
};

function makeWindow(id: number): FakeWindow {
	const win: FakeWindow = {
		destroyed: false,
		isDestroyed: () => win.destroyed,
		webContents: {
			id,
			destroyed: false,
			isDestroyed: () => win.webContents.destroyed,
			send: vi.fn(),
		},
	};
	return win;
}

const asWindow = (win: FakeWindow | null) => win as unknown as BrowserWindow;

type FakeController = {
	[K in keyof FloatingWidgetController]: FloatingWidgetController[K] extends (
		...args: never[]
	) => unknown
		? Mock<FloatingWidgetController[K]>
		: FloatingWidgetController[K];
};

/**
 * A controller stand-in. `ensureCreated()` creates `window` the first time it
 * is called (like the real lazy window), unless the widget is `disabled`.
 */
function makeController(id: FloatingWidgetId, windowId: number) {
	const state = { ready: false, window: null as FakeWindow | null, disabled: false };
	const controller: FakeController = {
		id,
		show: vi.fn(),
		hide: vi.fn(),
		toggle: vi.fn(),
		isVisible: vi.fn(() => false),
		ensureCreated: vi.fn(() => {
			if (state.disabled) return null;
			state.window ??= makeWindow(windowId);
			return asWindow(state.window);
		}),
		getWindow: vi.fn(() => (state.window ? asWindow(state.window) : null)),
		getBounds: vi.fn(() => null),
		setBounds: vi.fn(() => ({ x: 1, y: 2, width: 300, height: 200 })),
		isReady: vi.fn(() => state.ready),
		markReady: vi.fn(() => {
			state.ready = true;
		}),
		close: vi.fn(),
	};
	return { controller, state };
}

function setup() {
	const appWindow = makeWindow(1);
	const otherAppWindow = makeWindow(2);
	const gauge = makeController('throughput-gauge', 10);
	const media = makeController('media-player', 20);
	const authorities: Record<FloatingWidgetId, FakeWindow | null> = {
		'throughput-gauge': appWindow,
		'media-player': null,
	};
	const relay = createFloatingWidgetRelay({
		controllers: {
			'throughput-gauge': gauge.controller as unknown as FloatingWidgetController,
			'media-player': media.controller as unknown as FloatingWidgetController,
		},
		// Like the real wiring: the media player's authority is its own window.
		getAuthorityWindow: (id) =>
			id === 'media-player'
				? media.controller.getWindow()
				: authorities[id]
					? asWindow(authorities[id])
					: null,
		getAllWindows: () =>
			[appWindow, otherAppWindow, gauge.state.window, media.state.window]
				.filter((w): w is FakeWindow => w !== null)
				.map(asWindow),
	});
	return { relay, appWindow, otherAppWindow, gauge, media, authorities };
}

const sender = (id: number) => ({ sender: { id } });

/** The `(id, payload)` pairs a window received on one channel. */
function received(win: FakeWindow, channel: string): unknown[][] {
	return win.webContents.send.mock.calls
		.filter(([sent]) => sent === channel)
		.map(([, ...args]) => args);
}

beforeEach(() => {
	handlers.clear();
	listeners.clear();
	vi.clearAllMocks();
});

describe('pure helpers', () => {
	it('requireFloatingWidgetId passes known ids and throws on anything else', () => {
		expect(requireFloatingWidgetId('media-player')).toBe('media-player');
		expect(() => requireFloatingWidgetId('nope')).toThrow('Unknown floating widget: nope');
		expect(() => requireFloatingWidgetId(undefined)).toThrow(/Unknown floating widget/);
		expect(() => requireFloatingWidgetId(42)).toThrow(/Unknown floating widget/);
	});

	it('enqueueBounded appends and drops the oldest past the cap', () => {
		const queue = [1, 2, 3];
		expect(enqueueBounded(queue, 4, 5)).toBe(0);
		expect(queue).toEqual([1, 2, 3, 4]);
		expect(enqueueBounded(queue, 5, 3)).toBe(2);
		expect(queue).toEqual([3, 4, 5]);
	});

	it('stateRecipients keeps live windows other than the sender', () => {
		const a = makeWindow(1);
		const b = makeWindow(2);
		const gone = makeWindow(3);
		gone.destroyed = true;
		const deadContents = makeWindow(4);
		deadContents.webContents.destroyed = true;
		const windows = [a, b, gone, deadContents, null, undefined].map((w) => (w ? asWindow(w) : w));
		expect(stateRecipients(windows, 1)).toEqual([asWindow(b)]);
		expect(stateRecipients(windows, undefined)).toEqual([asWindow(a), asWindow(b)]);
	});
});

describe('init', () => {
	it('registers every channel once, even when called twice', () => {
		const { relay } = setup();
		relay.init();
		relay.init();
		expect([...handlers.keys()].sort()).toEqual(
			[
				'floatingWidgets:getBounds',
				'floatingWidgets:getState',
				'floatingWidgets:hide',
				'floatingWidgets:isVisible',
				'floatingWidgets:setBounds',
				'floatingWidgets:show',
				'floatingWidgets:toggle',
			].sort()
		);
		expect([...listeners.keys()].sort()).toEqual(
			[
				FLOATING_WIDGET_COMMAND_CHANNEL,
				'floatingWidgets:publishState',
				'floatingWidgets:ready',
			].sort()
		);
		expect(ipcMain.handle).toHaveBeenCalledTimes(7);
		expect(ipcMain.on).toHaveBeenCalledTimes(3);
	});
});

describe('unknown ids', () => {
	it('every handle channel rejects an unknown id', () => {
		const { relay, gauge, media } = setup();
		relay.init();
		for (const [channel, fn] of handlers) {
			expect(() => fn(sender(1), 'not-a-widget', {}), channel).toThrow(
				'Unknown floating widget: not-a-widget'
			);
		}
		for (const c of [gauge.controller, media.controller]) {
			expect(c.show).not.toHaveBeenCalled();
			expect(c.hide).not.toHaveBeenCalled();
			expect(c.toggle).not.toHaveBeenCalled();
			expect(c.setBounds).not.toHaveBeenCalled();
		}
	});

	it('every on channel logs and drops an unknown id', () => {
		const { relay, appWindow, otherAppWindow, gauge, media } = setup();
		relay.init();
		listeners.get('floatingWidgets:publishState')!(sender(1), 'bogus', { rate: 1 });
		listeners.get(FLOATING_WIDGET_COMMAND_CHANNEL)!(sender(1), 'bogus', { type: 'play' });
		listeners.get('floatingWidgets:ready')!(sender(1), 'bogus');

		expect(logger.warn).toHaveBeenCalledTimes(3);
		expect(appWindow.webContents.send).not.toHaveBeenCalled();
		expect(otherAppWindow.webContents.send).not.toHaveBeenCalled();
		expect(media.controller.ensureCreated).not.toHaveBeenCalled();
		expect(gauge.controller.markReady).not.toHaveBeenCalled();
		expect(media.controller.markReady).not.toHaveBeenCalled();
	});
});

describe('window control channels', () => {
	it('show, hide and toggle drive the controller and return its visibility', async () => {
		const { relay, gauge } = setup();
		relay.init();
		gauge.controller.isVisible.mockReturnValue(true);
		expect(await handlers.get('floatingWidgets:show')!(sender(1), 'throughput-gauge')).toBe(true);
		expect(gauge.controller.show).toHaveBeenCalledTimes(1);

		gauge.controller.isVisible.mockReturnValue(false);
		expect(await handlers.get('floatingWidgets:hide')!(sender(1), 'throughput-gauge')).toBe(false);
		expect(gauge.controller.hide).toHaveBeenCalledTimes(1);

		expect(await handlers.get('floatingWidgets:toggle')!(sender(1), 'throughput-gauge')).toBe(
			false
		);
		expect(gauge.controller.toggle).toHaveBeenCalledTimes(1);
		expect(handlers.get('floatingWidgets:isVisible')!(sender(1), 'throughput-gauge')).toBe(false);
	});

	it('getBounds and setBounds pass through, and setBounds refuses a non-object', () => {
		const { relay, media } = setup();
		relay.init();
		media.controller.getBounds.mockReturnValue({ x: 5, y: 6, width: 420, height: 96 });
		expect(handlers.get('floatingWidgets:getBounds')!(sender(1), 'media-player')).toEqual({
			x: 5,
			y: 6,
			width: 420,
			height: 96,
		});

		const result = handlers.get('floatingWidgets:setBounds')!(sender(1), 'media-player', {
			width: 500,
		});
		expect(media.controller.setBounds).toHaveBeenCalledWith({ width: 500 });
		expect(result).toEqual({ x: 1, y: 2, width: 300, height: 200 });

		for (const bad of [null, undefined, 'wide', 12]) {
			expect(() =>
				handlers.get('floatingWidgets:setBounds')!(sender(1), 'media-player', bad)
			).toThrow('Floating widget bounds must be an object');
		}
		expect(media.controller.setBounds).toHaveBeenCalledTimes(1);
	});
});

describe('state', () => {
	it('forwards published state to every other live window, not back to the sender', () => {
		const { relay, appWindow, otherAppWindow, gauge } = setup();
		gauge.controller.ensureCreated();
		relay.init();

		listeners.get('floatingWidgets:publishState')!(sender(1), 'throughput-gauge', { rate: 42 });

		expect(received(appWindow, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([]);
		expect(received(otherAppWindow, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([
			['throughput-gauge', { rate: 42 }],
		]);
		expect(received(gauge.state.window!, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([
			['throughput-gauge', { rate: 42 }],
		]);
	});

	it('getState returns the latest snapshot per widget, or null before any', async () => {
		const { relay } = setup();
		relay.init();
		const getState = handlers.get('floatingWidgets:getState')!;
		expect(await getState(sender(1), 'throughput-gauge')).toBeNull();

		const publish = listeners.get('floatingWidgets:publishState')!;
		publish(sender(1), 'throughput-gauge', { rate: 1 });
		publish(sender(1), 'throughput-gauge', { rate: 2 });
		publish(sender(20), 'media-player', { playing: true });

		expect(await getState(sender(2), 'throughput-gauge')).toEqual({ rate: 2 });
		expect(await getState(sender(2), 'media-player')).toEqual({ playing: true });
		expect(relay.getState('throughput-gauge')).toEqual({ rate: 2 });
	});

	it('a publish with no sender reaches every live window', () => {
		const { relay, appWindow, otherAppWindow } = setup();
		relay.publishState('throughput-gauge', { rate: 7 });
		expect(received(appWindow, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([
			['throughput-gauge', { rate: 7 }],
		]);
		expect(received(otherAppWindow, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([
			['throughput-gauge', { rate: 7 }],
		]);
	});
});

describe('commands', () => {
	it('queue for a widget authority that is not ready, then deliver in order on ready', () => {
		const { relay, appWindow, media } = setup();
		relay.init();
		const command = listeners.get(FLOATING_WIDGET_COMMAND_CHANNEL)!;

		command(sender(1), 'media-player', { type: 'load', src: 'a.mp3' });
		command(sender(1), 'media-player', { type: 'play' });
		command(sender(2), 'media-player', { type: 'seek', to: 30 });

		// The window was created (not shown) to take the commands, and holds them.
		expect(media.controller.ensureCreated).toHaveBeenCalled();
		expect(media.controller.show).not.toHaveBeenCalled();
		expect(relay.pendingCommandCount('media-player')).toBe(3);
		expect(media.state.window!.webContents.send).not.toHaveBeenCalled();
		expect(appWindow.webContents.send).not.toHaveBeenCalled();

		listeners.get('floatingWidgets:ready')!(sender(20), 'media-player');

		expect(media.controller.markReady).toHaveBeenCalledTimes(1);
		expect(received(media.state.window!, FLOATING_WIDGET_COMMAND_CHANNEL)).toEqual([
			['media-player', { type: 'load', src: 'a.mp3' }],
			['media-player', { type: 'play' }],
			['media-player', { type: 'seek', to: 30 }],
		]);
		expect(relay.pendingCommandCount('media-player')).toBe(0);
	});

	it('a command to a ready widget authority goes straight through', () => {
		const { relay, media } = setup();
		media.controller.ensureCreated();
		relay.markReady('media-player', 20);

		expect(relay.sendCommand('media-player', { type: 'pause' })).toBe('sent');
		expect(received(media.state.window!, FLOATING_WIDGET_COMMAND_CHANNEL)).toEqual([
			['media-player', { type: 'pause' }],
		]);
		expect(relay.pendingCommandCount('media-player')).toBe(0);
	});

	it('a command to an app authority goes straight to that window', () => {
		const { relay, appWindow, otherAppWindow, gauge } = setup();
		expect(relay.sendCommand('throughput-gauge', { type: 'reset' })).toBe('sent');
		expect(received(appWindow, FLOATING_WIDGET_COMMAND_CHANNEL)).toEqual([
			['throughput-gauge', { type: 'reset' }],
		]);
		expect(otherAppWindow.webContents.send).not.toHaveBeenCalled();
		// The app authority never spawns the widget window to take a command.
		expect(gauge.controller.ensureCreated).not.toHaveBeenCalled();
	});

	it('caps the queue at MAX_QUEUED_COMMANDS, dropping the oldest with a warning', () => {
		const { relay, media } = setup();
		const total = MAX_QUEUED_COMMANDS + 5;
		for (let n = 0; n < total; n++) {
			expect(relay.sendCommand('media-player', { n })).toBe('queued');
		}
		expect(relay.pendingCommandCount('media-player')).toBe(MAX_QUEUED_COMMANDS);
		expect(logger.warn).toHaveBeenCalledTimes(5);

		relay.markReady('media-player', 20);
		const delivered = received(media.state.window!, FLOATING_WIDGET_COMMAND_CHANNEL);
		expect(delivered).toHaveLength(MAX_QUEUED_COMMANDS);
		expect(delivered[0]).toEqual(['media-player', { n: 5 }]);
		expect(delivered.at(-1)).toEqual(['media-player', { n: total - 1 }]);
	});

	it('ignores a ready signal from any window but the widget its own', () => {
		const { relay, media } = setup();
		relay.sendCommand('media-player', { type: 'play' });

		relay.markReady('media-player', 1);

		expect(media.controller.markReady).not.toHaveBeenCalled();
		expect(relay.pendingCommandCount('media-player')).toBe(1);
		expect(media.state.window!.webContents.send).not.toHaveBeenCalled();
	});

	it('drops a command when the widget window cannot be created', () => {
		const { relay, media } = setup();
		media.state.disabled = true;
		expect(relay.sendCommand('media-player', { type: 'play' })).toBe('dropped');
		expect(relay.pendingCommandCount('media-player')).toBe(0);
		expect(logger.warn).toHaveBeenCalled();
	});

	it('drops a command when the app authority is missing', () => {
		const { relay, authorities } = setup();
		authorities['throughput-gauge'] = null;
		expect(relay.sendCommand('throughput-gauge', { type: 'reset' })).toBe('dropped');
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe('dead windows', () => {
	it('skips a destroyed webContents when forwarding state, without throwing', () => {
		const { relay, appWindow, otherAppWindow } = setup();
		otherAppWindow.webContents.destroyed = true;
		expect(() => relay.publishState('throughput-gauge', { rate: 3 }, 99)).not.toThrow();
		expect(otherAppWindow.webContents.send).not.toHaveBeenCalled();
		expect(received(appWindow, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([
			['throughput-gauge', { rate: 3 }],
		]);
	});

	it('survives a send that throws mid-teardown and keeps going', () => {
		const { relay, appWindow, otherAppWindow } = setup();
		appWindow.webContents.send.mockImplementation(() => {
			throw new Error('Render frame was disposed');
		});
		expect(() => relay.publishState('throughput-gauge', { rate: 4 })).not.toThrow();
		expect(received(otherAppWindow, FLOATING_WIDGET_STATE_CHANNEL)).toEqual([
			['throughput-gauge', { rate: 4 }],
		]);
		expect(relay.sendCommand('throughput-gauge', { type: 'reset' })).toBe('dropped');
	});

	it('drops a command to an app authority whose webContents is destroyed', () => {
		const { relay, appWindow } = setup();
		appWindow.webContents.destroyed = true;
		expect(() => relay.sendCommand('throughput-gauge', { type: 'reset' })).not.toThrow();
		expect(relay.sendCommand('throughput-gauge', { type: 'reset' })).toBe('dropped');
		expect(appWindow.webContents.send).not.toHaveBeenCalled();
	});

	it('does not release queued commands into a widget window that died before ready', () => {
		const { relay, media } = setup();
		relay.sendCommand('media-player', { type: 'play' });
		media.state.window!.webContents.destroyed = true;

		expect(() => relay.markReady('media-player', 20)).not.toThrow();
		expect(media.controller.markReady).not.toHaveBeenCalled();
		expect(media.state.window!.webContents.send).not.toHaveBeenCalled();
	});
});
