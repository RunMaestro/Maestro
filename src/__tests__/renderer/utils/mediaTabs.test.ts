import { describe, expect, it } from 'vitest';
import {
	collectMediaTabs,
	getFileTabMediaKind,
	getMediaTabLabel,
	stepMediaTab,
	type MediaTabRef,
} from '../../../renderer/utils/mediaTabs';
import type { FilePreviewTab, Session } from '../../../renderer/types';

const AUDIO_URL = 'maestro-media://stream/deadbeef/616263';

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'tab-1',
		path: '/tmp/song.mp3',
		name: 'song',
		extension: '.mp3',
		content: AUDIO_URL,
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: 1000,
		lastModified: 1000,
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'sess-1',
		name: 'Agent One',
		filePreviewTabs: [],
		...overrides,
	} as unknown as Session;
}

describe('getFileTabMediaKind', () => {
	it('classifies audio and video by filename', () => {
		expect(getFileTabMediaKind('song.mp3', AUDIO_URL)).toBe('audio');
		expect(getFileTabMediaKind('demo.mp4', AUDIO_URL)).toBe('video');
	});

	it('needs the extension on the filename', () => {
		// FilePreviewTab splits name from extension, so a caller that passes the
		// bare tab name gets nothing. This is why the signature takes scalars.
		expect(getFileTabMediaKind('song', AUDIO_URL)).toBeNull();
	});

	it('rejects content that is not a stream URL', () => {
		// A remote .mp4 read over SSH comes back as text/base64, never a stream URL,
		// so it must keep the binary "open externally" path.
		expect(getFileTabMediaKind('remote.mp4', 'not-a-stream')).toBeNull();
		expect(getFileTabMediaKind('notes.md', '# hello')).toBeNull();
	});

	it('still recognizes a stream URL minted by a previous boot', () => {
		// Restored tabs hold a stale token. Detection is a prefix test on purpose:
		// the tab is still media, and the host re-resolves the URL before playing.
		expect(getFileTabMediaKind('song.mp3', 'maestro-media://stream/staletoken/616263')).toBe(
			'audio'
		);
	});

	it('requires a playable container even with a stream URL', () => {
		expect(getFileTabMediaKind('movie.mkv', AUDIO_URL)).toBeNull();
	});
});

describe('collectMediaTabs', () => {
	it('spans every session, not just the active one', () => {
		const sessions = [
			session({ id: 's1', name: 'One', filePreviewTabs: [fileTab({ id: 't1' })] }),
			session({
				id: 's2',
				name: 'Two',
				filePreviewTabs: [
					fileTab({ id: 't2', name: 'talk', extension: '.mp4', path: '/tmp/talk.mp4' }),
				],
			}),
		];
		const refs = collectMediaTabs(sessions);
		expect(refs.map((r) => [r.tabId, r.sessionId, r.kind])).toEqual([
			['t1', 's1', 'audio'],
			['t2', 's2', 'video'],
		]);
	});

	it('skips non-media tabs', () => {
		const sessions = [
			session({
				filePreviewTabs: [
					fileTab({ id: 'md', name: 'readme', extension: '.md', content: '# hi' }),
					fileTab({ id: 'audio' }),
				],
			}),
		];
		expect(collectMediaTabs(sessions).map((r) => r.tabId)).toEqual(['audio']);
	});

	it('rejoins the tab name and extension before classifying', () => {
		// Regression: passing the bare tab name here classified every media tab as
		// non-media, so nothing ever played.
		const sessions = [session({ filePreviewTabs: [fileTab({ name: 'song', extension: '.mp3' })] })];
		expect(collectMediaTabs(sessions)).toHaveLength(1);
		expect(collectMediaTabs(sessions)[0].kind).toBe('audio');
	});

	it('carries the session name and autoplay request through', () => {
		const sessions = [
			session({
				name: 'Podcast Agent',
				filePreviewTabs: [fileTab({ autoplayMedia: true })],
			}),
		];
		const [ref] = collectMediaTabs(sessions);
		expect(ref.sessionName).toBe('Podcast Agent');
		expect(ref.autoplay).toBe(true);
	});

	it('reports autoplay false for a restored tab with no request', () => {
		const [ref] = collectMediaTabs([session({ filePreviewTabs: [fileTab()] })]);
		expect(ref.autoplay).toBe(false);
	});

	it('tolerates a session with no file tabs', () => {
		expect(collectMediaTabs([session({ filePreviewTabs: undefined })])).toEqual([]);
		expect(collectMediaTabs([])).toEqual([]);
	});
});

describe('getMediaTabLabel', () => {
	it('rejoins the name and extension', () => {
		expect(getMediaTabLabel({ name: 'song', extension: '.mp3' })).toBe('song.mp3');
	});
});

describe('stepMediaTab', () => {
	const refs = ['a', 'b', 'c'].map((id) => ({ tabId: id }) as MediaTabRef);

	it('steps forward and back through the open order', () => {
		expect(stepMediaTab(refs, 'b', 1)?.tabId).toBe('c');
		expect(stepMediaTab(refs, 'b', -1)?.tabId).toBe('a');
	});

	it('does not wrap, so the ends disable the buttons', () => {
		expect(stepMediaTab(refs, 'c', 1)).toBeNull();
		expect(stepMediaTab(refs, 'a', -1)).toBeNull();
	});

	it('returns null when there is nothing open', () => {
		expect(stepMediaTab([], 'a', 1)).toBeNull();
		expect(stepMediaTab([], null, -1)).toBeNull();
	});

	it('enters from the matching end when the active tab is unknown', () => {
		// Happens right after the playing tab closes, or before anything loads.
		expect(stepMediaTab(refs, null, 1)?.tabId).toBe('a');
		expect(stepMediaTab(refs, null, -1)?.tabId).toBe('c');
		expect(stepMediaTab(refs, 'gone', 1)?.tabId).toBe('a');
	});

	it('has nowhere to go with a single file, so both buttons stay hidden', () => {
		const one = [{ tabId: 'only' } as MediaTabRef];
		expect(stepMediaTab(one, 'only', 1)).toBeNull();
		expect(stepMediaTab(one, 'only', -1)).toBeNull();
	});
});
