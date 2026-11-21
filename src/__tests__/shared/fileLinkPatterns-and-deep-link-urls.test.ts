// Source: src/__tests__/shared/fileLinkPatterns.test.ts
// Source: src/__tests__/shared/deep-link-urls.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import * as shared from '../../shared/fileLinkPatterns';
import * as rendererPatterns from '../../renderer/utils/fileLinks/patterns';
import * as fileLinksBarrel from '../../renderer/utils/fileLinks';
import { buildSessionDeepLink } from '../../shared/deep-link-urls';
import { buildGroupDeepLink } from '../../shared/deep-link-urls';
import { buildFileDeepLink } from '../../shared/deep-link-urls';
import { buildPromptLinkUrl } from '../../shared/deep-link-urls';
import { parseMaestroDeepLink } from '../../shared/deep-link-urls';
import { redactDeepLinkUrl } from '../../shared/deep-link-urls';
describeSourceSuite('fileLinkPatterns', () => {
	function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
		pattern.lastIndex = 0;
		const out: RegExpExecArray[] = [];
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) out.push(match);
		pattern.lastIndex = 0;
		return out;
	}

	describe('fileLinkPatterns', () => {
		it('is the same module the renderer re-exports, so main and the preview agree', () => {
			expect(rendererPatterns.WIKI_LINK_PATTERN).toBe(shared.WIKI_LINK_PATTERN);
			expect(rendererPatterns.IMAGE_EMBED_PATTERN).toBe(shared.IMAGE_EMBED_PATTERN);
			expect(rendererPatterns.MAESTRO_DEEP_LINK_PATTERN).toBe(shared.MAESTRO_DEEP_LINK_PATTERN);
			expect(fileLinksBarrel.WIKI_LINK_PATTERN).toBe(shared.WIKI_LINK_PATTERN);
			expect(fileLinksBarrel.PATH_PATTERN).toBe(shared.PATH_PATTERN);
		});

		it('captures the wiki link target and its alias', () => {
			const matches = allMatches(
				shared.WIKI_LINK_PATTERN,
				'See [[Note]], [[Folder/Note|Shown]], and [[Note#Heading]].'
			);
			expect(matches.map((m) => [m[1], m[2]])).toEqual([
				['Note', undefined],
				['Folder/Note', 'Shown'],
				['Note#Heading', undefined],
			]);
		});

		it('captures an image embed and its width, and ignores non-image embeds', () => {
			const matches = allMatches(shared.IMAGE_EMBED_PATTERN, '![[a/pic.png|300]] ![[Note]]');
			expect(matches.map((m) => [m[1], m[2]])).toEqual([['a/pic.png', '300']]);
		});
	});
});
describeSourceSuite('deep-link-urls', () => {
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

	describe('Prompt Link URLs (maestro://run/<token>)', () => {
		it('builds a run URL that carries only the token', () => {
			expect(buildPromptLinkUrl('abcDEF123_-')).toBe('maestro://run/abcDEF123_-');
		});

		it('parses a run URL into a run action with its token', () => {
			expect(parseMaestroDeepLink('maestro://run/abcDEF123_-')).toEqual({
				action: 'run',
				token: 'abcDEF123_-',
			});
		});

		it('round-trips through the builder', () => {
			expect(parseMaestroDeepLink(buildPromptLinkUrl('tok'))).toEqual({
				action: 'run',
				token: 'tok',
			});
		});

		it('refuses a run URL with extra path segments rather than ignoring them', () => {
			expect(parseMaestroDeepLink('maestro://run/tok/agent/abc')).toBeNull();
		});

		it('refuses a run URL with no token', () => {
			expect(parseMaestroDeepLink('maestro://run')).toBeNull();
			expect(parseMaestroDeepLink('maestro://run/')).toBeNull();
		});

		it('handles the Windows maestro: form', () => {
			expect(parseMaestroDeepLink('maestro:run/tok')).toEqual({ action: 'run', token: 'tok' });
		});
	});

	describe('redactDeepLinkUrl', () => {
		it('cuts a Prompt Link token to its first four characters', () => {
			expect(redactDeepLinkUrl('maestro://run/abcdefghijklmnop')).toBe('maestro://run/abcd...');
		});

		it('redacts the Windows form too', () => {
			expect(redactDeepLinkUrl('maestro:run/abcdefghijklmnop')).toBe('maestro:run/abcd...');
		});

		it('leaves every other maestro:// URL unchanged', () => {
			expect(redactDeepLinkUrl('maestro://session/abc/tab/def')).toBe(
				'maestro://session/abc/tab/def'
			);
			expect(redactDeepLinkUrl('maestro://focus')).toBe('maestro://focus');
		});
	});
});
