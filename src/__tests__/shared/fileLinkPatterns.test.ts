import { describe, expect, it } from 'vitest';
import * as shared from '../../shared/fileLinkPatterns';
import * as rendererPatterns from '../../renderer/utils/fileLinks/patterns';
import * as fileLinksBarrel from '../../renderer/utils/fileLinks';

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
