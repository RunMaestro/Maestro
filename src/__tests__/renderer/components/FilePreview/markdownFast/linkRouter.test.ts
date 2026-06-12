import { describe, it, expect } from 'vitest';
import { resolveLinkAction } from '../../../../../renderer/components/FilePreview/markdownFast/linkRouter';
import type {
	ClickModifiers,
	LinkAction,
	LinkDescriptor,
} from '../../../../../renderer/components/FilePreview/markdownFast/types';

const NO_MODIFIERS: ClickModifiers = { metaKey: false, ctrlKey: false, button: 0 };
const META_DOWN: ClickModifiers = { metaKey: true, ctrlKey: false, button: 0 };
const CTRL_DOWN: ClickModifiers = { metaKey: false, ctrlKey: true, button: 0 };
const MIDDLE_CLICK: ClickModifiers = { metaKey: false, ctrlKey: false, button: 1 };

function link(href: string, dataMaestroFile: string | null = null): LinkDescriptor {
	return { href, dataMaestroFile };
}

describe('resolveLinkAction', () => {
	it('returns none for an empty href without data attribute', () => {
		const action = resolveLinkAction(link(''), NO_MODIFIERS);
		expect(action.kind).toBe('none');
	});

	describe('maestro-file routing', () => {
		it('routes via data-maestro-file attribute when present', () => {
			const action = resolveLinkAction(link('#ignored', 'docs/file.md'), NO_MODIFIERS);
			expect(action).toEqual({
				kind: 'maestro-file',
				path: 'docs/file.md',
				openInNewTab: false,
			});
		});

		it('prefers data-maestro-file over href even when both are present', () => {
			const action = resolveLinkAction(
				link('https://example.com', 'docs/file.md'),
				NO_MODIFIERS
			) as Extract<LinkAction, { kind: 'maestro-file' }>;
			expect(action.kind).toBe('maestro-file');
			expect(action.path).toBe('docs/file.md');
		});

		it('routes maestro-file:// URLs in the href', () => {
			const action = resolveLinkAction(
				link('maestro-file://docs/readme.md'),
				NO_MODIFIERS
			) as Extract<LinkAction, { kind: 'maestro-file' }>;
			expect(action.kind).toBe('maestro-file');
			expect(action.path).toBe('docs/readme.md');
		});

		it('marks openInNewTab when meta key is held', () => {
			const action = resolveLinkAction(link('maestro-file://x.md'), META_DOWN) as Extract<
				LinkAction,
				{ kind: 'maestro-file' }
			>;
			expect(action.openInNewTab).toBe(true);
		});

		it('marks openInNewTab when ctrl key is held', () => {
			const action = resolveLinkAction(link('maestro-file://x.md'), CTRL_DOWN) as Extract<
				LinkAction,
				{ kind: 'maestro-file' }
			>;
			expect(action.openInNewTab).toBe(true);
		});

		it('marks openInNewTab on middle-click', () => {
			const action = resolveLinkAction(link('maestro-file://x.md'), MIDDLE_CLICK) as Extract<
				LinkAction,
				{ kind: 'maestro-file' }
			>;
			expect(action.openInNewTab).toBe(true);
		});

		it('handles maestro-file paths containing slashes and special chars', () => {
			const action = resolveLinkAction(
				link('maestro-file://docs/sub folder/My File.md'),
				NO_MODIFIERS
			) as Extract<LinkAction, { kind: 'maestro-file' }>;
			expect(action.path).toBe('docs/sub folder/My File.md');
		});
	});

	describe('maestro deep-link routing', () => {
		it('routes maestro:// URLs to the deep-link kind', () => {
			const action = resolveLinkAction(
				link('maestro://session/abc/tab/xyz'),
				NO_MODIFIERS
			) as Extract<LinkAction, { kind: 'maestro-deep-link' }>;
			expect(action).toEqual({
				kind: 'maestro-deep-link',
				href: 'maestro://session/abc/tab/xyz',
			});
		});

		it('routes group deep links', () => {
			const action = resolveLinkAction(link('maestro://group/grp1'), NO_MODIFIERS);
			expect(action.kind).toBe('maestro-deep-link');
		});
	});

	describe('anchor routing', () => {
		it('returns anchor action for hash hrefs', () => {
			expect(resolveLinkAction(link('#section'), NO_MODIFIERS)).toEqual({
				kind: 'anchor',
				hash: '#section',
			});
		});

		it('ignores modifiers for anchor links', () => {
			expect(resolveLinkAction(link('#x'), META_DOWN)).toEqual({
				kind: 'anchor',
				hash: '#x',
			});
		});
	});

	describe('external routing', () => {
		it('routes http(s) URLs as external', () => {
			expect(resolveLinkAction(link('https://example.com'), NO_MODIFIERS)).toEqual({
				kind: 'external',
				href: 'https://example.com',
				openInNewTab: false,
			});
			expect(resolveLinkAction(link('http://example.com'), NO_MODIFIERS).kind).toBe('external');
		});

		it('routes mailto links as external', () => {
			expect(resolveLinkAction(link('mailto:a@b.com'), NO_MODIFIERS).kind).toBe('external');
		});

		it('routes tel links as external', () => {
			expect(resolveLinkAction(link('tel:+1234'), NO_MODIFIERS).kind).toBe('external');
		});

		it('routes file:// URLs as external', () => {
			expect(resolveLinkAction(link('file:///Users/x/a.txt'), NO_MODIFIERS).kind).toBe('external');
		});

		it('marks openInNewTab when ctrl is held', () => {
			const action = resolveLinkAction(link('https://example.com'), CTRL_DOWN) as Extract<
				LinkAction,
				{ kind: 'external' }
			>;
			expect(action.openInNewTab).toBe(true);
		});
	});

	describe('non-routed links', () => {
		it('returns none for relative-path hrefs (Fast tier does not resolve these in Phase 1)', () => {
			expect(resolveLinkAction(link('relative/path.md'), NO_MODIFIERS).kind).toBe('none');
			expect(resolveLinkAction(link('./sibling.md'), NO_MODIFIERS).kind).toBe('none');
			expect(resolveLinkAction(link('../parent.md'), NO_MODIFIERS).kind).toBe('none');
		});

		it('returns none for unknown protocols', () => {
			expect(resolveLinkAction(link('chrome-extension://x'), NO_MODIFIERS).kind).toBe('none');
			expect(resolveLinkAction(link('ftp://example.com'), NO_MODIFIERS).kind).toBe('none');
		});

		it('returns none for hrefs that look like protocols but are not whitelisted', () => {
			expect(resolveLinkAction(link('javascript:alert(1)'), NO_MODIFIERS).kind).toBe('none');
		});
	});

	describe('boundary conditions', () => {
		it('does not openInNewTab when neither modifier is held and button is 0', () => {
			const action = resolveLinkAction(link('https://example.com'), NO_MODIFIERS) as Extract<
				LinkAction,
				{ kind: 'external' }
			>;
			expect(action.openInNewTab).toBe(false);
		});

		it('treats data-maestro-file as the source of truth even if href is empty', () => {
			const action = resolveLinkAction(link('', 'path/to.md'), NO_MODIFIERS);
			expect(action.kind).toBe('maestro-file');
		});

		it('falls back to href when dataMaestroFile is the empty string', () => {
			// An empty data attribute is falsy and should not short-circuit the
			// router. The href branch should still execute.
			const action = resolveLinkAction(link('https://example.com', ''), NO_MODIFIERS);
			expect(action.kind).toBe('external');
		});
	});
});
