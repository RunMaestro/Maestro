// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/deep-link-urls.test.ts
// Source: src/__tests__/shared/mediaTypes.test.ts
// Source: src/__tests__/shared/typographyPresets.test.ts
// Source: src/__tests__/shared/delegation.test.ts
// Source: src/__tests__/shared/turnUsageLedger.test.ts
// Source: src/__tests__/shared/sshOptions.test.ts
// Source: src/__tests__/shared/quotaLimitDetail.test.ts
// Source: src/__tests__/shared/codexResetCredits.test.ts
// Source: src/__tests__/shared/hexColor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	buildSessionDeepLink,
	buildGroupDeepLink,
	buildFileDeepLink,
	parseMaestroDeepLink,
} from '../../shared/deep-link-urls';
import {
	MEDIA_PLAYBACK_RATES,
	MEDIA_SCHEME,
	buildMediaStreamHttpPath,
	buildMediaStreamUrl,
	getMediaKind,
	getRemoteMediaKind,
	getRemoteMediaName,
	isRemoteMediaUrl,
	getMediaMimeType,
	isMediaFile,
	isMediaStreamUrl,
	normalizePlaybackRate,
	parseMediaStreamUrl,
} from '../../shared/mediaTypes';
import {
	TYPOGRAPHY_PRESETS,
	TYPOGRAPHY_PRESET_IDS,
	MONO_INTERFACE_FONT,
	DEFAULT_INTERFACE_FONT,
	matchTypographyPreset,
	type TypographyPresetFonts,
} from '../../shared/typographyPresets';
import { SANS_FALLBACK_STACK } from '../../shared/fontStack';
import { isBundledFont } from '../../shared/bundledFonts';
import { SETTINGS_DEFAULTS } from '../../main/stores/defaults';
import {
	DELEGATION_MILESTONES,
	delegatedMs,
	delegatedMsToReach,
	delegationPercent,
	delegationPercentByCount,
	emptyDelegationTotals,
	highestMilestoneReached,
	nextMilestone,
	normalizeUnlockedMilestone,
	sumDelegationDays,
	trackedCount,
	trackedMs,
	withLifetimeCueTime,
	type DelegationTotals,
} from '../../shared/delegation';
import {
	recordTurnUsage,
	drainTurnUsage,
	turnUsageStatsFields,
	usageStatsToTurnFields,
	getTurnUsageLedgerSize,
	resetTurnUsageLedgerForTests,
} from '../../shared/turnUsageLedger';
import type { UsageStats } from '../../shared/types';
import {
	DEFAULT_SSH_OPTIONS,
	RESERVED_SSH_OPTION_KEYS,
	buildSshOptionArgs,
	isReservedSshOptionKey,
	normalizeSshOptions,
	parseSshOptionAssignments,
	resolveSshOptions,
	sshOptionArgs,
	validateSshOption,
} from '../../shared/sshOptions';
import {
	parseQuotaLimitDetail,
	describeQuotaWindow,
	describeQuotaRemedy,
} from '../../shared/quotaLimitDetail';
import {
	asResetCreditStatus,
	describeCreditExpiry,
	describeCreditSpend,
	isSpendableCredit,
	nextCreditToSpend,
	shouldAutoSpendCredit,
	spendableCredits,
	type CodexResetCredit,
} from '../../shared/codexResetCredits';
import { extractHexColor } from '../../shared/hexColor';
// Source: src/__tests__/shared/deep-link-urls.test.ts
describe('', () => {
	describe('buildSessionDeepLink', () => {
		it('should build a session-only deep link', () => {
			expect(buildSessionDeepLink('abc123')).toBe('maestro://session/abc123');
		});
		it('should build a session + tab deep link', () => {
			expect(buildSessionDeepLink('abc123', 'tab456')).toBe('maestro://session/abc123/tab/tab456');
		});
		it('should URI-encode session IDs with special characters', () => {
			expect(buildSessionDeepLink('id/with/slashes')).toBe(
				`maestro://session/${encodeURIComponent('id/with/slashes')}`
			);
		});
		it('should URI-encode tab IDs with special characters', () => {
			expect(buildSessionDeepLink('sess', 'tab?special')).toBe(
				`maestro://session/sess/tab/${encodeURIComponent('tab?special')}`
			);
		});
		it('should not include tab segment when tabId is undefined', () => {
			expect(buildSessionDeepLink('abc123', undefined)).toBe('maestro://session/abc123');
		});
	});
	describe('buildGroupDeepLink', () => {
		it('should build a group deep link', () => {
			expect(buildGroupDeepLink('grp789')).toBe('maestro://group/grp789');
		});
		it('should URI-encode group IDs with special characters', () => {
			expect(buildGroupDeepLink('group/name')).toBe(
				`maestro://group/${encodeURIComponent('group/name')}`
			);
		});
	});
	describe('parseMaestroDeepLink', () => {
		it('parses focus URLs', () => {
			expect(parseMaestroDeepLink('maestro://focus')).toEqual({ action: 'focus' });
			expect(parseMaestroDeepLink('maestro://')).toEqual({ action: 'focus' });
			expect(parseMaestroDeepLink('maestro:')).toEqual({ action: 'focus' });
		});
		it('parses session URLs with and without tabs', () => {
			expect(parseMaestroDeepLink('maestro://session/abc123')).toEqual({
				action: 'session',
				sessionId: 'abc123',
			});
			expect(parseMaestroDeepLink('maestro://session/abc123/tab/tab456')).toEqual({
				action: 'session',
				sessionId: 'abc123',
				tabId: 'tab456',
			});
		});
		it('decodes URI-encoded IDs', () => {
			expect(parseMaestroDeepLink('maestro://session/session%20with%20space')).toEqual({
				action: 'session',
				sessionId: 'session with space',
			});
			expect(parseMaestroDeepLink('maestro://group/group%20name')).toEqual({
				action: 'group',
				groupId: 'group name',
			});
		});
		it('parses Windows-style URLs without double slash', () => {
			expect(parseMaestroDeepLink('maestro:session/abc123')).toEqual({
				action: 'session',
				sessionId: 'abc123',
			});
		});
		it('returns null for unrecognized resources and malformed inputs', () => {
			expect(parseMaestroDeepLink('maestro://unknown/abc')).toBeNull();
			expect(parseMaestroDeepLink('maestro://session')).toBeNull();
			expect(parseMaestroDeepLink('maestro://session/')).toBeNull();
			expect(parseMaestroDeepLink('maestro://group')).toBeNull();
		});
		it('parses file URLs with and without line fragments', () => {
			const path = '/Users/me/proj/notes.md';
			expect(parseMaestroDeepLink(buildFileDeepLink('sess1', path))).toEqual({
				action: 'file',
				sessionId: 'sess1',
				filePath: path,
			});
			expect(parseMaestroDeepLink(buildFileDeepLink('sess1', path, 42))).toEqual({
				action: 'file',
				sessionId: 'sess1',
				filePath: path,
				line: 42,
			});
		});
		it('ignores malformed line fragments on file URLs', () => {
			const url = `${buildFileDeepLink('sess1', '/x/y.md')}#L0`;
			expect(parseMaestroDeepLink(url)).toEqual({
				action: 'file',
				sessionId: 'sess1',
				filePath: '/x/y.md',
			});
			const url2 = `${buildFileDeepLink('sess1', '/x/y.md')}#Lfoo`;
			expect(parseMaestroDeepLink(url2)).toEqual({
				action: 'file',
				sessionId: 'sess1',
				filePath: '/x/y.md',
			});
		});
		it('round-trips file paths with spaces and special characters', () => {
			const path = '/Users/me/My Notes/2026 plan & ideas.md';
			const url = buildFileDeepLink('s', path, 7);
			expect(parseMaestroDeepLink(url)).toEqual({
				action: 'file',
				sessionId: 's',
				filePath: path,
				line: 7,
			});
		});
	});
	describe('buildFileDeepLink', () => {
		it('encodes the file path so slashes do not break path-segment parsing', () => {
			const url = buildFileDeepLink('sess', '/a/b.md');
			expect(url).toBe(`maestro://file/sess/${encodeURIComponent('/a/b.md')}`);
		});
		it('omits the line fragment when line is undefined or non-positive', () => {
			expect(buildFileDeepLink('s', '/x.md')).not.toMatch(/#/);
			expect(buildFileDeepLink('s', '/x.md', 0)).not.toMatch(/#/);
			expect(buildFileDeepLink('s', '/x.md', -1)).not.toMatch(/#/);
		});
		it('emits #L<n> when line is a positive integer', () => {
			expect(buildFileDeepLink('s', '/x.md', 3)).toMatch(/#L3$/);
		});
	});
	describe('parseMaestroDeepLink with malformed percent encoding', () => {
		it('preserves the raw segment instead of dropping the whole link', () => {
			expect(parseMaestroDeepLink('maestro://session/abc%')).toEqual({
				action: 'session',
				sessionId: 'abc%',
			});
			expect(parseMaestroDeepLink('maestro://session/s1/tab/tab%zz')).toEqual({
				action: 'session',
				sessionId: 's1',
				tabId: 'tab%zz',
			});
			expect(parseMaestroDeepLink('maestro://group/g%E0%A4')).toEqual({
				action: 'group',
				groupId: 'g%E0%A4',
			});
		});
		it('still resolves file links whose path has a stray percent sign', () => {
			expect(parseMaestroDeepLink('maestro://file/sess/report%20100%#L12')).toEqual({
				action: 'file',
				sessionId: 'sess',
				filePath: 'report%20100%',
				line: 12,
			});
		});
		it('decodes the segments that are well-formed even when a sibling is not', () => {
			expect(parseMaestroDeepLink('maestro://file/my%20sess/bad%')).toEqual({
				action: 'file',
				sessionId: 'my sess',
				filePath: 'bad%',
			});
		});
	});
});
// Source: src/__tests__/shared/mediaTypes.test.ts
describe('', () => {
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
			expect(
				buildMediaStreamHttpPath('master', `${MEDIA_SCHEME}://stream/only-a-token`)
			).toBeNull();
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
	describe('remote media URLs', () => {
		it('recognizes http and https URLs, and nothing else', () => {
			expect(isRemoteMediaUrl('https://cdn.example.com/clip.mp4')).toBe(true);
			expect(isRemoteMediaUrl('HTTP://localhost:8080/a.mp3')).toBe(true);
			expect(isRemoteMediaUrl('/Users/me/clip.mp4')).toBe(false);
			expect(isRemoteMediaUrl('maestro-media://stream/t/aa')).toBe(false);
			expect(isRemoteMediaUrl('file:///tmp/clip.mp4')).toBe(false);
			expect(isRemoteMediaUrl(null)).toBe(false);
		});
		it('reads the kind off the path, ignoring the query string', () => {
			expect(getRemoteMediaKind('https://x.test/a/clip.mp4?sig=abc.mp3')).toBe('video');
			expect(getRemoteMediaKind('https://x.test/episode.mp3')).toBe('audio');
		});
		it('defaults an unknown extension to video, which plays audio-only streams too', () => {
			expect(getRemoteMediaKind('https://x.test/stream?id=42')).toBe('video');
			expect(getRemoteMediaKind('not a url')).toBe('video');
		});
		it('names an item by its decoded last segment, else its host', () => {
			expect(getRemoteMediaName('https://x.test/videos/My%20Clip.mp4?t=1')).toBe('My Clip.mp4');
			expect(getRemoteMediaName('https://x.test:8443/')).toBe('x.test:8443');
			expect(getRemoteMediaName('https://x.test/bad%E0%A4%A.mp4')).toBe('bad%E0%A4%A.mp4');
		});
	});
});
// Source: src/__tests__/shared/typographyPresets.test.ts
describe('', () => {
	const FONT_KEYS: Array<keyof TypographyPresetFonts> = [
		'fontFamily',
		'chatFontFamily',
		'terminalFontFamily',
		'filePreviewFontFamily',
		'documentGraphFontFamily',
		'fileEditorFontFamily',
	];
	describe('typography presets', () => {
		it('writes every font field, including the empty ones', () => {
			// A preset that omitted a surface would leave whatever the PREVIOUS preset
			// put there, so Default -> Hacker -> Default would not round-trip.
			for (const id of TYPOGRAPHY_PRESET_IDS) {
				const fonts = TYPOGRAPHY_PRESETS[id].fonts;
				for (const key of FONT_KEYS) {
					expect(fonts).toHaveProperty(key);
					expect(typeof fonts[key]).toBe('string');
				}
			}
		});
		it('makes Hacker monospace on every surface', () => {
			const { fonts } = TYPOGRAPHY_PRESETS.hacker;
			expect(fonts.fontFamily).toBe(MONO_INTERFACE_FONT);
			// Every surface inherits, so a later interface-font change moves the whole
			// app at once - which is the point of this preset.
			expect(fonts.chatFontFamily).toBe('');
			expect(fonts.terminalFontFamily).toBe('');
			expect(fonts.filePreviewFontFamily).toBe('');
			expect(fonts.documentGraphFontFamily).toBe('');
			expect(fonts.fileEditorFontFamily).toBe('');
		});
		it('makes Default proportional for reading and monospace only where alignment matters', () => {
			const { fonts } = TYPOGRAPHY_PRESETS.default;
			expect(fonts.fontFamily).toBe(DEFAULT_INTERFACE_FONT);
			expect(fonts.fontFamily).toContain(SANS_FALLBACK_STACK);
			// Chat and file preview inherit rather than pinning a second copy of the
			// sans stack, so they keep tracking a later interface-font change.
			// Reading a document is prose, so the preview is proportional too.
			expect(fonts.chatFontFamily).toBe('');
			expect(fonts.filePreviewFontFamily).toBe('');
			expect(fonts.documentGraphFontFamily).toBe('');
			// Only the surfaces where character alignment carries meaning stay mono:
			// the terminal's column output and the editor's line-number gutter.
			for (const key of ['terminalFontFamily', 'fileEditorFontFamily'] as const) {
				expect(fonts[key]).not.toBe('');
				expect(fonts[key].toLowerCase()).toContain('monospace');
			}
		});
		it('leads Default with bundled faces so it renders on a bare machine', () => {
			// A preset that named only system faces would degrade to the generic
			// fallback on a machine without them, which is exactly the failure the
			// bundled fonts exist to prevent.
			const { fonts } = TYPOGRAPHY_PRESETS.default;
			expect(isBundledFont(fonts.fontFamily.split(',')[0].trim())).toBe(true);
			expect(isBundledFont(fonts.terminalFontFamily.split(',')[0].trim())).toBe(true);
			expect(isBundledFont(fonts.fileEditorFontFamily.split(',')[0].trim())).toBe(true);
		});
		it('gives Default a larger base than Hacker to offset the smaller x-height', () => {
			// A proportional face at 14px reads visibly smaller than a monospace one
			// at 14px, so switching families without retuning sizes makes the whole
			// app look like it shrank.
			expect(TYPOGRAPHY_PRESETS.default.sizes.fontSize).toBeGreaterThan(
				TYPOGRAPHY_PRESETS.hacker.sizes.fontSize
			);
			// The code surfaces keep their tighter size rather than following it up.
			expect(TYPOGRAPHY_PRESETS.default.sizes.terminalFontSize).toBeLessThan(
				TYPOGRAPHY_PRESETS.default.sizes.fontSize
			);
		});
		it('makes every Hacker surface inherit one size', () => {
			const { sizes } = TYPOGRAPHY_PRESETS.hacker;
			expect(sizes.fontSize).toBeGreaterThan(0);
			for (const key of [
				'chatFontSize',
				'terminalFontSize',
				'filePreviewFontSize',
				'documentGraphFontSize',
				'fileEditorFontSize',
			] as const) {
				expect(sizes[key]).toBe(0);
			}
		});
		it('describes each surface on the card exactly once', () => {
			for (const id of TYPOGRAPHY_PRESET_IDS) {
				const labels = TYPOGRAPHY_PRESETS[id].surfaces.map((s) => s.label);
				expect(labels).toHaveLength(FONT_KEYS.length);
				expect(new Set(labels).size).toBe(labels.length);
			}
		});
		it('the surface summary matches the fonts it claims to describe', () => {
			// The card is the only thing the user reads before committing, so a
			// summary that disagreed with the settings would be a lie.
			const defaultKinds = Object.fromEntries(
				TYPOGRAPHY_PRESETS.default.surfaces.map((s) => [s.label, s.kind])
			);
			expect(defaultKinds).toEqual({
				Interface: 'proportional',
				'AI chat': 'proportional',
				Terminal: 'mono',
				'File preview': 'proportional',
				'Document graph': 'proportional',
				'File editor': 'mono',
			});
			expect(TYPOGRAPHY_PRESETS.hacker.surfaces.every((s) => s.kind === 'mono')).toBe(true);
		});
		it('names only real settings keys, so a preset can be written straight onto a settings file', () => {
			// The showcase seed (`scripts/showcase/setup.js`) applies a preset by
			// spreading `fonts` and `sizes` onto `maestro-settings.json`, rather than
			// carrying a hand-copied duplicate of twelve values that would drift one
			// field at a time. A key here that is NOT a settings key is written,
			// ignored by the app, and every published screenshot then comes out in
			// the previous font while the capture run reports success.
			for (const id of TYPOGRAPHY_PRESET_IDS) {
				const preset = TYPOGRAPHY_PRESETS[id];
				for (const key of [...Object.keys(preset.fonts), ...Object.keys(preset.sizes)]) {
					expect(SETTINGS_DEFAULTS).toHaveProperty(key);
				}
			}
		});
	});
	describe('matchTypographyPreset', () => {
		it('recognizes each preset from its own fonts', () => {
			for (const id of TYPOGRAPHY_PRESET_IDS) {
				expect(matchTypographyPreset(TYPOGRAPHY_PRESETS[id].fonts)).toBe(id);
			}
		});
		it('returns null once the user has taken the pickers apart', () => {
			expect(
				matchTypographyPreset({
					...TYPOGRAPHY_PRESETS.default.fonts,
					chatFontFamily: 'Comic Sans MS',
				})
			).toBeNull();
		});
		it('ignores surrounding whitespace on a stored value', () => {
			// A whitespace-only surface font means "inherit" everywhere else in the
			// app, so it must not read as a third, unmatched state here.
			expect(
				matchTypographyPreset({
					...TYPOGRAPHY_PRESETS.hacker.fonts,
					terminalFontFamily: '   ',
				})
			).toBe('hacker');
		});
		it('reports the shipped defaults as Hacker', () => {
			// This is why the prompt cannot be gated on the current fonts: every
			// existing user matches `hacker` exactly, since that was the only look
			// Maestro had. Gating on it would mean never prompting anyone.
			expect(matchTypographyPreset(TYPOGRAPHY_PRESETS.hacker.fonts)).toBe('hacker');
		});
	});
});
// Source: src/__tests__/shared/delegation.test.ts
describe('', () => {
	function totals(
		interactive: [number, number],
		autoRun: [number, number],
		cue: [number, number]
	): DelegationTotals {
		return {
			interactive: { count: interactive[0], durationMs: interactive[1] },
			autoRun: { count: autoRun[0], durationMs: autoRun[1] },
			cue: { count: cue[0], durationMs: cue[1] },
		};
	}
	describe('delegation totals', () => {
		it('treats Auto Run and Cue together as delegated time', () => {
			const t = totals([10, 1000], [2, 3000], [1, 6000]);
			expect(delegatedMs(t)).toBe(9000);
			expect(trackedMs(t)).toBe(10000);
			expect(delegationPercent(t)).toBe(90);
		});
		it('reports zero rather than NaN when nothing is tracked', () => {
			expect(delegationPercent(emptyDelegationTotals())).toBe(0);
			expect(delegationPercentByCount(emptyDelegationTotals())).toBe(0);
			expect(trackedMs(emptyDelegationTotals())).toBe(0);
		});
		it('scores time and turn count separately', () => {
			// Many short interactive turns against a couple of long delegated ones:
			// the whole reason the headline score is time-based.
			const t = totals([100, 100000], [2, 900000], [0, 0]);
			expect(Math.round(delegationPercent(t))).toBe(90);
			expect(Math.round(delegationPercentByCount(t))).toBe(2);
			expect(trackedCount(t)).toBe(102);
		});
		it('sums a per-day series back into one split', () => {
			const summed = sumDelegationDays([
				{
					date: '2026-01-01',
					interactive: { count: 1, durationMs: 100 },
					autoRun: { count: 2, durationMs: 200 },
					cue: { count: 3, durationMs: 300 },
				},
				{
					date: '2026-01-02',
					interactive: { count: 4, durationMs: 400 },
					autoRun: { count: 0, durationMs: 0 },
					cue: { count: 1, durationMs: 50 },
				},
			]);
			expect(summed.interactive).toEqual({ count: 5, durationMs: 500 });
			expect(summed.autoRun).toEqual({ count: 2, durationMs: 200 });
			expect(summed.cue).toEqual({ count: 4, durationMs: 350 });
		});
	});
	describe('milestones', () => {
		it('exposes the four marks in ascending order', () => {
			expect([...DELEGATION_MILESTONES]).toEqual([25, 50, 75, 100]);
		});
		it('does not unlock a milestone the raw score has not reached', () => {
			// 74.6% renders as "75%" but has not earned the 75 mark.
			expect(highestMilestoneReached(74.6)).toBe(50);
			expect(highestMilestoneReached(75)).toBe(75);
			expect(highestMilestoneReached(0)).toBe(0);
			expect(highestMilestoneReached(100)).toBe(100);
		});
		it('names the next mark, and nothing beyond 100', () => {
			expect(nextMilestone(0)).toBe(25);
			expect(nextMilestone(25)).toBe(50);
			expect(nextMilestone(99.9)).toBe(100);
			expect(nextMilestone(100)).toBeNull();
		});
		it('rounds a stored high-water mark down to a real milestone', () => {
			expect(normalizeUnlockedMilestone(75)).toBe(75);
			expect(normalizeUnlockedMilestone(80)).toBe(75);
			expect(normalizeUnlockedMilestone(120)).toBe(100);
			expect(normalizeUnlockedMilestone(-5)).toBe(0);
			expect(normalizeUnlockedMilestone('75')).toBe(0);
			expect(normalizeUnlockedMilestone(undefined)).toBe(0);
			expect(normalizeUnlockedMilestone(Number.NaN)).toBe(0);
		});
	});
	describe('delegatedMsToReach', () => {
		it('accounts for the target growing the denominator too', () => {
			// 1h interactive, 0 delegated. Reaching 50% needs another 1h delegated,
			// not 30 minutes - the added time counts on both sides of the ratio.
			const t = totals([1, 3600000], [0, 0], [0, 0]);
			expect(delegatedMsToReach(t, 50)).toBe(3600000);
			expect(delegatedMsToReach(t, 25)).toBe(1200000);
		});
		it('returns zero once the target is already met', () => {
			const t = totals([1, 1000], [1, 9000], [0, 0]);
			expect(delegatedMsToReach(t, 50)).toBe(0);
			expect(delegatedMsToReach(t, 75)).toBe(0);
		});
		it('reports 100% as unreachable while interactive time is on record', () => {
			const t = totals([1, 1000], [1, 9000], [0, 0]);
			expect(delegatedMsToReach(t, 100)).toBe(Infinity);
			expect(delegatedMsToReach(totals([0, 0], [1, 9000], [0, 0]), 100)).toBe(0);
		});
	});
	describe('withLifetimeCueTime', () => {
		// `cue_events` keeps a week; `query_events` is never pruned. Without this the
		// lifetime score weighs 7 days of Cue against the whole install, and gets
		// WORSE the longer Maestro has been running - backwards for a score meant to
		// reward delegating more.
		it('restores Cue time the retention prune deleted', () => {
			const t = totals([100, 1000000], [5, 500000], [3, 50000]);
			const fixed = withLifetimeCueTime(t, 900000);
			expect(fixed.cue.durationMs).toBe(900000);
			// Only the duration moves - there is no lifetime run count to restore.
			expect(fixed.cue.count).toBe(3);
			expect(fixed.interactive).toEqual(t.interactive);
			expect(fixed.autoRun).toEqual(t.autoRun);
		});
		it('keeps the live table when it already holds more', () => {
			// The accumulator floors each run to whole minutes, so a young install
			// full of sub-minute Cue runs can legitimately have more on disk.
			const t = totals([1, 1000], [0, 0], [40, 90000]);
			expect(withLifetimeCueTime(t, 60000)).toBe(t);
		});
		it('ignores an absent or unusable accumulator', () => {
			const t = totals([1, 1000], [0, 0], [1, 5000]);
			expect(withLifetimeCueTime(t, undefined)).toBe(t);
			expect(withLifetimeCueTime(t, Number.NaN)).toBe(t);
			expect(withLifetimeCueTime(t, 0)).toBe(t);
		});
		it('raises the score rather than letting it decay', () => {
			// Real shape from a live install: 8 months of turns, 7 days of Cue rows.
			const pruned = totals([14659, 1186 * 3600000], [2524, 327 * 3600000], [23761, 51 * 3600000]);
			expect(Math.round(delegationPercent(pruned))).toBe(24);
			const whole = withLifetimeCueTime(pruned, 203 * 3600000);
			expect(Math.round(delegationPercent(whole))).toBe(31);
		});
	});
});
// Source: src/__tests__/shared/turnUsageLedger.test.ts
describe('', () => {
	function usage(overrides: Partial<UsageStats> = {}): UsageStats {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: 200000,
			...overrides,
		};
	}
	describe('turnUsageLedger', () => {
		beforeEach(() => {
			resetTurnUsageLedgerForTests();
		});
		it('accumulates multiple usage events within one turn', () => {
			recordTurnUsage(
				's1-ai-tab1',
				usage({ inputTokens: 100, outputTokens: 20, totalCostUsd: 0.1 })
			);
			recordTurnUsage(
				's1-ai-tab1',
				usage({ inputTokens: 50, outputTokens: 30, totalCostUsd: 0.05 })
			);
			const drained = drainTurnUsage('s1-ai-tab1');
			expect(drained).toEqual({
				inputTokens: 150,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: expect.closeTo(0.15) as unknown as number,
				events: 2,
			});
		});
		it('maps cache fields onto the stats column names', () => {
			recordTurnUsage(
				's1-ai-tab1',
				usage({ cacheReadInputTokens: 900, cacheCreationInputTokens: 400 })
			);
			const drained = drainTurnUsage('s1-ai-tab1');
			expect(drained?.cacheReadTokens).toBe(900);
			expect(drained?.cacheCreationTokens).toBe(400);
		});
		it('keeps concurrent turns on the same agent separate', () => {
			// A forced-parallel turn is a different process on the same tab. Keying
			// by the agent id instead of the raw process id would hand one turn's
			// tokens to whichever finished first.
			recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 10 }));
			recordTurnUsage('s1-ai-tab1-fp-1700000000', usage({ outputTokens: 999 }));
			expect(drainTurnUsage('s1-ai-tab1')?.outputTokens).toBe(10);
			expect(drainTurnUsage('s1-ai-tab1-fp-1700000000')?.outputTokens).toBe(999);
		});
		it('drains once - a second drain reports nothing', () => {
			// Draining has to clear, or the next turn on the same tab would inherit
			// this turn's tokens and double-count them.
			recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 10 }));
			expect(drainTurnUsage('s1-ai-tab1')).not.toBeNull();
			expect(drainTurnUsage('s1-ai-tab1')).toBeNull();
		});
		it('starts a fresh total after a drain', () => {
			recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 10 }));
			drainTurnUsage('s1-ai-tab1');
			recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 7 }));
			expect(drainTurnUsage('s1-ai-tab1')?.outputTokens).toBe(7);
		});
		it('reports null for a turn that never produced a usage event', () => {
			expect(drainTurnUsage('never-seen')).toBeNull();
		});
		it('bounds the ledger so undrained turns cannot leak forever', () => {
			for (let i = 0; i < 600; i++) {
				recordTurnUsage(`orphan-${i}`, usage({ outputTokens: 1 }));
			}
			expect(getTurnUsageLedgerSize()).toBeLessThanOrEqual(500);
			// The oldest insertions are the ones evicted.
			expect(drainTurnUsage('orphan-0')).toBeNull();
			expect(drainTurnUsage('orphan-599')).not.toBeNull();
		});
		describe('turnUsageStatsFields', () => {
			it('returns an empty object for a turn with no usage, leaving columns NULL', () => {
				expect(turnUsageStatsFields(null)).toEqual({});
			});
			it('shapes a drained turn into recordQuery fields', () => {
				recordTurnUsage(
					's1-ai-tab1',
					usage({
						inputTokens: 5,
						outputTokens: 6,
						cacheReadInputTokens: 7,
						cacheCreationInputTokens: 8,
						totalCostUsd: 0.09,
					})
				);
				expect(turnUsageStatsFields(drainTurnUsage('s1-ai-tab1'))).toEqual({
					inputTokens: 5,
					outputTokens: 6,
					cacheReadTokens: 7,
					cacheCreationTokens: 8,
					costUsd: 0.09,
				});
			});
			it('reports a genuine zero-token turn as zeros, not as absent', () => {
				// A provider that reported usage of zero is different from one that
				// reported nothing; only the latter should leave the columns NULL.
				recordTurnUsage('s1-ai-tab1', usage());
				expect(turnUsageStatsFields(drainTurnUsage('s1-ai-tab1'))).toEqual({
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0,
				});
			});
		});
		describe('usageStatsToTurnFields', () => {
			it('returns an empty object when the Auto Run task reported no usage', () => {
				expect(usageStatsToTurnFields(undefined)).toEqual({});
			});
			it('converts a per-task UsageStats to the same field names', () => {
				expect(
					usageStatsToTurnFields(
						usage({
							inputTokens: 11,
							outputTokens: 22,
							cacheReadInputTokens: 33,
							cacheCreationInputTokens: 44,
							totalCostUsd: 0.55,
						})
					)
				).toEqual({
					inputTokens: 11,
					outputTokens: 22,
					cacheReadTokens: 33,
					cacheCreationTokens: 44,
					costUsd: 0.55,
				});
			});
		});
	});
});
// Source: src/__tests__/shared/sshOptions.test.ts
describe('', () => {
	describe('resolveSshOptions', () => {
		it('returns the non-interactive defaults when there are no overrides', () => {
			expect(resolveSshOptions(undefined)).toEqual({ ...DEFAULT_SSH_OPTIONS });
		});
		it('lets a remote raise ConnectTimeout, which is unreachable via ~/.ssh/config', () => {
			// A command-line -o outranks the config file, so before overrides existed
			// there was no way for a slow tunnel to get more than 10 seconds.
			const resolved = resolveSshOptions({ ConnectTimeout: '45' });
			expect(resolved.ConnectTimeout).toBe('45');
			expect(resolved.BatchMode).toBe('yes');
		});
		it('adds an unknown option such as ProxyCommand alongside the defaults', () => {
			const resolved = resolveSshOptions({ ProxyCommand: '/opt/homebrew/bin/tailcat tcABC 22' });
			expect(resolved.ProxyCommand).toBe('/opt/homebrew/bin/tailcat tcABC 22');
			expect(resolved.StrictHostKeyChecking).toBe('accept-new');
		});
		it('matches an override to a default case-insensitively', () => {
			// OpenSSH keywords are case-insensitive but -o flags are FIRST-WINS, so
			// emitting both spellings would silently keep the default and make the
			// user's override a no-op.
			const resolved = resolveSshOptions({ connecttimeout: '30' });
			expect(resolved.ConnectTimeout).toBe('30');
			expect(resolved).not.toHaveProperty('connecttimeout');
		});
		it('never emits the same keyword twice', () => {
			const args = buildSshOptionArgs({ CONNECTTIMEOUT: '30', ProxyJump: 'bastion' });
			const keywords = args.filter((_, i) => i % 2 === 1).map((pair) => pair.split('=')[0]);
			expect(new Set(keywords).size).toBe(keywords.length);
		});
		it('ignores an attempt to override RequestTTY', () => {
			// RequestTTY is derived per command from whether the agent speaks
			// stream-json; a forced TTY corrupts that stream.
			const resolved = resolveSshOptions({ RequestTTY: 'force' });
			expect(resolved.RequestTTY).toBe('no');
		});
		it('sets RequestTTY=force when the caller forces a TTY', () => {
			expect(resolveSshOptions(undefined, { forceTty: true }).RequestTTY).toBe('force');
		});
		describe('interactive context', () => {
			it('drops BatchMode, RequestTTY and LogLevel', () => {
				const resolved = resolveSshOptions(undefined, { context: 'interactive' });
				// The user is at the keyboard: they can answer a passphrase prompt, the
				// caller passes -t, and SSH's own warnings are the diagnostics.
				expect(resolved).not.toHaveProperty('BatchMode');
				expect(resolved).not.toHaveProperty('RequestTTY');
				expect(resolved).not.toHaveProperty('LogLevel');
				expect(resolved.ConnectTimeout).toBe('10');
				expect(resolved.ClearAllForwardings).toBe('yes');
			});
			it('does not let an override reinstate a dropped option', () => {
				const resolved = resolveSshOptions({ BatchMode: 'yes' }, { context: 'interactive' });
				expect(resolved).not.toHaveProperty('BatchMode');
			});
			it('still accepts an unrelated override', () => {
				const resolved = resolveSshOptions(
					{ ProxyCommand: 'tailcat tcABC 22' },
					{ context: 'interactive' }
				);
				expect(resolved.ProxyCommand).toBe('tailcat tcABC 22');
			});
		});
	});
	describe('sshOptionArgs', () => {
		it('flattens into -o KEY=VALUE pairs', () => {
			expect(sshOptionArgs({ ConnectTimeout: '10', ProxyJump: 'bastion' })).toEqual([
				'-o',
				'ConnectTimeout=10',
				'-o',
				'ProxyJump=bastion',
			]);
		});
		it('keeps a value containing spaces and equals signs as one argument', () => {
			const args = sshOptionArgs({ ProxyCommand: 'tailcat --key=default tcABC 22' });
			expect(args).toEqual(['-o', 'ProxyCommand=tailcat --key=default tcABC 22']);
		});
	});
	describe('normalizeSshOptions', () => {
		it('returns undefined for an empty or absent record', () => {
			expect(normalizeSshOptions(undefined)).toBeUndefined();
			expect(normalizeSshOptions({})).toBeUndefined();
		});
		it('drops blank and reserved keys', () => {
			expect(normalizeSshOptions({ '  ': 'x', RequestTTY: 'force', ProxyJump: 'bastion' })).toEqual(
				{
					ProxyJump: 'bastion',
				}
			);
		});
	});
	describe('validateSshOption', () => {
		it('accepts a normal option', () => {
			expect(validateSshOption('ProxyCommand', 'tailcat tcABC 22')).toBeNull();
		});
		it('rejects an empty name', () => {
			expect(validateSshOption('   ', 'x')).toMatch(/cannot be empty/);
		});
		it('rejects a non-alphanumeric name', () => {
			expect(validateSshOption('Proxy Command', 'x')).toMatch(/Invalid SSH option name/);
		});
		it('rejects a reserved name whatever its case', () => {
			expect(validateSshOption('requesttty', 'force')).toMatch(/cannot be overridden/);
		});
		it('rejects a value containing a line break', () => {
			expect(validateSshOption('ProxyCommand', 'a\nb')).toMatch(/line break/);
		});
	});
	describe('isReservedSshOptionKey', () => {
		it('is case-insensitive over every reserved key', () => {
			for (const key of RESERVED_SSH_OPTION_KEYS) {
				expect(isReservedSshOptionKey(key.toUpperCase())).toBe(true);
			}
			expect(isReservedSshOptionKey('ProxyCommand')).toBe(false);
		});
	});
	describe('parseSshOptionAssignments', () => {
		it('returns nothing for no entries', () => {
			expect(parseSshOptionAssignments(undefined)).toEqual({});
			expect(parseSshOptionAssignments([])).toEqual({});
		});
		it('splits on the first equals only', () => {
			// A ProxyCommand value routinely contains its own '='.
			expect(parseSshOptionAssignments(['ProxyCommand=tailcat --key=default tcABC 22'])).toEqual({
				options: { ProxyCommand: 'tailcat --key=default tcABC 22' },
			});
		});
		it('reports an entry with no equals', () => {
			expect(parseSshOptionAssignments(['ProxyCommand']).error).toMatch(/Expected KEY=VALUE/);
		});
		it('reports a reserved key rather than silently dropping it', () => {
			expect(parseSshOptionAssignments(['RequestTTY=force']).error).toMatch(/cannot be overridden/);
		});
	});
});
// Source: src/__tests__/shared/quotaLimitDetail.test.ts
describe('', () => {
	/** The real envelope Claude Code emits on a hit 5-hour limit, trimmed. */
	const REAL_ENVELOPE = {
		type: 'assistant',
		error: 'rate_limit',
		isApiErrorMessage: true,
		apiErrorStatus: 429,
		quotaLimits: {
			status: 'rejected',
			resetsAt: 1787416800,
			rateLimitType: 'five_hour',
			overageStatus: 'rejected',
			overageDisabledReason: 'out_of_credits',
		},
		message: {
			role: 'assistant',
			model: '<synthetic>',
			content: [{ type: 'text', text: "You've hit your session limit · resets 11:40am" }],
		},
	};
	describe('parseQuotaLimitDetail', () => {
		it('reads every field off the real captured envelope', () => {
			const detail = parseQuotaLimitDetail(REAL_ENVELOPE);
			expect(detail).toEqual({
				window: 'five_hour',
				windowRaw: 'five_hour',
				status: 'rejected',
				resetsAt: 1787416800 * 1000,
				overageStatus: 'rejected',
				overageInUse: undefined,
				overageDisabledReason: 'out_of_credits',
			});
		});
		it('converts epoch seconds to milliseconds but leaves milliseconds alone', () => {
			expect(parseQuotaLimitDetail({ quotaLimits: { resetsAt: 1787416800 } })?.resetsAt).toBe(
				1787416800000
			);
			expect(parseQuotaLimitDetail({ quotaLimits: { resetsAt: 1787416800000 } })?.resetsAt).toBe(
				1787416800000
			);
		});
		it('keeps an unrecognized rateLimitType as raw rather than inventing a window', () => {
			const detail = parseQuotaLimitDetail({
				quotaLimits: { rateLimitType: 'thirty_day_sonnet', status: 'rejected' },
			});
			expect(detail?.window).toBe('unknown');
			expect(detail?.windowRaw).toBe('thirty_day_sonnet');
		});
		it('recognizes the weekly windows', () => {
			expect(parseQuotaLimitDetail({ quotaLimits: { rateLimitType: 'seven_day' } })?.window).toBe(
				'seven_day'
			);
			expect(
				parseQuotaLimitDetail({ quotaLimits: { rateLimitType: 'seven_day_opus' } })?.window
			).toBe('seven_day_opus');
		});
		it('accepts snake_case spellings and the rate_limit container', () => {
			const detail = parseQuotaLimitDetail({
				rate_limit: {
					rate_limit_type: 'seven_day',
					resets_at: 1787416800,
					overage_status: 'allowed',
					overage_in_use: true,
				},
			});
			expect(detail?.window).toBe('seven_day');
			expect(detail?.resetsAt).toBe(1787416800000);
			expect(detail?.overageStatus).toBe('allowed');
			expect(detail?.overageInUse).toBe(true);
		});
		it('returns undefined when no quota object came through', () => {
			// The plain `--output-format stream-json` path forwards only the message
			// envelope, so every consumer has to handle absence.
			expect(
				parseQuotaLimitDetail({ type: 'assistant', message: { content: [] } })
			).toBeUndefined();
			expect(parseQuotaLimitDetail(undefined)).toBeUndefined();
			expect(parseQuotaLimitDetail('not an object')).toBeUndefined();
		});
		it('returns undefined for a quota container carrying none of the fields we read', () => {
			// An empty block on screen says less than the notice text above it.
			expect(parseQuotaLimitDetail({ quotaLimits: { somethingElse: 1 } })).toBeUndefined();
		});
	});
	describe('describeQuotaWindow', () => {
		it('names each recognized window', () => {
			expect(describeQuotaWindow({ window: 'five_hour' })).toBe('5-hour session limit');
			expect(describeQuotaWindow({ window: 'seven_day' })).toBe('Weekly limit');
			expect(describeQuotaWindow({ window: 'seven_day_opus' })).toBe('Weekly Opus limit');
		});
		it('falls back to a generic name for an unknown or absent window', () => {
			expect(describeQuotaWindow({ window: 'unknown' })).toBe('Plan limit');
			expect(describeQuotaWindow(undefined)).toBe('Plan limit');
		});
	});
	describe('describeQuotaRemedy', () => {
		// THE TRAP THIS FUNCTION EXISTS FOR. `overageStatus` stays `allowed` after
		// hard exhaustion, so a surface reading it alone would tell a user whose turn
		// was just cut off that paid extra usage has them covered.
		it('never claims coverage once the request was rejected, even with overage allowed', () => {
			const remedy = describeQuotaRemedy({
				window: 'five_hour',
				status: 'rejected',
				overageStatus: 'allowed',
			});
			expect(remedy).toBeDefined();
			expect(remedy).not.toMatch(/cover/i);
			expect(remedy).toMatch(/exhausted/i);
		});
		it('names out-of-credits as the reason nothing can extend the window', () => {
			expect(describeQuotaRemedy(parseQuotaLimitDetail(REAL_ENVELOPE))).toMatch(/out of credits/i);
		});
		it('says extra usage will not help when overage is itself rejected', () => {
			expect(
				describeQuotaRemedy({
					window: 'seven_day',
					status: 'rejected',
					overageStatus: 'rejected',
				})
			).toMatch(/will not cover/i);
		});
		it('reports active coverage only when the request was not rejected', () => {
			expect(
				describeQuotaRemedy({
					window: 'five_hour',
					status: 'allowed_warning',
					overageStatus: 'allowed_warning',
					overageInUse: true,
				})
			).toMatch(/covering the overflow/i);
		});
		it('reports available-but-unused coverage', () => {
			expect(
				describeQuotaRemedy({ window: 'five_hour', status: 'allowed', overageStatus: 'allowed' })
			).toMatch(/available to cover/i);
		});
		it('says nothing rather than guessing when the payload supports no claim', () => {
			// A wrong reassurance here is worse than silence.
			expect(describeQuotaRemedy({ window: 'five_hour' })).toBeUndefined();
			expect(describeQuotaRemedy(undefined)).toBeUndefined();
		});
	});
});
// Source: src/__tests__/shared/codexResetCredits.test.ts
describe('', () => {
	const NOW = Date.parse('2026-09-16T12:00:00.000Z');
	function credit(overrides: Partial<CodexResetCredit> = {}): CodexResetCredit {
		return {
			id: overrides.id ?? 'RateLimitResetCredit_1',
			supportedByPlan: overrides.supportedByPlan ?? true,
			status: overrides.status ?? 'available',
			...overrides,
		};
	}
	describe('isSpendableCredit', () => {
		it('accepts an available credit the plan supports', () => {
			expect(isSpendableCredit(credit())).toBe(true);
		});
		it('rejects a credit already redeemed or expired', () => {
			expect(isSpendableCredit(credit({ status: 'redeemed' }))).toBe(false);
			expect(isSpendableCredit(credit({ status: 'expired' }))).toBe(false);
		});
		// A second consume for an id whose first is still in flight is the one way to
		// lose two credits for one reset.
		it('rejects a credit mid-redemption', () => {
			expect(isSpendableCredit(credit({ status: 'redeeming' }))).toBe(false);
		});
		it('rejects a credit the plan cannot redeem', () => {
			expect(isSpendableCredit(credit({ supportedByPlan: false }))).toBe(false);
		});
	});
	describe('spendableCredits / nextCreditToSpend', () => {
		it('spends the soonest-to-expire credit first', () => {
			const soon = credit({ id: 'soon', expiresAt: '2026-09-20T00:00:00.000Z' });
			const later = credit({ id: 'later', expiresAt: '2026-10-30T00:00:00.000Z' });
			expect(nextCreditToSpend([later, soon])?.id).toBe('soon');
			expect(spendableCredits([later, soon]).map((c) => c.id)).toEqual(['soon', 'later']);
		});
		// A known expiry is more urgent than one we do not know about, so undated
		// credits sort last rather than being burned first.
		it('sorts undated credits after dated ones', () => {
			const dated = credit({ id: 'dated', expiresAt: '2026-10-01T00:00:00.000Z' });
			const undated = credit({ id: 'undated' });
			expect(spendableCredits([undated, dated]).map((c) => c.id)).toEqual(['dated', 'undated']);
		});
		it('returns nothing when every credit is unspendable', () => {
			expect(nextCreditToSpend([credit({ status: 'redeemed' })])).toBeUndefined();
		});
	});
	describe('describeCreditSpend', () => {
		it('reports no-credits when the account holds none', () => {
			const result = describeCreditSpend({ available: 0, applicable: 0 }, []);
			expect(result.verdict).toBe('no-credits');
			expect(result.canSpend).toBe(false);
		});
		it('reports effective when a credit would reopen a window', () => {
			const result = describeCreditSpend({ available: 2, applicable: 2 }, [credit()]);
			expect(result.verdict).toBe('effective');
			expect(result.canSpend).toBe(true);
		});
		// The real shape observed from the API: two credits owned, none of which
		// would do anything because no window is consumed.
		it('reports wasteful when credits exist but none would take effect', () => {
			const result = describeCreditSpend({ available: 2, applicable: 0 }, [credit()]);
			expect(result.verdict).toBe('wasteful');
			// Still the user's credit to burn - the verdict buys an honest
			// confirmation, not a veto.
			expect(result.canSpend).toBe(true);
			expect(result.reason).toContain('spent for nothing');
		});
		// Unknown and zero are different answers; coercing the first into the second
		// would tell a user every credit they own is useless.
		it('reports unknown when the applicable count is absent', () => {
			const result = describeCreditSpend({ available: 1 }, [credit()]);
			expect(result.verdict).toBe('unknown');
			expect(result.canSpend).toBe(true);
		});
		it('falls back to the count when the credit list could not be read', () => {
			expect(describeCreditSpend({ available: 1, applicable: 1 }, []).verdict).toBe('effective');
		});
		it('reports no-credits when the list holds only unspendable credits', () => {
			const result = describeCreditSpend({ available: 1, applicable: 1 }, [
				credit({ status: 'redeemed' }),
			]);
			expect(result.verdict).toBe('no-credits');
		});
	});
	describe('shouldAutoSpendCredit', () => {
		it('fires only on an effective verdict', () => {
			expect(shouldAutoSpendCredit({ available: 1, applicable: 1 }, [credit()])).toBe(true);
		});
		// The automation is strictly narrower than the manual path: a credit is
		// finite and irreversible, so unattended spending needs confirmation that the
		// reset would actually take effect.
		it('refuses a wasteful spend the manual path would still offer', () => {
			expect(shouldAutoSpendCredit({ available: 2, applicable: 0 }, [credit()])).toBe(false);
		});
		it('refuses when the applicable count is unknown', () => {
			expect(shouldAutoSpendCredit({ available: 2 }, [credit()])).toBe(false);
		});
		it('refuses when there is nothing to spend', () => {
			expect(shouldAutoSpendCredit({ available: 0, applicable: 0 }, [])).toBe(false);
		});
	});
	describe('describeCreditExpiry', () => {
		it('names a credit that never expires', () => {
			expect(describeCreditExpiry(credit(), NOW)).toBe('Does not expire');
		});
		it('names today, tomorrow, and a day count', () => {
			expect(describeCreditExpiry(credit({ expiresAt: '2026-09-16T20:00:00.000Z' }), NOW)).toBe(
				'Expires today'
			);
			expect(describeCreditExpiry(credit({ expiresAt: '2026-09-17T18:00:00.000Z' }), NOW)).toBe(
				'Expires tomorrow'
			);
			expect(describeCreditExpiry(credit({ expiresAt: '2026-10-04T12:00:00.000Z' }), NOW)).toBe(
				'Expires in 18 days'
			);
		});
		it('names an already-lapsed credit', () => {
			expect(describeCreditExpiry(credit({ expiresAt: '2026-09-01T00:00:00.000Z' }), NOW)).toBe(
				'Expired'
			);
		});
	});
	describe('asResetCreditStatus', () => {
		it('narrows known statuses and defaults the rest to unknown', () => {
			expect(asResetCreditStatus('available')).toBe('available');
			expect(asResetCreditStatus('redeeming')).toBe('redeeming');
			expect(asResetCreditStatus('something_new')).toBe('unknown');
			expect(asResetCreditStatus(undefined)).toBe('unknown');
		});
	});
});
// Source: src/__tests__/shared/hexColor.test.ts
describe('', () => {
	describe('extractHexColor', () => {
		it('should match 6-digit hex colors', () => {
			expect(extractHexColor('#FF0000')).toBe('#FF0000');
			expect(extractHexColor('#8B3FFC')).toBe('#8B3FFC');
			expect(extractHexColor('#000000')).toBe('#000000');
		});
		it('should match 8-digit hex colors (RRGGBBAA)', () => {
			expect(extractHexColor('#FF000080')).toBe('#FF000080');
		});
		it('should trim whitespace', () => {
			expect(extractHexColor(' #FF0000 ')).toBe('#FF0000');
		});
		it('should NOT match 3-digit hex (collides with issue/PR refs like #197)', () => {
			expect(extractHexColor('#FFF')).toBeNull();
			expect(extractHexColor('#abc')).toBeNull();
			expect(extractHexColor('#197')).toBeNull();
		});
		it('should NOT match 4-digit hex shorthand', () => {
			expect(extractHexColor('#FFFA')).toBeNull();
		});
		it('should return null for non-hex content', () => {
			expect(extractHexColor('hello')).toBeNull();
			expect(extractHexColor('#GGG')).toBeNull();
			expect(extractHexColor('#12345')).toBeNull();
			expect(extractHexColor('rgb(255,0,0)')).toBeNull();
			expect(extractHexColor('#FF0000 extra')).toBeNull();
		});
		it('should handle non-string children', () => {
			expect(extractHexColor(123)).toBeNull();
			expect(extractHexColor(null)).toBeNull();
			expect(extractHexColor(undefined)).toBeNull();
		});
	});
});
