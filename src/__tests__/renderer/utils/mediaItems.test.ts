import { describe, expect, it } from 'vitest';
import {
	getOpenedMediaKind,
	formatMediaTime,
	mediaItemId,
	pushMediaHistory,
	sanitizeMediaItems,
	sanitizeMediaTimes,
	stepMediaItem,
	trimMediaQueue,
	upcomingMediaItems,
	type MediaItem,
} from '../../../renderer/utils/mediaItems';

/** A stream URL shaped like the one the main process mints for a local file. */
const STREAM = 'maestro-media://stream/tok3n/2f66696c65732f612e6d7033';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 'a',
		path: '/files/a.mp3',
		name: 'a.mp3',
		sessionId: 's1',
		sessionName: 'Agent One',
		kind: 'audio',
		...overrides,
	};
}

describe('getOpenedMediaKind', () => {
	it('recognizes a locally servable audio file', () => {
		expect(getOpenedMediaKind('podcast.mp3', STREAM)).toBe('audio');
	});

	it('recognizes a locally servable video file', () => {
		expect(getOpenedMediaKind('clip.mp4', STREAM)).toBe('video');
	});

	it('rejects a file with no stream URL, so a remote .mp3 stays a preview', () => {
		// Only local files get a maestro-media:// URL. Without one there are no
		// bytes to play, so it must fall through to the binary "open externally"
		// path rather than landing in a silent player.
		expect(getOpenedMediaKind('podcast.mp3', '<binary>')).toBeNull();
		expect(getOpenedMediaKind('podcast.mp3', '')).toBeNull();
	});

	it('rejects a non-media file even with a stream URL', () => {
		expect(getOpenedMediaKind('notes.md', STREAM)).toBeNull();
	});

	it('needs the extension, which a tab-shaped name does not carry', () => {
		expect(getOpenedMediaKind('podcast', STREAM)).toBeNull();
	});
});

describe('mediaItemId', () => {
	it('is stable for the same agent and path, so re-opening resumes', () => {
		expect(mediaItemId('s1', '/files/a.mp3')).toBe(mediaItemId('s1', '/files/a.mp3'));
	});

	it('separates the same file opened from two agents', () => {
		expect(mediaItemId('s1', '/files/a.mp3')).not.toBe(mediaItemId('s2', '/files/a.mp3'));
	});
});

describe('stepMediaItem', () => {
	const items = ['a', 'b', 'c'].map((id) => item({ id }));

	it('walks forward and back through the queue', () => {
		expect(stepMediaItem(items, 'b', 1)?.id).toBe('c');
		expect(stepMediaItem(items, 'b', -1)?.id).toBe('a');
	});

	it('does not wrap, so the ends disable the buttons', () => {
		expect(stepMediaItem(items, 'c', 1)).toBeNull();
		expect(stepMediaItem(items, 'a', -1)).toBeNull();
	});

	it('has nowhere to go in an empty queue', () => {
		expect(stepMediaItem([], 'a', 1)).toBeNull();
		expect(stepMediaItem([], null, -1)).toBeNull();
	});

	it('treats an unknown active item as starting from the ends', () => {
		expect(stepMediaItem(items, null, 1)?.id).toBe('a');
		expect(stepMediaItem(items, null, -1)?.id).toBe('c');
	});
});

describe('upcomingMediaItems', () => {
	const items = ['a', 'b', 'c'].map((id) => item({ id }));

	it('leaves out the loaded track, since the queue means what plays next', () => {
		expect(upcomingMediaItems(items, 'b').map((i) => i.id)).toEqual(['a', 'c']);
	});

	it('keeps items before the loaded one, which prev can still reach', () => {
		expect(upcomingMediaItems(items, 'c').map((i) => i.id)).toEqual(['a', 'b']);
	});

	it('lists everything when nothing is loaded', () => {
		expect(upcomingMediaItems(items, null)).toBe(items);
	});

	it('is empty when the only entry is the one playing', () => {
		expect(upcomingMediaItems([item({ id: 'a' })], 'a')).toEqual([]);
	});
});

describe('pushMediaHistory', () => {
	const history = ['a', 'b', 'c'].map((id) => item({ id }));

	it('puts the newest entry first', () => {
		expect(pushMediaHistory(history, item({ id: 'd' }), 10).map((i) => i.id)).toEqual([
			'd',
			'a',
			'b',
			'c',
		]);
	});

	it('moves a repeat to the front instead of listing it twice', () => {
		expect(pushMediaHistory(history, item({ id: 'c' }), 10).map((i) => i.id)).toEqual([
			'c',
			'a',
			'b',
		]);
	});

	it('caps the list so the menu stays scannable', () => {
		expect(pushMediaHistory(history, item({ id: 'd' }), 2).map((i) => i.id)).toEqual(['d', 'a']);
	});

	it('holds whole items, so an entry survives leaving the queue', () => {
		const entry = pushMediaHistory([], item({ id: 'a' }), 10)[0];
		expect(entry.path).toBe('/files/a.mp3');
		expect(entry.name).toBe('a.mp3');
	});
});

describe('trimMediaQueue', () => {
	const items = ['a', 'b', 'c', 'd'].map((id) => item({ id }));

	it('leaves a queue under the cap alone', () => {
		expect(trimMediaQueue(items, 10, null)).toBe(items);
	});

	it('drops the oldest queue positions first', () => {
		expect(trimMediaQueue(items, 2, null).map((i) => i.id)).toEqual(['c', 'd']);
	});

	it('never drops the loaded item, even when it is the oldest', () => {
		// Trimming the file that is playing would blank the player mid-listen.
		expect(trimMediaQueue(items, 2, 'a').map((i) => i.id)).toEqual(['a', 'c', 'd']);
	});
});

describe('sanitizeMediaItems', () => {
	it('rebuilds IDs rather than trusting the stored one', () => {
		const [entry] = sanitizeMediaItems([
			{ id: 'stale', path: '/files/a.mp3', name: 'a.mp3', sessionId: 's1', kind: 'audio' },
		]);
		expect(entry.id).toBe(mediaItemId('s1', '/files/a.mp3'));
	});

	it('drops entries missing anything the player needs', () => {
		expect(
			sanitizeMediaItems([
				{ path: '/files/a.mp3', name: 'a.mp3', sessionId: 's1', kind: 'document' },
				{ path: 42, name: 'a.mp3', sessionId: 's1', kind: 'audio' },
				{ name: 'a.mp3', sessionId: 's1', kind: 'audio' },
				null,
				'nope',
			])
		).toEqual([]);
	});

	it('de-duplicates, so a hand-edited file cannot stack the same file twice', () => {
		const entry = { path: '/files/a.mp3', name: 'a.mp3', sessionId: 's1', kind: 'audio' };
		expect(sanitizeMediaItems([entry, { ...entry }])).toHaveLength(1);
	});

	it('is empty for anything that is not a list', () => {
		expect(sanitizeMediaItems(undefined)).toEqual([]);
		expect(sanitizeMediaItems({ items: [] })).toEqual([]);
	});
});

describe('formatMediaTime', () => {
	it('floors fractional media seconds into a clock time', () => {
		expect(formatMediaTime(266.7)).toBe('4:26');
		expect(formatMediaTime(3725)).toBe('1:02:05');
	});

	it('says nothing rather than a number for a length it does not know', () => {
		// A live stream reports Infinity, and a queued file that has never been
		// mounted has no length at all.
		expect(formatMediaTime(undefined)).toBe('--:--');
		expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('--:--');
		expect(formatMediaTime(Number.NaN)).toBe('--:--');
	});

	it('shows zero rather than a negative time', () => {
		expect(formatMediaTime(0)).toBe('0:00');
		expect(formatMediaTime(-5)).toBe('0:00');
	});
});

describe('sanitizeMediaTimes', () => {
	const known = new Set(['a', 'b']);

	it('keeps real positions for queued items', () => {
		expect(sanitizeMediaTimes({ a: 12.5, b: 0 }, known)).toEqual({ a: 12.5, b: 0 });
	});

	it('drops positions for files that are no longer queued', () => {
		expect(sanitizeMediaTimes({ gone: 30 }, known)).toEqual({});
	});

	it('drops values that are not usable times', () => {
		expect(sanitizeMediaTimes({ a: -1, b: 'x' }, known)).toEqual({});
		expect(sanitizeMediaTimes({ a: Number.NaN }, known)).toEqual({});
	});

	it('is empty for anything that is not an object', () => {
		expect(sanitizeMediaTimes(null, known)).toEqual({});
	});
});
