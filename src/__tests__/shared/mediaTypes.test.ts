import { describe, it, expect } from 'vitest';
import {
	MEDIA_PLAYBACK_RATES,
	MEDIA_SCHEME,
	buildMediaStreamHttpPath,
	buildMediaStreamUrl,
	getMediaKind,
	getMediaMimeType,
	isMediaFile,
	isMediaStreamUrl,
	normalizePlaybackRate,
	parseMediaStreamUrl,
} from '../../shared/mediaTypes';

const TOKEN = 'a'.repeat(32);

describe('getMediaKind', () => {
	it('classifies audio extensions', () => {
		expect(getMediaKind('song.mp3')).toBe('audio');
		expect(getMediaKind('voice.WAV')).toBe('audio');
		expect(getMediaKind('/tmp/clip.m4a')).toBe('audio');
		expect(getMediaKind('take.flac')).toBe('audio');
		expect(getMediaKind('podcast.opus')).toBe('audio');
	});

	it('classifies video extensions', () => {
		expect(getMediaKind('demo.mp4')).toBe('video');
		expect(getMediaKind('capture.WEBM')).toBe('video');
		expect(getMediaKind('/Users/me/Movies/screen.mov')).toBe('video');
	});

	it('leaves containers Chromium cannot demux to the binary fallback', () => {
		// mkv/avi/wmv deliberately stay unsupported so they keep the existing
		// "Binary File / open externally" path instead of a player that only fails.
		expect(getMediaKind('movie.mkv')).toBeNull();
		expect(getMediaKind('movie.avi')).toBeNull();
		expect(getMediaKind('movie.wmv')).toBeNull();
	});

	it('returns null for non-media and extensionless names', () => {
		expect(getMediaKind('README.md')).toBeNull();
		expect(getMediaKind('archive.zip')).toBeNull();
		expect(getMediaKind('')).toBeNull();
		// An extensionless file literally named "mp3" is not an MP3.
		expect(getMediaKind('mp3')).toBeNull();
		expect(getMediaKind('/media/mp4/notes')).toBeNull();
		// A trailing dot has no extension after it.
		expect(getMediaKind('weird.')).toBeNull();
	});

	it('ignores dots in parent directories', () => {
		expect(getMediaKind('/some.dir.mp4/notes.txt')).toBeNull();
		expect(getMediaKind('C:\\Users\\me\\v1.2\\clip.mp4')).toBe('video');
	});
});

describe('isMediaFile', () => {
	it('is true only for playable media', () => {
		expect(isMediaFile('a.mp3')).toBe(true);
		expect(isMediaFile('a.mp4')).toBe(true);
		expect(isMediaFile('a.png')).toBe(false);
	});
});

describe('getMediaMimeType', () => {
	it('maps extensions to the MIME type Chromium expects', () => {
		expect(getMediaMimeType('a.mp3')).toBe('audio/mpeg');
		expect(getMediaMimeType('a.m4a')).toBe('audio/mp4');
		expect(getMediaMimeType('a.wav')).toBe('audio/wav');
		expect(getMediaMimeType('a.mp4')).toBe('video/mp4');
		expect(getMediaMimeType('a.mov')).toBe('video/quicktime');
	});

	it('returns null for unsupported files', () => {
		expect(getMediaMimeType('a.mkv')).toBeNull();
		expect(getMediaMimeType('a.txt')).toBeNull();
	});
});

describe('media stream URLs', () => {
	it('round-trips an absolute path', () => {
		const url = buildMediaStreamUrl(TOKEN, '/Users/me/Movies/demo.mp4');
		expect(url.startsWith(`${MEDIA_SCHEME}://stream/${TOKEN}/`)).toBe(true);
		expect(parseMediaStreamUrl(url, TOKEN)).toBe('/Users/me/Movies/demo.mp4');
	});

	it('round-trips paths with characters that would break percent-encoding', () => {
		const paths = [
			'/tmp/100% done/my song #1.mp3',
			'/tmp/ünïcödé/日本語.mp4',
			'C:\\Users\\me\\My Music\\track.wav',
			'/tmp/a?b=c/clip.webm',
		];
		for (const p of paths) {
			expect(parseMediaStreamUrl(buildMediaStreamUrl(TOKEN, p), TOKEN)).toBe(p);
		}
	});

	it('rejects a URL minted with a different boot token', () => {
		const url = buildMediaStreamUrl(TOKEN, '/tmp/a.mp3');
		expect(parseMediaStreamUrl(url, 'b'.repeat(32))).toBeNull();
	});

	it('rejects an empty expected token so a mis-initialized handler stays closed', () => {
		const url = buildMediaStreamUrl('', '/tmp/a.mp3');
		expect(parseMediaStreamUrl(url, '')).toBeNull();
	});

	it('rejects the wrong scheme, wrong host, and malformed paths', () => {
		expect(parseMediaStreamUrl('https://stream/' + TOKEN + '/6161', TOKEN)).toBeNull();
		expect(parseMediaStreamUrl(`${MEDIA_SCHEME}://other/${TOKEN}/6161`, TOKEN)).toBeNull();
		expect(parseMediaStreamUrl(`${MEDIA_SCHEME}://stream/${TOKEN}`, TOKEN)).toBeNull();
		expect(parseMediaStreamUrl(`${MEDIA_SCHEME}://stream/${TOKEN}/a/b`, TOKEN)).toBeNull();
		expect(parseMediaStreamUrl('not a url', TOKEN)).toBeNull();
	});

	it('rejects non-hex and odd-length payloads', () => {
		expect(parseMediaStreamUrl(`${MEDIA_SCHEME}://stream/${TOKEN}/zzzz`, TOKEN)).toBeNull();
		expect(parseMediaStreamUrl(`${MEDIA_SCHEME}://stream/${TOKEN}/616`, TOKEN)).toBeNull();
		expect(parseMediaStreamUrl(`${MEDIA_SCHEME}://stream/${TOKEN}/`, TOKEN)).toBeNull();
	});

	it('refuses to resolve a valid URL that points at a non-media file', () => {
		// Belt and braces: even with a good token, the handler must not become a
		// generic "read any file on disk" endpoint.
		const url = buildMediaStreamUrl(TOKEN, '/etc/passwd');
		expect(parseMediaStreamUrl(url, TOKEN)).toBeNull();
	});

	it('detects stream URLs without parsing them', () => {
		expect(isMediaStreamUrl(buildMediaStreamUrl(TOKEN, '/tmp/a.mp3'))).toBe(true);
		expect(isMediaStreamUrl('data:image/png;base64,AAAA')).toBe(false);
		expect(isMediaStreamUrl('# Some markdown')).toBe(false);
		expect(isMediaStreamUrl(null)).toBe(false);
		expect(isMediaStreamUrl(undefined)).toBe(false);
	});
});

describe('buildMediaStreamHttpPath', () => {
	it('maps a stream URL onto the web server media route, keeping the media token', () => {
		const streamUrl = buildMediaStreamUrl(TOKEN, '/tmp/clip.mp4');
		const hex = streamUrl.split('/').pop();
		expect(buildMediaStreamHttpPath('master', streamUrl)).toBe(
			`/master/media/stream/${TOKEN}/${hex}`
		);
	});

	it('returns null for anything that is not a stream URL', () => {
		expect(buildMediaStreamHttpPath('master', 'raw file contents')).toBeNull();
		expect(buildMediaStreamHttpPath('master', `${MEDIA_SCHEME}://stream/only-a-token`)).toBeNull();
		expect(buildMediaStreamHttpPath('', buildMediaStreamUrl(TOKEN, '/tmp/clip.mp4'))).toBeNull();
	});
});

describe('normalizePlaybackRate', () => {
	it('passes through valid rates', () => {
		for (const rate of MEDIA_PLAYBACK_RATES) {
			expect(normalizePlaybackRate(rate)).toBe(rate);
		}
	});

	it('clamps out-of-range rates', () => {
		expect(normalizePlaybackRate(0.01)).toBe(0.25);
		expect(normalizePlaybackRate(99)).toBe(4);
	});

	it('falls back to 1x for junk', () => {
		expect(normalizePlaybackRate(undefined)).toBe(1);
		expect(normalizePlaybackRate(null)).toBe(1);
		expect(normalizePlaybackRate('fast')).toBe(1);
		expect(normalizePlaybackRate(NaN)).toBe(1);
		expect(normalizePlaybackRate(0)).toBe(1);
		expect(normalizePlaybackRate(-2)).toBe(1);
	});

	it('accepts numeric strings from the CLI settings path', () => {
		expect(normalizePlaybackRate('1.5')).toBe(1.5);
	});
});
