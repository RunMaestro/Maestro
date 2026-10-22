/**
 * Media window launch rule tests.
 *
 * - A saved queue with at least one playable item creates the media window
 *   (hidden: `ensureCreated`, never `show`).
 * - No saved queue, an empty one, or one whose every item the renderer's
 *   sanitizer would drop creates nothing.
 * - A controller that refuses to create a window reports false.
 *
 * The open-file paths need no launch rule: the primary window's replica
 * forwards `openMedia` / `enqueueMedia` as commands, and the relay creates the
 * window and holds them until it is ready (see floating-widget-relay.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
	restoreMediaWindowAtLaunch,
	savedMediaQueueHasActiveItem,
} from '../../../main/floating-widgets/media-window-launch';

const track = {
	id: 'agent-1::/music/a.mp3',
	path: '/music/a.mp3',
	name: 'a.mp3',
	sessionId: 'agent-1',
	sessionName: 'Agent One',
	kind: 'audio',
};

function controller(created: BrowserWindow | null = {} as BrowserWindow) {
	return { ensureCreated: vi.fn(() => created) };
}

describe('savedMediaQueueHasActiveItem', () => {
	it('is true for a saved queue holding a playable item', () => {
		expect(
			savedMediaQueueHasActiveItem({
				items: [track],
				activeItemId: track.id,
				resumeTimes: {},
				durations: {},
			})
		).toBe(true);
	});

	it('is true when the saved active id is gone (the first item becomes active)', () => {
		expect(savedMediaQueueHasActiveItem({ items: [track], activeItemId: 'missing' })).toBe(true);
		expect(savedMediaQueueHasActiveItem({ items: [track], activeItemId: null })).toBe(true);
	});

	it('is false with no saved queue', () => {
		expect(savedMediaQueueHasActiveItem(null)).toBe(false);
		expect(savedMediaQueueHasActiveItem(undefined)).toBe(false);
		expect(savedMediaQueueHasActiveItem('queue')).toBe(false);
	});

	it('is false for an empty queue', () => {
		expect(savedMediaQueueHasActiveItem({ items: [], activeItemId: null })).toBe(false);
	});

	it('is false when every saved item is malformed', () => {
		expect(
			savedMediaQueueHasActiveItem({
				items: [{ ...track, kind: 'image' }, { ...track, path: 42 }, null, 'a.mp3'],
				activeItemId: track.id,
			})
		).toBe(false);
		expect(savedMediaQueueHasActiveItem({ items: 'not a list' })).toBe(false);
	});
});

describe('restoreMediaWindowAtLaunch', () => {
	it('creates the media window, hidden, when the saved queue has an active item', () => {
		const media = controller();
		expect(restoreMediaWindowAtLaunch({ items: [track], activeItemId: track.id }, media)).toBe(
			true
		);
		expect(media.ensureCreated).toHaveBeenCalledTimes(1);
	});

	it('creates nothing when there is no queue to restore', () => {
		const media = controller();
		expect(restoreMediaWindowAtLaunch(null, media)).toBe(false);
		expect(restoreMediaWindowAtLaunch({ items: [] }, media)).toBe(false);
		expect(media.ensureCreated).not.toHaveBeenCalled();
	});

	it('reports false when the window cannot be created', () => {
		const media = controller(null);
		expect(restoreMediaWindowAtLaunch({ items: [track] }, media)).toBe(false);
		expect(media.ensureCreated).toHaveBeenCalledTimes(1);
	});
});
