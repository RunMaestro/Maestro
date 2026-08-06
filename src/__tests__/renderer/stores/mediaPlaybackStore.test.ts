import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	selectCanRestoreFloatingPlayer,
	useMediaPlaybackStore,
} from '../../../renderer/stores/mediaPlaybackStore';

const RECT = { top: 10, left: 20, width: 300, height: 200 };
const FLOAT = { top: 40, left: 50, width: 400, height: 240 };

const initial = useMediaPlaybackStore.getState();

function reset() {
	useMediaPlaybackStore.setState({
		activeTabId: null,
		playing: false,
		dismissed: false,
		minimized: false,
		pendingAutoplay: false,
		toggleRequest: 0,
		slots: {},
		resumeTimes: {},
		floatRect: null,
	});
}

describe('mediaPlaybackStore', () => {
	beforeEach(() => {
		reset();
		(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
	});

	describe('setActiveTab', () => {
		it('loads a tab and arms autoplay when asked', () => {
			initial.setActiveTab('a', { autoplay: true });
			expect(useMediaPlaybackStore.getState().activeTabId).toBe('a');
			expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(true);
		});

		it('does not autoplay by default, so merely viewing a tab stays quiet', () => {
			initial.setActiveTab('a');
			expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
		});

		it('switching files clears playing, since only one element is ever mounted', () => {
			initial.setActiveTab('a', { autoplay: true });
			initial.setPlaying(true);
			initial.setActiveTab('b');
			expect(useMediaPlaybackStore.getState().activeTabId).toBe('b');
			expect(useMediaPlaybackStore.getState().playing).toBe(false);
		});

		it('un-dismisses the widget, so opening a file brings it back', () => {
			initial.setActiveTab('a');
			initial.dismiss();
			initial.setActiveTab('b');
			expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
		});

		it('re-activating the same tab is a no-op when nothing would change', () => {
			initial.setActiveTab('a');
			const before = useMediaPlaybackStore.getState();
			initial.setActiveTab('a');
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});

		it('re-opening the active tab still un-dismisses and can re-arm autoplay', () => {
			initial.setActiveTab('a');
			initial.dismiss();
			initial.setActiveTab('a', { autoplay: true });
			expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
			expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(true);
		});
	});

	describe('autoplay one-shot', () => {
		it('is consumed exactly once', () => {
			initial.setActiveTab('a', { autoplay: true });
			initial.consumeAutoplay();
			expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
			const before = useMediaPlaybackStore.getState();
			initial.consumeAutoplay();
			expect(useMediaPlaybackStore.getState()).toBe(before);
		});
	});

	describe('dismiss and restore', () => {
		it('dismissing does not stop playback', () => {
			initial.setActiveTab('a');
			initial.setPlaying(true);
			initial.dismiss();
			expect(useMediaPlaybackStore.getState().dismissed).toBe(true);
			// Hiding a control must not have the side effect of stopping media.
			expect(useMediaPlaybackStore.getState().playing).toBe(true);
			expect(useMediaPlaybackStore.getState().activeTabId).toBe('a');
		});

		it('restore clears the dismissal', () => {
			initial.setActiveTab('a');
			initial.dismiss();
			initial.restore();
			expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
		});

		it('selectCanRestoreFloatingPlayer needs both a dismissal and loaded media', () => {
			expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(false);
			initial.setActiveTab('a');
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

	describe('docked slots', () => {
		it('publishes a rect and marks it visible', () => {
			initial.setSlotRect('a', RECT);
			expect(useMediaPlaybackStore.getState().slots.a).toEqual({ rect: RECT, visible: true });
		});

		it('ignores a repeated identical rect', () => {
			initial.setSlotRect('a', RECT);
			const before = useMediaPlaybackStore.getState().slots;
			initial.setSlotRect('a', { ...RECT });
			expect(useMediaPlaybackStore.getState().slots).toBe(before);
		});

		it('applies a changed rect', () => {
			initial.setSlotRect('a', RECT);
			initial.setSlotRect('a', { ...RECT, width: 400 });
			expect(useMediaPlaybackStore.getState().slots.a.rect.width).toBe(400);
		});

		it('retains the last rect when hiding, so a docked player keeps a real size', () => {
			initial.setSlotRect('a', RECT);
			initial.hideSlot('a');
			expect(useMediaPlaybackStore.getState().slots.a).toEqual({ rect: RECT, visible: false });
		});

		it('hiding an unknown or already-hidden slot is a no-op', () => {
			const before = useMediaPlaybackStore.getState().slots;
			initial.hideSlot('nope');
			expect(useMediaPlaybackStore.getState().slots).toBe(before);
		});
	});

	describe('resume positions', () => {
		it('remembers where a file was left', () => {
			initial.rememberTime('a', 42.5);
			expect(useMediaPlaybackStore.getState().resumeTimes.a).toBe(42.5);
		});
	});

	describe('clearTab', () => {
		it('releases the player when the playing tab closes', () => {
			initial.setActiveTab('a', { autoplay: true });
			initial.setPlaying(true);
			initial.setSlotRect('a', RECT);
			initial.rememberTime('a', 10);

			initial.clearTab('a');

			const state = useMediaPlaybackStore.getState();
			expect(state.activeTabId).toBeNull();
			expect(state.playing).toBe(false);
			expect(state.pendingAutoplay).toBe(false);
			expect(state.slots.a).toBeUndefined();
			expect(state.resumeTimes.a).toBeUndefined();
		});

		it('leaves the active tab alone when a different tab closes', () => {
			initial.setActiveTab('a');
			initial.setSlotRect('b', RECT);
			initial.clearTab('b');
			expect(useMediaPlaybackStore.getState().activeTabId).toBe('a');
		});

		it('clearing an unknown tab is a no-op', () => {
			const before = useMediaPlaybackStore.getState();
			initial.clearTab('nope');
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
