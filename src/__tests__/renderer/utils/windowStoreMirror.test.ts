import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

const mode = vi.hoisted(() => ({ available: true }));
vi.mock('../../../renderer/utils/floatingWidgetMode', () => ({
	floatingWidgetsAvailable: () => mode.available,
}));

import {
	PUBLISH_INTERVAL_MS,
	mirrorStoreState,
	onWidgetCommand,
	publishStoreState,
	sendWidgetCommand,
} from '../../../renderer/utils/windowStoreMirror';

type Listener = (widgetId: string, payload: unknown) => void;

/** A stand-in for `window.maestro.floatingWidgets` that records every call. */
function createFakeApi() {
	const stateListeners = new Set<Listener>();
	const commandListeners = new Set<Listener>();
	let seed: unknown = null;
	const subscribe = (set: Set<Listener>) => (id: string, cb: (payload: unknown) => void) => {
		const listener: Listener = (widgetId, payload) => {
			if (widgetId === id) cb(payload);
		};
		set.add(listener);
		return () => set.delete(listener);
	};
	return {
		publishState: vi.fn(),
		sendCommand: vi.fn(),
		getState: vi.fn(async () => seed),
		onState: vi.fn(subscribe(stateListeners)),
		onCommand: vi.fn(subscribe(commandListeners)),
		setSeed: (value: unknown) => {
			seed = value;
		},
		emitState: (id: string, state: unknown) => stateListeners.forEach((l) => l(id, state)),
		emitCommand: (id: string, command: unknown) => commandListeners.forEach((l) => l(id, command)),
		listenerCount: () => stateListeners.size + commandListeners.size,
	};
}

const maestro = window.maestro as unknown as Record<string, unknown>;
const original = maestro.floatingWidgets;
let api: ReturnType<typeof createFakeApi>;

beforeEach(() => {
	vi.useFakeTimers();
	mode.available = true;
	api = createFakeApi();
	maestro.floatingWidgets = api;
});

afterEach(() => {
	vi.useRealTimers();
	maestro.floatingWidgets = original;
});

interface GaugeState {
	rate: number;
	peak: number;
	label: string;
}

const gaugeStore = () => createStore<GaugeState>(() => ({ rate: 0, peak: 0, label: 'a' }));
const selectRates = (s: GaugeState) => ({ rate: s.rate, peak: s.peak });

describe('publishStoreState', () => {
	it('publishes the selection once immediately', () => {
		const store = gaugeStore();
		publishStoreState('throughput-gauge', store, selectRates);
		expect(api.publishState).toHaveBeenCalledTimes(1);
		expect(api.publishState).toHaveBeenCalledWith('throughput-gauge', { rate: 0, peak: 0 });
	});

	it('coalesces a burst to one publish per interval carrying the latest selection', () => {
		const store = gaugeStore();
		publishStoreState('throughput-gauge', store, selectRates);
		store.setState({ rate: 1 });
		store.setState({ rate: 2 });
		store.setState({ rate: 3 });
		expect(api.publishState).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(PUBLISH_INTERVAL_MS);
		expect(api.publishState).toHaveBeenCalledTimes(2);
		expect(api.publishState).toHaveBeenLastCalledWith('throughput-gauge', { rate: 3, peak: 0 });
	});

	it('publishes at once when the interval since the last publish has passed', () => {
		const store = gaugeStore();
		publishStoreState('throughput-gauge', store, selectRates);
		vi.advanceTimersByTime(PUBLISH_INTERVAL_MS);
		store.setState({ peak: 9 });
		expect(api.publishState).toHaveBeenCalledTimes(2);
		expect(api.publishState).toHaveBeenLastCalledWith('throughput-gauge', { rate: 0, peak: 9 });
	});

	it('does not publish when the selection is shallow-equal', () => {
		const store = gaugeStore();
		publishStoreState('throughput-gauge', store, selectRates);
		store.setState({ label: 'b' });
		vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 3);
		expect(api.publishState).toHaveBeenCalledTimes(1);
	});

	it('skips the trailing publish when the selection returned to the published value', () => {
		const store = gaugeStore();
		publishStoreState('throughput-gauge', store, selectRates);
		store.setState({ rate: 5 });
		store.setState({ rate: 0 });
		vi.advanceTimersByTime(PUBLISH_INTERVAL_MS);
		expect(api.publishState).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes and cancels a pending publish', () => {
		const store = gaugeStore();
		const stop = publishStoreState('throughput-gauge', store, selectRates);
		store.setState({ rate: 1 });
		stop();
		vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 2);
		store.setState({ rate: 2 });
		vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 2);
		expect(api.publishState).toHaveBeenCalledTimes(1);
	});
});

describe('mirrorStoreState', () => {
	const toState = (snapshot: { rate: number }) => ({ rate: snapshot.rate });

	it('seeds the store from the latest published state', async () => {
		api.setSeed({ rate: 7 });
		const store = gaugeStore();
		mirrorStoreState('throughput-gauge', store, toState);
		await vi.runAllTimersAsync();
		expect(api.getState).toHaveBeenCalledWith('throughput-gauge');
		expect(store.getState()).toEqual({ rate: 7, peak: 0, label: 'a' });
	});

	it('leaves the store alone when nothing was published yet', async () => {
		const store = gaugeStore();
		mirrorStoreState('throughput-gauge', store, toState);
		await vi.runAllTimersAsync();
		expect(store.getState().rate).toBe(0);
	});

	it('applies every snapshot for its own widget only', () => {
		const store = gaugeStore();
		mirrorStoreState('throughput-gauge', store, toState);
		api.emitState('throughput-gauge', { rate: 4 });
		expect(store.getState().rate).toBe(4);
		api.emitState('media-player', { rate: 99 });
		expect(store.getState().rate).toBe(4);
	});

	it('drops a seed that resolves after a live snapshot', async () => {
		api.setSeed({ rate: 1 });
		const store = gaugeStore();
		mirrorStoreState('throughput-gauge', store, toState);
		api.emitState('throughput-gauge', { rate: 8 });
		await vi.runAllTimersAsync();
		expect(store.getState().rate).toBe(8);
	});

	it('never publishes back', async () => {
		api.setSeed({ rate: 3 });
		const store = gaugeStore();
		mirrorStoreState('throughput-gauge', store, toState);
		api.emitState('throughput-gauge', { rate: 6 });
		await vi.runAllTimersAsync();
		expect(api.publishState).not.toHaveBeenCalled();
		expect(api.sendCommand).not.toHaveBeenCalled();
	});

	it('unsubscribes and ignores a seed that resolves after it', async () => {
		api.setSeed({ rate: 2 });
		const store = gaugeStore();
		const stop = mirrorStoreState('throughput-gauge', store, toState);
		stop();
		await vi.runAllTimersAsync();
		api.emitState('throughput-gauge', { rate: 5 });
		expect(store.getState().rate).toBe(0);
		expect(api.listenerCount()).toBe(0);
	});
});

describe('commands', () => {
	it('sends a command to the widget', () => {
		sendWidgetCommand('media-player', { action: 'pause', args: [] });
		expect(api.sendCommand).toHaveBeenCalledWith('media-player', { action: 'pause', args: [] });
	});

	it('delivers commands for its own widget until unsubscribed', () => {
		const handler = vi.fn();
		const stop = onWidgetCommand('throughput-gauge', handler);
		api.emitCommand('throughput-gauge', 'hide');
		api.emitCommand('media-player', 'pause');
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith('hide');
		stop();
		api.emitCommand('throughput-gauge', 'reset-peak');
		expect(handler).toHaveBeenCalledTimes(1);
		expect(api.listenerCount()).toBe(0);
	});
});

describe('when floating widgets are unavailable', () => {
	beforeEach(() => {
		mode.available = false;
	});

	it('does nothing and returns no-op unsubscribes', async () => {
		const store = gaugeStore();
		const stops = [
			publishStoreState('throughput-gauge', store, selectRates),
			mirrorStoreState('throughput-gauge', store, (s: { rate: number }) => s),
			onWidgetCommand('throughput-gauge', vi.fn()),
		];
		sendWidgetCommand('media-player', 'play');
		store.setState({ rate: 1 });
		await vi.runAllTimersAsync();
		stops.forEach((stop) => stop());
		expect(api.publishState).not.toHaveBeenCalled();
		expect(api.getState).not.toHaveBeenCalled();
		expect(api.onState).not.toHaveBeenCalled();
		expect(api.onCommand).not.toHaveBeenCalled();
		expect(api.sendCommand).not.toHaveBeenCalled();
	});
});
