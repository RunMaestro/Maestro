import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	selectCanRestoreFloatingPlayer,
	useMediaPlaybackStore,
	MEDIA_HISTORY_LIMIT,
	type MediaOpenRequest,
} from '../../../renderer/stores/mediaPlaybackStore';
import { mediaItemId } from '../../../renderer/utils/mediaItems';

const FLOAT = { top: 40, left: 50, width: 400, height: 240 };

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
		minimized: false,
		pendingAutoplay: false,
		toggleRequest: 0,
		resumeTimes: {},
		floatRect: null,
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
			expect(state.history).toEqual([idOf(r)]);
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

			expect(useMediaPlaybackStore.getState().history).toEqual([idOf(a), idOf(b)]);
		});

		it('never lists the same item twice', () => {
			const a = request();
			initial.openMedia(a);
			initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
			initial.openMedia(a);

			const history = useMediaPlaybackStore.getState().history;
			expect(history.filter((id) => id === idOf(a))).toHaveLength(1);
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
			expect(state.history).toEqual([]);
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
		it('stores and persists the rect', () => {
			const set = vi.fn();
			(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
			initial.setFloatRect(FLOAT);
			expect(useMediaPlaybackStore.getState().floatRect).toEqual(FLOAT);
			expect(set).toHaveBeenCalledWith('mediaPlayerFloatRect', FLOAT);
		});

		it('survives a missing settings bridge', () => {
			(window as unknown as { maestro?: unknown }).maestro = undefined;
			expect(() => initial.setFloatRect(FLOAT)).not.toThrow();
			expect(useMediaPlaybackStore.getState().floatRect).toEqual(FLOAT);
		});
	});
});
