import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ available: true }));
vi.mock('../../../renderer/utils/floatingWidgetMode', () => ({
	floatingWidgetsAvailable: () => mode.available,
}));

import {
	installMediaPlaybackAuthority,
	installMediaPlaybackReplica,
	selectMediaPlayerWidgetState,
} from '../../../renderer/stores/mediaPlaybackReplica';
import {
	flushMediaQueuePersist,
	useMediaPlaybackStore,
	MEDIA_QUEUE_SETTINGS_KEY,
	type MediaOpenRequest,
} from '../../../renderer/stores/mediaPlaybackStore';
import { mediaItemId } from '../../../renderer/utils/mediaItems';
import {
	MEDIA_COMMAND_ACTIONS,
	type MediaPlayerWidgetState,
} from '../../../shared/floatingWidgets';

type Listener = (widgetId: string, payload: unknown) => void;

/** A stand-in for `window.maestro.floatingWidgets` that records every call. */
function createFakeApi() {
	const stateListeners = new Set<Listener>();
	const commandListeners = new Set<Listener>();
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
		getState: vi.fn(async () => null),
		onState: vi.fn(subscribe(stateListeners)),
		onCommand: vi.fn(subscribe(commandListeners)),
		emitState: (id: string, state: unknown) => stateListeners.forEach((l) => l(id, state)),
		emitCommand: (id: string, command: unknown) => commandListeners.forEach((l) => l(id, command)),
		listenerCount: () => stateListeners.size + commandListeners.size,
	};
}

function request(overrides: Partial<MediaOpenRequest> = {}): MediaOpenRequest {
	return {
		path: '/files/a.mp3',
		name: 'a.mp3',
		kind: 'audio',
		sessionId: 's1',
		sessionName: 'Agent One',
		...overrides,
	};
}

const initial = useMediaPlaybackStore.getState();
let api: ReturnType<typeof createFakeApi>;
let settingsSet: ReturnType<typeof vi.fn>;
let uninstall: (() => void) | null = null;

beforeEach(() => {
	vi.useFakeTimers();
	mode.available = true;
	api = createFakeApi();
	settingsSet = vi.fn();
	(window as unknown as { maestro: unknown }).maestro = {
		settings: { set: settingsSet },
		floatingWidgets: api,
	};
	useMediaPlaybackStore.setState(initial, true);
});

afterEach(() => {
	uninstall?.();
	uninstall = null;
	flushMediaQueuePersist();
	vi.useRealTimers();
});

describe('installMediaPlaybackReplica', () => {
	it('forwards a command and changes nothing locally', () => {
		uninstall = installMediaPlaybackReplica();
		const before = selectMediaPlayerWidgetState(useMediaPlaybackStore.getState());

		useMediaPlaybackStore.getState().openMedia(request());

		expect(api.sendCommand).toHaveBeenCalledWith('media-player', {
			type: 'action',
			action: 'openMedia',
			args: [request()],
		});
		expect(selectMediaPlayerWidgetState(useMediaPlaybackStore.getState())).toEqual(before);
	});

	it('forwards every COMMAND action under its own name', () => {
		uninstall = installMediaPlaybackReplica();
		const state = useMediaPlaybackStore.getState() as unknown as Record<
			string,
			(...args: unknown[]) => unknown
		>;
		for (const action of MEDIA_COMMAND_ACTIONS) state[action]('x');
		expect(api.sendCommand.mock.calls.map(([, command]) => command.action)).toEqual([
			...MEDIA_COMMAND_ACTIONS,
		]);
	});

	it('returns the number of requests sent from enqueueMedia', () => {
		uninstall = installMediaPlaybackReplica();
		const count = useMediaPlaybackStore
			.getState()
			.enqueueMedia([request(), request({ path: '/files/b.mp3' })]);
		expect(count).toBe(2);
		expect(useMediaPlaybackStore.getState().items).toEqual([]);
	});

	it('leaves element reports local', () => {
		uninstall = installMediaPlaybackReplica();
		useMediaPlaybackStore.getState().setPlaying(true);
		expect(useMediaPlaybackStore.getState().playing).toBe(true);
		expect(api.sendCommand).not.toHaveBeenCalled();
	});

	it('mirrors a published snapshot into the store', () => {
		uninstall = installMediaPlaybackReplica();
		const item = { ...request(), id: mediaItemId('s1', '/files/a.mp3') };
		const snapshot: MediaPlayerWidgetState = {
			items: [item],
			activeItemId: item.id,
			history: [],
			playing: true,
			dismissed: false,
			dormant: false,
		};

		api.emitState('media-player', { ...snapshot, resumeTimes: { [item.id]: 99 } });

		const state = useMediaPlaybackStore.getState();
		expect(selectMediaPlayerWidgetState(state)).toEqual(snapshot);
		// Only the snapshot's own fields are applied.
		expect(state.resumeTimes).toEqual({});
	});

	it('never writes the persisted queue', () => {
		uninstall = installMediaPlaybackReplica();
		const state = useMediaPlaybackStore.getState();
		// Element reports still run locally and would schedule a write.
		state.rememberTime('x', 12);
		state.rememberDuration('x', 60);
		vi.runAllTimers();
		flushMediaQueuePersist();
		expect(settingsSet).not.toHaveBeenCalledWith(MEDIA_QUEUE_SETTINGS_KEY, expect.anything());
	});

	it('drops a queue write that was pending when it installed', () => {
		useMediaPlaybackStore.getState().openMedia(request());
		uninstall = installMediaPlaybackReplica();
		vi.runAllTimers();
		expect(settingsSet).not.toHaveBeenCalledWith(MEDIA_QUEUE_SETTINGS_KEY, expect.anything());
	});

	it('uninstall restores the original actions and persistence', () => {
		const originals = MEDIA_COMMAND_ACTIONS.map(
			(action) => useMediaPlaybackStore.getState()[action]
		);
		installMediaPlaybackReplica()();

		const state = useMediaPlaybackStore.getState();
		expect(MEDIA_COMMAND_ACTIONS.map((action) => state[action])).toEqual(originals);
		expect(api.listenerCount()).toBe(0);

		state.openMedia(request());
		expect(useMediaPlaybackStore.getState().activeItemId).toBe(mediaItemId('s1', '/files/a.mp3'));
		vi.runAllTimers();
		expect(settingsSet).toHaveBeenCalledWith(MEDIA_QUEUE_SETTINGS_KEY, expect.anything());
	});

	it('does nothing outside the desktop app', () => {
		mode.available = false;
		const openMedia = useMediaPlaybackStore.getState().openMedia;
		uninstall = installMediaPlaybackReplica();
		expect(useMediaPlaybackStore.getState().openMedia).toBe(openMedia);
	});
});

describe('installMediaPlaybackAuthority', () => {
	it('publishes the snapshot', () => {
		uninstall = installMediaPlaybackAuthority();
		expect(api.publishState).toHaveBeenCalledWith(
			'media-player',
			selectMediaPlayerWidgetState(useMediaPlaybackStore.getState())
		);
	});

	it('applies a valid command to its own store', () => {
		uninstall = installMediaPlaybackAuthority();
		api.emitCommand('media-player', { type: 'action', action: 'openMedia', args: [request()] });
		expect(useMediaPlaybackStore.getState().activeItemId).toBe(mediaItemId('s1', '/files/a.mp3'));
	});

	it('drops a command outside the COMMAND union', () => {
		uninstall = installMediaPlaybackAuthority();
		api.emitCommand('media-player', { type: 'action', action: 'setPlaying', args: [true] });
		api.emitCommand('media-player', { type: 'action', action: 'openMedia' });
		expect(useMediaPlaybackStore.getState().playing).toBe(false);
		expect(useMediaPlaybackStore.getState().items).toEqual([]);
	});

	it('uninstall stops listening', () => {
		installMediaPlaybackAuthority()();
		expect(api.listenerCount()).toBe(0);
		api.emitCommand('media-player', { type: 'action', action: 'openMedia', args: [request()] });
		expect(useMediaPlaybackStore.getState().items).toEqual([]);
	});
});
