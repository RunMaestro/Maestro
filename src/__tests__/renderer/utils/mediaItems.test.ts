import { describe, expect, it } from 'vitest';
import {
	getOpenedMediaKind,
	mediaItemId,
	resolveMediaHistory,
	stepMediaItem,
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

describe('resolveMediaHistory', () => {
	const items = ['a', 'b', 'c'].map((id) => item({ id }));

	it('returns items in history order, not queue order', () => {
		expect(resolveMediaHistory(items, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a']);
	});

	it('drops IDs whose item has been closed', () => {
		// History holds IDs so a removed entry falls out on its own rather than
		// leaving the menu pointing at something that no longer exists.
		expect(resolveMediaHistory(items, ['c', 'gone', 'a']).map((i) => i.id)).toEqual(['c', 'a']);
	});

	it('never repeats an item', () => {
		expect(resolveMediaHistory(items, ['a', 'a', 'b']).map((i) => i.id)).toEqual(['a', 'b']);
	});

	it('is empty with no history', () => {
		expect(resolveMediaHistory(items, [])).toEqual([]);
	});
});
