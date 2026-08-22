import { describe, it, expect } from 'vitest';
import { buildBlocks } from '../../../../../renderer/components/FilePreview/markdownFast/pipeline';
import { sanitizeBlock } from '../../../../../renderer/components/FilePreview/markdownFast/sanitize';

/**
 * The Fast tier assembles HTML from a markdown-it token stream instead of
 * rendering React, so it needs its own alert transform. Without it a large
 * document showed a literal `[!WARNING]` while the same file rendered a styled
 * callout on the Rich tier - the tier chip is supposed to change responsiveness,
 * not content.
 */
const html = (source: string) =>
	buildBlocks(source)
		.map((block) => block.html)
		.join('\n');

describe('Fast tier alert callouts', () => {
	it('tags the blockquote and injects the labeled header', () => {
		const out = html('> [!WARNING]\n> Mind the gap.\n');

		expect(out).toContain('markdown-alert markdown-alert-warning');
		expect(out).toContain('data-alert-type="warning"');
		expect(out).toContain('<span>Warning</span>');
		expect(out).toContain('<svg');
		expect(out).not.toContain('[!WARNING]');
		expect(out).toContain('Mind the gap.');
	});

	it('recognizes every type, case-insensitively', () => {
		for (const [marker, type] of [
			['NOTE', 'note'],
			['TIP', 'tip'],
			['Important', 'important'],
			['warning', 'warning'],
			['CAUTION', 'caution'],
		]) {
			expect(html(`> [!${marker}]\n> Body.\n`)).toContain(`markdown-alert-${type}`);
		}
	});

	// GitHub only treats the marker as an alert when it stands alone on the first
	// line, and remarkAlert matches that. The tiers must agree.
	it('leaves a marker with a trailing title as an ordinary blockquote', () => {
		const out = html('> [!NOTE] with a title\n> Body.\n');

		expect(out).not.toContain('markdown-alert');
		expect(out).toContain('[!NOTE] with a title');
	});

	it('leaves an ordinary blockquote alone', () => {
		const out = html('> Just a quote.\n');

		expect(out).not.toContain('markdown-alert');
		expect(out).toContain('Just a quote.');
	});

	it('does not leave a blank first line when the callout body starts on line two', () => {
		const out = html('> [!TIP]\n> First body line.\n');

		expect(out).not.toMatch(/<p>\s*<br>/);
		expect(out).toContain('First body line.');
	});

	// The injected header goes through DOMPurify at render time; an over-eager
	// policy would drop the icon and leave a label with no glyph.
	it('survives the block sanitizer', () => {
		const sanitized = sanitizeBlock(html('> [!CAUTION]\n> Careful.\n'));

		expect(sanitized).toContain('markdown-alert-caution');
		expect(sanitized).toContain('<span>Caution</span>');
		expect(sanitized).toContain('<svg');
	});

	it('keeps the callout in one block so virtualization cannot split it', () => {
		const blocks = buildBlocks('# Doc\n\n> [!NOTE]\n> Body.\n');

		expect(blocks).toHaveLength(2);
		expect(blocks[1].html).toContain('markdown-alert-note');
		expect(blocks[1].html).toContain('Body.');
	});
});
