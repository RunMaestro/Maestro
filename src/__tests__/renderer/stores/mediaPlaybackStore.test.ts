import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	flushMediaQueuePersist,
	selectActiveMediaItem,
	selectCanRestoreFloatingPlayer,
	useMediaPlaybackStore,
	MEDIA_HISTORY_LIMIT,
	MEDIA_QUEUE_LIMIT,
	MEDIA_FLOAT_SETTINGS_KEY,
	MEDIA_QUEUE_SETTINGS_KEY,
	type MediaOpenRequest,
} from '../../../renderer/stores/mediaPlaybackStore';
import { mediaItemId } from '../../../renderer/utils/mediaItems';

const FLOAT = { top: 40, left: 50, width: 400 };

const initial = useMediaPlaybackStore.getState();

/** A queueable file. Defaults to a local audio file on agent `s1`. */
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

const idOf = (r: MediaOpenRequest) => mediaItemId(r.sessionId, r.path);

function reset() {
	useMediaPlaybackStore.setState({
		items: [],
		activeItemId: null,
		history: [],
		playing: false,
		dismissed: false,
		pendingAutoplay: false,
		toggleRequest: 0,
		resumeTimes: {},
		durations: {},
		floatPosition: null,
		floatWidths: {},
		aspects: {},
	});
}

describe('mediaPlaybackStore', () => {
	beforeEach(() => {
		reset();
		(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
	});

	describe('openMedia', () => {
		it('queues a file, makes it active, and plays it', () => {
			const r = request();
			initial.openMedia(r);

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toHaveLength(1);
			expect(state.activeItemId).toBe(idOf(r));
			expect(state.pendingAutoplay).toBe(true);
			expect(state.history.map((h) => h.id)).toEqual([idOf(r)]);
		});

		it('re-opening the same file reuses its entry instead of stacking a duplicate', () => {
			initial.openMedia(request());
			initial.rememberTime(idOf(request()), 30);
			initial.openMedia(request());

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toHaveLength(1);
			// The remembered position survives, so re-opening resumes.
			expect(state.resumeTimes[idOf(request())]).toBe(30);
		});

		it('keys on agent and path, so the same file in two agents is two entries', () => {
			initial.openMedia(request());
			initial.openMedia(request({ sessionId: 's2', sessionName: 'Agent Two' }));
			expect(useMediaPlaybackStore.getState().items).toHaveLength(2);
		});

		it('refreshes metadata on re-open, so a renamed agent is not stale', () => {
			initial.openMedia(request());
			initial.openMedia(request({ sessionName: 'Renamed' }));

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toHaveLength(1);
			expect(state.items[0].sessionName).toBe('Renamed');
		});

		it('keeps queue position on re-open, so prev/next order stays open order', () => {
			const a = request();
			const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
			initial.openMedia(a);
			initial.openMedia(b);
			initial.openMedia(a);

			expect(useMediaPlaybackStore.getState().items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
		});

		it('un-hides the player, so opening a file always shows controls', () => {
			initial.openMedia(request());
			initial.dismiss();
			initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
			expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
		});

		it('switching files clears playing, since only one element is ever mounted', () => {
			initial.openMedia(request());
			initial.setPlaying(true);
			initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
			expect(useMediaPlaybackStore.getState().playing).toBe(false);
		});
	});

	describe('history', () => {
		it('orders by most recently played, newest first', () => {
			const a = request();
			const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
			initial.openMedia(a);
			initial.openMedia(b);
			initial.setActiveItem(idOf(a), { autoplay: true });

			expect(useMediaPlaybackStore.getState().history.map((h) => h.id)).toEqual([idOf(a), idOf(b)]);
		});

		it('never lists the same item twice', () => {
			const a = request();
			initial.openMedia(a);
			initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
			initial.openMedia(a);

			const history = useMediaPlaybackStore.getState().history;
			expect(history.filter((entry) => entry.id === idOf(a))).toHaveLength(1);
		});

		it('caps at the limit so the menu stays scannable', () => {
			for (let i = 0; i < MEDIA_HISTORY_LIMIT + 5; i++) {
				initial.openMedia(request({ path: `/files/${i}.mp3`, name: `${i}.mp3` }));
			}
			expect(useMediaPlaybackStore.getState().history).toHaveLength(MEDIA_HISTORY_LIMIT);
		});
	});

	describe('setActiveItem', () => {
		it('ignores an item that is not queued', () => {
			initial.openMedia(request());
			const before = useMediaPlaybackStore.getState();
			initial.setActiveItem('nope', { autoplay: true });
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});

		it('does not autoplay by default', () => {
			const a = request();
			const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
			initial.openMedia(a);
			initial.openMedia(b);
			initial.consumeAutoplay();
			initial.setActiveItem(idOf(a));
			expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
		});

		it('re-activating the active item is a no-op when nothing would change', () => {
			initial.openMedia(request());
			initial.consumeAutoplay();
			const before = useMediaPlaybackStore.getState();
			initial.setActiveItem(idOf(request()));
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});

		it('re-activating the active item still un-hides and can re-arm autoplay', () => {
			initial.openMedia(request());
			initial.consumeAutoplay();
			initial.dismiss();
			initial.setActiveItem(idOf(request()), { autoplay: true });

			const state = useMediaPlaybackStore.getState();
			expect(state.dismissed).toBe(false);
			expect(state.pendingAutoplay).toBe(true);
		});
	});

	describe('autoplay one-shot', () => {
		it('is consumed exactly once', () => {
			initial.openMedia(request());
			initial.consumeAutoplay();
			expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
			const before = useMediaPlaybackStore.getState();
			initial.consumeAutoplay();
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});
	});

	describe('dismiss and restore', () => {
		it('dismissing does not stop playback', () => {
			initial.openMedia(request());
			initial.setPlaying(true);
			initial.dismiss();

			const state = useMediaPlaybackStore.getState();
			expect(state.dismissed).toBe(true);
			// Hiding a control must not have the side effect of stopping media.
			expect(state.playing).toBe(true);
			expect(state.activeItemId).toBe(idOf(request()));
		});

		it('restore clears the dismissal', () => {
			initial.openMedia(request());
			initial.dismiss();
			initial.restore();
			expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
		});

		it('selectCanRestoreFloatingPlayer needs both a dismissal and loaded media', () => {
			expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(false);
			initial.openMedia(request());
			expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(false);
			initial.dismiss();
			expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(true);
		});
	});

	describe('toggle requests', () => {
		it('increments a nonce so the pill can drive the element', () => {
			initial.requestToggle();
			initial.requestToggle();
			expect(useMediaPlaybackStore.getState().toggleRequest).toBe(2);
		});
	});

	describe('resume positions', () => {
		it('remembers where a file was left', () => {
			initial.rememberTime('a', 42.5);
			expect(useMediaPlaybackStore.getState().resumeTimes.a).toBe(42.5);
		});
	});

	describe('closeItem', () => {
		it('releases the player when the playing item is closed', () => {
			const r = request();
			initial.openMedia(r);
			initial.setPlaying(true);
			initial.rememberTime(idOf(r), 10);

			initial.closeItem(idOf(r));

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toHaveLength(0);
			expect(state.activeItemId).toBeNull();
			expect(state.playing).toBe(false);
			expect(state.pendingAutoplay).toBe(false);
			// Closing drops it from the queue but not from what was played: history
			// is a record, not a view onto the queue.
			expect(state.history.map((h) => h.id)).toEqual([idOf(r)]);
			expect(state.resumeTimes[idOf(r)]).toBeUndefined();
		});

		it('closing is stop, not skip - it does not auto-advance', () => {
			const a = request();
			const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
			initial.openMedia(a);
			initial.openMedia(b);
			initial.closeItem(idOf(b));
			expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
		});

		it('leaves the active item alone when a different one closes', () => {
			const a = request();
			const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
			initial.openMedia(a);
			initial.openMedia(b);
			initial.closeItem(idOf(a));
			expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(b));
		});

		it('closing an unknown item is a no-op', () => {
			const before = useMediaPlaybackStore.getState();
			initial.closeItem('nope');
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});
	});

	describe('float geometry', () => {
		it('persists the position and the width, filed under the kind', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
			initial.setFloatGeometry('video', FLOAT);

			const state = useMediaPlaybackStore.getState();
			expect(state.floatPosition).toEqual({ top: FLOAT.top, left: FLOAT.left });
			expect(state.floatWidths).toEqual({ video: FLOAT.width });
			expect(set).toHaveBeenCalledWith(MEDIA_FLOAT_SETTINGS_KEY, {
				top: FLOAT.top,
				left: FLOAT.left,
				widths: { video: FLOAT.width },
			});
		});

		it('keeps a width per kind, so one does not overwrite the other', () => {
			initial.setFloatGeometry('video', { top: 0, left: 0, width: 900 });
			initial.setFloatGeometry('audio', { top: 10, left: 10, width: 380 });

			const state = useMediaPlaybackStore.getState();
			expect(state.floatWidths).toEqual({ video: 900, audio: 380 });
			// Position is shared: the widget should not move when the queue advances.
			expect(state.floatPosition).toEqual({ top: 10, left: 10 });
		});

		it('never stores a height, because the media decides it', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
			initial.setFloatGeometry('audio', FLOAT);
			expect(set.mock.calls[0][1]).not.toHaveProperty('height');
		});

		it('survives a missing settings bridge', () => {
			(window as unknown as { maestro?: unknown }).maestro = undefined;
			expect(() => initial.setFloatGeometry('audio', FLOAT)).not.toThrow();
			expect(useMediaPlaybackStore.getState().floatPosition).toEqual({ top: 40, left: 50 });
		});
	});

	describe('durations', () => {
		it('remembers how long a file is', () => {
			initial.rememberDuration('a', 266.7);
			expect(useMediaPlaybackStore.getState().durations.a).toBe(266.7);
		});

		it('ignores a live stream, which has no length to show', () => {
			initial.rememberDuration('a', Number.POSITIVE_INFINITY);
			initial.rememberDuration('b', 0);
			expect(useMediaPlaybackStore.getState().durations).toEqual({});
		});

		it('re-reporting the same length does not churn state', () => {
			initial.rememberDuration('a', 100);
			const before = useMediaPlaybackStore.getState();
			initial.rememberDuration('a', 100);
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});

		it('survives its file leaving the queue, so history can still show it', () => {
			const r = request();
			initial.openMedia(r);
			initial.rememberDuration(idOf(r), 100);
			initial.closeItem(idOf(r));
			expect(useMediaPlaybackStore.getState().durations[idOf(r)]).toBe(100);
		});
	});

	describe('aspect ratios', () => {
		it('remembers a video shape per item, so returning to it fits at once', () => {
			initial.rememberAspect('vid', 4 / 3);
			expect(useMediaPlaybackStore.getState().aspects.vid).toBeCloseTo(4 / 3);
		});

		it('rejects nonsense rather than shaping the widget like a ruler', () => {
			initial.rememberAspect('vid', 0);
			expect(useMediaPlaybackStore.getState().aspects.vid).toBeCloseTo(16 / 9);
		});

		it('re-reporting the same shape does not churn state', () => {
			initial.rememberAspect('vid', 16 / 9);
			const before = useMediaPlaybackStore.getState();
			initial.rememberAspect('vid', 16 / 9);
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});
	});

	describe('enqueueMedia', () => {
		it('appends without interrupting what is playing', () => {
			const a = request();
			const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
			initial.openMedia(a);
			initial.consumeAutoplay();
			initial.setPlaying(true);

			expect(initial.enqueueMedia([b])).toBe(1);

			const state = useMediaPlaybackStore.getState();
			expect(state.items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
			// The whole point of queueing: the mp3 keeps playing.
			expect(state.activeItemId).toBe(idOf(a));
			expect(state.playing).toBe(true);
			expect(state.pendingAutoplay).toBe(false);
		});

		it('loads the first file when the player is idle, so the queue is reachable', () => {
			const a = request();
			expect(initial.enqueueMedia([a])).toBe(1);

			const state = useMediaPlaybackStore.getState();
			expect(state.activeItemId).toBe(idOf(a));
			expect(state.dismissed).toBe(false);
			// Queueing is not a request to listen, so it does not start itself.
			expect(state.pendingAutoplay).toBe(false);
		});

		it('leaves an already-queued file where it is', () => {
			const a = request();
			const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
			initial.enqueueMedia([a, b]);
			expect(initial.enqueueMedia([a])).toBe(0);
			expect(useMediaPlaybackStore.getState().items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
		});

		it('does not touch history - nothing has been played', () => {
			initial.enqueueMedia([request({ path: '/files/b.mp3', name: 'b.mp3' })]);
			expect(useMediaPlaybackStore.getState().history).toEqual([]);
		});

		it('queues nothing for an empty list', () => {
			const before = useMediaPlaybackStore.getState();
			expect(initial.enqueueMedia([])).toBe(0);
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});

		it('caps the queue, keeping the loaded file', () => {
			const first = request({ path: '/files/first.mp3', name: 'first.mp3' });
			initial.openMedia(first);
			initial.enqueueMedia(
				Array.from({ length: MEDIA_QUEUE_LIMIT + 5 }, (_, i) =>
					request({ path: `/files/q${i}.mp3`, name: `q${i}.mp3` })
				)
			);

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toHaveLength(MEDIA_QUEUE_LIMIT + 1);
			expect(state.items.some((i) => i.id === idOf(first))).toBe(true);
		});
	});

	describe('advanceAfterEnded', () => {
		it('hands off to the next queued item and plays it', () => {
			const a = request();
			const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
			initial.openMedia(a);
			initial.enqueueMedia([b]);

			initial.advanceAfterEnded();

			const state = useMediaPlaybackStore.getState();
			expect(state.activeItemId).toBe(idOf(b));
			expect(state.pendingAutoplay).toBe(true);
		});

		it('rewinds the finished file, so coming back to it plays something', () => {
			const a = request();
			initial.openMedia(a);
			initial.rememberTime(idOf(a), 300);
			initial.advanceAfterEnded();
			expect(useMediaPlaybackStore.getState().resumeTimes[idOf(a)]).toBe(0);
		});

		it('stays put at the end of the queue rather than going blank', () => {
			const a = request();
			initial.openMedia(a);
			initial.advanceAfterEnded();
			expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(a));
		});

		it('does nothing with no loaded item', () => {
			expect(() => initial.advanceAfterEnded()).not.toThrow();
			expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
		});
	});

	describe('list maintenance', () => {
		it('clearQueue empties the queue and releases the player', () => {
			initial.openMedia(request());
			initial.setPlaying(true);
			initial.clearQueue();

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toEqual([]);
			expect(state.activeItemId).toBeNull();
			expect(state.playing).toBe(false);
			// What was played is a separate record and survives.
			expect(state.history).toHaveLength(1);
		});

		it('removing a history entry leaves the queue alone', () => {
			const a = request();
			initial.openMedia(a);
			initial.removeHistoryItem(idOf(a));

			const state = useMediaPlaybackStore.getState();
			expect(state.history).toEqual([]);
			expect(state.items).toHaveLength(1);
		});

		it('clearHistory forgets everything played', () => {
			initial.openMedia(request());
			initial.clearHistory();
			expect(useMediaPlaybackStore.getState().history).toEqual([]);
			expect(useMediaPlaybackStore.getState().items).toHaveLength(1);
		});

		it('selectActiveMediaItem resolves the loaded entry', () => {
			expect(selectActiveMediaItem(useMediaPlaybackStore.getState())).toBeNull();
			initial.openMedia(request());
			expect(selectActiveMediaItem(useMediaPlaybackStore.getState())?.name).toBe('a.mp3');
		});
	});

	describe('queue persistence', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('writes the queue, the loaded item, and remembered positions', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

			const r = request();
			initial.openMedia(r);
			initial.rememberTime(idOf(r), 12);
			initial.rememberDuration(idOf(r), 266);
			vi.advanceTimersByTime(600);

			expect(set).toHaveBeenCalledTimes(1);
			const [key, payload] = set.mock.calls[0];
			expect(key).toBe(MEDIA_QUEUE_SETTINGS_KEY);
			expect(payload.activeItemId).toBe(idOf(r));
			expect(payload.items).toHaveLength(1);
			expect(payload.resumeTimes[idOf(r)]).toBe(12);
			// Lengths are stored too: only the loaded file is ever mounted, so a
			// restored queue would otherwise show `--:--` for every other row.
			expect(payload.durations[idOf(r)]).toBe(266);
			// History is per-boot, so it must never reach disk.
			expect(payload).not.toHaveProperty('history');
		});

		it('prunes stored lengths to the queue, so disk does not grow forever', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

			const r = request();
			initial.openMedia(r);
			initial.rememberDuration(idOf(r), 266);
			initial.closeItem(idOf(r));
			vi.advanceTimersByTime(600);

			const payload = set.mock.calls[set.mock.calls.length - 1][1];
			expect(payload.durations).toEqual({});
			// Still in memory, so the history row keeps its time.
			expect(useMediaPlaybackStore.getState().durations[idOf(r)]).toBe(266);
		});

		it('collapses a burst of position updates into one write', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

			initial.openMedia(request());
			for (let i = 1; i <= 10; i++) initial.rememberTime(idOf(request()), i);
			vi.advanceTimersByTime(600);

			expect(set).toHaveBeenCalledTimes(1);
		});

		it('flushes on demand, so a closing window does not lose the queue', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

			initial.openMedia(request());
			flushMediaQueuePersist();
			expect(set).toHaveBeenCalledTimes(1);

			// Nothing pending: a second flush must not write again.
			flushMediaQueuePersist();
			expect(set).toHaveBeenCalledTimes(1);
		});
	});
});
