import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMarkdownLink } from '../../../../renderer/components/Markdown/components/MarkdownLink';

// Mock the URL openers so we can assert routing without touching the shell.
vi.mock('../../../../renderer/utils/openUrl', () => ({
	openUrl: vi.fn(),
	openInMaestroBrowser: vi.fn(),
	openInSystemBrowser: vi.fn(),
}));
vi.mock('../../../../renderer/utils/openMaestroLink', () => ({
	openMaestroLink: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import { openUrl } from '../../../../renderer/utils/openUrl';
import { openMaestroLink } from '../../../../renderer/utils/openMaestroLink';
import { notifyToast } from '../../../../renderer/stores/notificationStore';

const theme = { colors: { accent: '#3366ff', accentText: '#88aaff' } } as any;

function makeEvent(overrides: Record<string, unknown> = {}) {
	return {
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		metaKey: false,
		ctrlKey: false,
		clientX: 10,
		clientY: 20,
		...overrides,
	} as any;
}

/** Invoke the factory's returned component and return the produced element. */
function renderLink(
	config: Parameters<typeof createMarkdownLink>[0],
	props: Record<string, unknown>
) {
	const Link = createMarkdownLink(config);
	return Link({ node: null, ...props } as any);
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		...(window as any).maestro,
		shell: { openPath: vi.fn(), openExternal: vi.fn() },
	};
});

describe('createMarkdownLink - shared targets', () => {
	it('reports when a Concerto chip points to an unavailable Movement', async () => {
		const el = renderLink(
			{ theme },
			{ href: 'maestro://concerto/movement/missing', children: 'open it' }
		);

		el.props.onClick(makeEvent());

		await vi.waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Concerto unavailable', color: 'orange' })
			)
		);
	});

	it('routes maestro:// through openMaestroLink', () => {
		const el = renderLink({ theme }, { href: 'maestro://settings', children: 'x' });
		el.props.onClick(makeEvent());
		expect(openMaestroLink).toHaveBeenCalledWith('maestro://settings');
	});

	it('opens a maestro-file:// link via onFileClick', () => {
		const onFileClick = vi.fn();
		const el = renderLink(
			{ theme, onFileClick },
			{ href: 'maestro-file://src/app.ts', children: 'x' }
		);
		el.props.onClick(makeEvent());
		expect(onFileClick).toHaveBeenCalled();
		expect(onFileClick.mock.calls[0][0]).toBe('src/app.ts');
	});

	it('detects file links via the data-maestro-file attribute fallback', () => {
		const onFileClick = vi.fn();
		const el = renderLink(
			{ theme, onFileClick },
			{ href: '#', 'data-maestro-file': 'report.csv', children: 'report.csv' }
		);
		el.props.onClick(makeEvent());
		expect(onFileClick.mock.calls[0][0]).toBe('report.csv');
	});
});

describe('createMarkdownLink - chat behavior (directExternal, accentText, context menus)', () => {
	const chat = (extra: Record<string, unknown> = {}) => ({
		theme,
		linkColor: 'accentText' as const,
		behavior: { directExternal: true },
		...extra,
	});

	it('uses the accentText color slot', () => {
		const el = renderLink(chat(), { href: 'https://x.com', children: 'x' });
		expect(el.props.style.color).toBe(theme.colors.accentText);
	});

	it('calls onFileClick WITHOUT options (preserves historical chat call shape)', () => {
		const onFileClick = vi.fn();
		const el = renderLink(chat({ onFileClick }), {
			href: 'maestro-file://a.ts',
			children: 'x',
		});
		el.props.onClick(makeEvent({ metaKey: true }));
		expect(onFileClick).toHaveBeenCalledWith('a.ts');
		expect(onFileClick.mock.calls[0]).toHaveLength(1);
	});

	it('opens http(s) links inline via openUrl', () => {
		const el = renderLink(chat(), { href: 'https://example.com', children: 'x' });
		el.props.onClick(makeEvent({ ctrlKey: true }));
		expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: true });
	});

	it('translates Cmd-click (metaKey) into ctrlKey:true for openUrl (#1060)', () => {
		const el = renderLink(chat(), { href: 'https://example.com', children: 'x' });
		el.props.onClick(makeEvent({ metaKey: true }));
		expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: true });
	});

	it('opens file:// links via the shell', () => {
		const el = renderLink(chat(), { href: 'file:///tmp/x.txt', children: 'x' });
		el.props.onClick(makeEvent());
		expect((window as any).maestro.shell.openPath).toHaveBeenCalledWith('/tmp/x.txt');
	});

	it('converts git@ URLs to https and opens them', () => {
		const el = renderLink(chat(), { href: 'git@github.com:user/repo.git', children: 'x' });
		el.props.onClick(makeEvent());
		expect(openUrl).toHaveBeenCalledWith('https://github.com/user/repo', { ctrlKey: false });
	});

	it('does NOT treat unmatched relative links as file clicks', () => {
		const onFileClick = vi.fn();
		const el = renderLink(chat({ onFileClick }), { href: 'somewhere/relative.md', children: 'x' });
		el.props.onClick(makeEvent());
		expect(onFileClick).not.toHaveBeenCalled();
	});

	it('opens a file context menu on right-click of a file link (resolving via projectRoot)', () => {
		const onFileContextMenu = vi.fn();
		const el = renderLink(chat({ projectRoot: '/Users/me/proj', onFileContextMenu }), {
			href: '#',
			'data-maestro-file': 'docs/readme.md',
			children: 'x',
		});
		el.props.onContextMenu(makeEvent());
		expect(onFileContextMenu).toHaveBeenCalled();
		expect(onFileContextMenu.mock.calls[0][1]).toBe('/Users/me/proj/docs/readme.md');
		expect(onFileContextMenu.mock.calls[0][2]).toBe('readme.md');
	});

	it('opens a link context menu on right-click of an external link', () => {
		const onLinkContextMenu = vi.fn();
		const el = renderLink(chat({ onLinkContextMenu }), { href: 'https://x.com', children: 'x' });
		el.props.onContextMenu(makeEvent());
		expect(onLinkContextMenu).toHaveBeenCalledWith(expect.anything(), 'https://x.com');
	});
});

describe('createMarkdownLink - document behavior (anchors, relativeAsFile, callbacks)', () => {
	const doc = (extra: Record<string, unknown> = {}) => ({
		theme,
		linkColor: 'accent' as const,
		behavior: { anchors: true, relativeAsFile: true, fileClickOptions: true },
		...extra,
	});

	it('uses the accent color slot and attaches NO context menu handler', () => {
		const el = renderLink(doc(), { href: 'https://x.com', children: 'x' });
		expect(el.props.style.color).toBe(theme.colors.accent);
		expect(el.props.onContextMenu).toBeUndefined();
	});

	it('calls onFileClick WITH openInNewTab for maestro-file links', () => {
		const onFileClick = vi.fn();
		const el = renderLink(doc({ onFileClick }), { href: 'maestro-file://a.ts', children: 'x' });
		el.props.onClick(makeEvent({ metaKey: true }));
		expect(onFileClick).toHaveBeenCalledWith('a.ts', { openInNewTab: true });
	});

	it('routes external http/mailto links through onExternalLinkClick', () => {
		const onExternalLinkClick = vi.fn();
		const el = renderLink(doc({ onExternalLinkClick }), {
			href: 'https://example.com',
			children: 'x',
		});
		el.props.onClick(makeEvent());
		expect(onExternalLinkClick).toHaveBeenCalledWith('https://example.com', { ctrlKey: false });
	});

	it('routes relative paths to onFileClick with options', () => {
		const onExternalLinkClick = vi.fn();
		const onFileClick = vi.fn();
		const el = renderLink(doc({ onExternalLinkClick, onFileClick }), {
			href: 'LICENSE',
			children: 'x',
		});
		el.props.onClick(makeEvent());
		expect(onFileClick).toHaveBeenCalledWith('LICENSE', { openInNewTab: false });
		expect(onExternalLinkClick).not.toHaveBeenCalled();
	});

	it('does not call onExternalLinkClick for relative paths', () => {
		const onExternalLinkClick = vi.fn();
		const el = renderLink(doc({ onExternalLinkClick }), { href: './README.md', children: 'x' });
		el.props.onClick(makeEvent());
		expect(onExternalLinkClick).not.toHaveBeenCalled();
	});

	it('invokes onAnchorClick for #anchor links', () => {
		const onAnchorClick = vi.fn();
		const el = renderLink(doc({ onAnchorClick }), { href: '#section', children: 'x' });
		el.props.onClick(makeEvent());
		expect(onAnchorClick).toHaveBeenCalledWith('section');
	});

	it('scrolls to the target when no onAnchorClick is provided', () => {
		const target = document.createElement('div');
		target.id = 'goto';
		target.scrollIntoView = vi.fn();
		document.body.appendChild(target);
		const el = renderLink(doc(), { href: '#goto', children: 'x' });
		el.props.onClick(makeEvent());
		expect(target.scrollIntoView).toHaveBeenCalled();
		document.body.removeChild(target);
	});
});
