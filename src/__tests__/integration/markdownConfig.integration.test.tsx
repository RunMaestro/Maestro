import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children, customStyle, language }: any) => (
		<pre
			data-testid="syntax-highlighter"
			data-language={language}
			data-margin={customStyle?.margin}
			data-padding={customStyle?.padding}
		>
			{children}
		</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vs: { 'pre[class*="language-"]': {}, 'code[class*="language-"]': {} },
	vscDarkPlus: { 'pre[class*="language-"]': {}, 'code[class*="language-"]': {} },
}));

import {
	applyReadableTextTransforms,
	createMarkdownComponents,
	createReleaseNotesMarkdownComponents,
	createWizardBubbleMarkdownComponents,
	generateAutoRunProseStyles,
	generateDiffViewStyles,
	generateInlineWizardPreviewProseStyles,
	generateProseStyles,
	generateTerminalProseStyles,
} from '../../renderer/utils/markdownConfig';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-theme',
	name: 'Integration Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101018',
		bgSidebar: '#161622',
		bgActivity: '#202033',
		textMain: '#f4f4f8',
		textDim: '#9999aa',
		border: '#33334a',
		accent: '#4a9eff',
		success: '#20c997',
		warning: '#f59f00',
		error: '#ff6b6b',
	},
} as Theme;

describe('markdownConfig integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			...(window as any).maestro,
			shell: {
				...(window as any).maestro?.shell,
				openExternal: vi.fn(),
			},
		};
	});

	afterEach(() => {
		cleanup();
	});

	it('generates scoped prose, inline wizard, terminal, diff, and Auto Run styles', () => {
		const defaultStyles = generateProseStyles({ theme });
		expect(defaultStyles).toContain('.prose h1');
		expect(defaultStyles).toContain('input[type="checkbox"]');
		expect(defaultStyles).toContain(theme.colors.bgActivity);

		const compactStyles = generateProseStyles({
			theme,
			coloredHeadings: true,
			compactSpacing: true,
			includeCheckboxStyles: false,
			scopeSelector: '.scope',
		});
		expect(compactStyles).toContain('.scope .prose h1');
		expect(compactStyles).toContain(theme.colors.accent);
		expect(compactStyles).toContain('margin-top: 0');
		expect(compactStyles).not.toContain('input[type="checkbox"]:checked');

		expect(generateAutoRunProseStyles(theme)).toContain('.autorun-panel .prose');
		expect(generateTerminalProseStyles(theme, '.terminal')).toContain('.terminal .prose h2');
		expect(generateDiffViewStyles(theme)).toContain('.diff-gutter');

		const streaming = generateInlineWizardPreviewProseStyles(theme, '.inline', 'streaming');
		const document = generateInlineWizardPreviewProseStyles(theme, '', 'document');
		expect(streaming).toContain('.inline.prose');
		expect(streaming).toContain('width: 14px');
		expect(document).toContain('.prose h1');
		expect(document).toContain('width: 16px');
	});

	it('applies readable transforms with search highlighting across nested children', () => {
		const onMatchRendered = vi.fn();
		const components = createMarkdownComponents({
			theme,
			searchHighlight: {
				query: 'needle',
				currentMatchIndex: 1,
				onMatchRendered,
			},
			enableBionifyReadingMode: true,
			bionifyIntensity: 0.7,
			bionifyAlgorithm: 'balanced',
		});
		const Paragraph = components.p as React.ComponentType<any>;

		render(
			<Paragraph>
				Find needle and NEEDLE inside <span>needle</span>
				{42}
				{null}
			</Paragraph>
		);

		const marks = document.querySelectorAll('mark.search-match');
		expect(marks).toHaveLength(3);
		expect(marks[1]).toHaveAttribute('data-current', 'true');
		expect(onMatchRendered).toHaveBeenCalledWith(1, marks[1]);

		cleanup();
		render(
			<div>
				{applyReadableTextTransforms(['plain text', <span key="s">no match</span>, 7], {
					theme,
					searchHighlight: { query: 'absent', currentMatchIndex: 0 },
					enableBionifyReadingMode: false,
				})}
			</div>
		);
		expect(screen.getByText(/plain text/)).toBeInTheDocument();
		expect(screen.queryByText('absent')).not.toBeInTheDocument();

		cleanup();
		render(
			<div>
				{applyReadableTextTransforms(
					[React.createElement('br', { key: 'br' }), ['needle', ' nested']],
					{
						theme,
						searchHighlight: { query: 'needle', currentMatchIndex: 0 },
						enableBionifyReadingMode: false,
					}
				)}
			</div>
		);
		expect(document.querySelector('br')).toBeInTheDocument();
		expect(document.querySelector('mark.search-match')).toHaveTextContent('needle');
	});

	it('creates core markdown renderers for prose, code blocks, images, links, and details', () => {
		const ImageRenderer = ({ alt, src }: { alt?: string; src?: string }) => (
			<img alt={alt} data-testid="custom-image" src={src} />
		);
		const MermaidRenderer = ({ code }: { code: string }) => (
			<div data-testid="mermaid-renderer">{code}</div>
		);
		const onFileClick = vi.fn();
		const onExternalLinkClick = vi.fn();
		const onAnchorClick = vi.fn();
		const components = createMarkdownComponents({
			theme,
			imageRenderer: ImageRenderer,
			customLanguageRenderers: { mermaid: MermaidRenderer },
			onFileClick,
			onExternalLinkClick,
			onAnchorClick,
			codeBlockStyle: {
				margin: '2px',
				padding: '3px',
				fontSize: '11px',
				borderRadius: '4px',
				backgroundColor: '#010203',
			},
		});

		const H1 = components.h1 as React.ComponentType<any>;
		const H2 = components.h2 as React.ComponentType<any>;
		const H3 = components.h3 as React.ComponentType<any>;
		const H4 = components.h4 as React.ComponentType<any>;
		const H5 = components.h5 as React.ComponentType<any>;
		const H6 = components.h6 as React.ComponentType<any>;
		const Li = components.li as React.ComponentType<any>;
		const Td = components.td as React.ComponentType<any>;
		const Th = components.th as React.ComponentType<any>;
		const Quote = components.blockquote as React.ComponentType<any>;
		const Strong = components.strong as React.ComponentType<any>;
		const Em = components.em as React.ComponentType<any>;
		const Img = components.img as React.ComponentType<any>;
		const Pre = components.pre as React.ComponentType<any>;
		const Code = components.code as React.ComponentType<any>;
		const Anchor = components.a as React.ComponentType<any>;
		const Details = components.details as React.ComponentType<any>;

		render(
			<div>
				<H1>One</H1>
				<H2>Two</H2>
				<H3>Three</H3>
				<H4>Four</H4>
				<H5>Five</H5>
				<H6>Six</H6>
				<Li>Item</Li>
				<table>
					<tbody>
						<tr>
							<Th>Head</Th>
							<Td>Cell</Td>
						</tr>
					</tbody>
				</table>
				<Quote>Quote</Quote>
				<Strong>Strong</Strong>
				<Em>Emphasis</Em>
				<Img alt="diagram" src="/diagram.png" />
				<Pre>
					<code className="language-mermaid">graph TD;</code>
				</Pre>
				<Pre>
					<code className="language-ts">{'const value = 1;\n'}</code>
				</Pre>
				<Pre>plain pre</Pre>
				<Code className="language-js">inline</Code>
				<Anchor href="maestro-file:///tmp/plan.md">file</Anchor>
				<Anchor data-maestro-file="/tmp/data.md" href="">
					data file
				</Anchor>
				<Anchor href="#section">anchor</Anchor>
				<Anchor href="https://example.com">external</Anchor>
				<Anchor href="./relative.md">relative</Anchor>
				<Details open onToggle="ignored">
					Details body
				</Details>
			</div>
		);

		expect(screen.getByTestId('custom-image')).toHaveAttribute('src', '/diagram.png');
		expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent('graph TD;');
		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-language', 'ts');
		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-margin', '2px');
		expect(screen.getByText('plain pre').tagName).toBe('PRE');

		fireEvent.click(screen.getByText('file'), { metaKey: true });
		expect(onFileClick).toHaveBeenCalledWith('/tmp/plan.md', { openInNewTab: true });
		fireEvent.click(screen.getByText('data file'));
		expect(onFileClick).toHaveBeenCalledWith('/tmp/data.md', { openInNewTab: false });
		fireEvent.click(screen.getByText('anchor'));
		expect(onAnchorClick).toHaveBeenCalledWith('section');
		fireEvent.click(screen.getByText('external'));
		expect(onExternalLinkClick).toHaveBeenCalledWith('https://example.com', { ctrlKey: false });
		fireEvent.click(screen.getByText('relative'), { ctrlKey: true });
		expect(onFileClick).toHaveBeenCalledWith('./relative.md', { openInNewTab: true });
		expect(screen.getByText('Details body').closest('details')).toBeInTheDocument();
	});

	it('scrolls anchor links with container or document fallback when no anchor callback is provided', () => {
		const scrollIntoView = vi.fn();
		const container = document.createElement('div');
		const target = document.createElement('div');
		target.id = 'inside';
		target.scrollIntoView = scrollIntoView;
		container.appendChild(target);

		const withContainer = createMarkdownComponents({
			theme,
			onFileClick: vi.fn(),
			containerRef: { current: container },
		});
		const ContainerAnchor = withContainer.a as React.ComponentType<any>;
		render(<ContainerAnchor href="#inside">inside link</ContainerAnchor>);
		fireEvent.click(screen.getByText('inside link'));
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

		cleanup();
		const documentTarget = document.createElement('div');
		documentTarget.id = 'outside';
		documentTarget.scrollIntoView = scrollIntoView;
		document.body.appendChild(documentTarget);

		const withDocument = createMarkdownComponents({ theme, onFileClick: vi.fn() });
		const DocumentAnchor = withDocument.a as React.ComponentType<any>;
		render(<DocumentAnchor href="#outside">outside link</DocumentAnchor>);
		fireEvent.click(screen.getByText('outside link'));
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
		documentTarget.remove();
	});

	it('creates wizard bubble and release note markdown components with shell link handling', () => {
		const wizard = createWizardBubbleMarkdownComponents(theme);
		const release = createReleaseNotesMarkdownComponents(theme);
		const WizardCode = wizard.code as React.ComponentType<any>;
		const WizardPre = wizard.pre as React.ComponentType<any>;
		const WizardAnchor = wizard.a as React.ComponentType<any>;
		const WizardP = wizard.p as React.ComponentType<any>;
		const WizardUl = wizard.ul as React.ComponentType<any>;
		const WizardOl = wizard.ol as React.ComponentType<any>;
		const WizardLi = wizard.li as React.ComponentType<any>;
		const WizardStrong = wizard.strong as React.ComponentType<any>;
		const WizardEm = wizard.em as React.ComponentType<any>;
		const WizardH1 = wizard.h1 as React.ComponentType<any>;
		const WizardH2 = wizard.h2 as React.ComponentType<any>;
		const WizardH3 = wizard.h3 as React.ComponentType<any>;
		const WizardQuote = wizard.blockquote as React.ComponentType<any>;
		const ReleaseAnchor = release.a as React.ComponentType<any>;
		const ReleaseCode = release.code as React.ComponentType<any>;
		const ReleaseP = release.p as React.ComponentType<any>;
		const ReleaseH1 = release.h1 as React.ComponentType<any>;
		const ReleaseH2 = release.h2 as React.ComponentType<any>;
		const ReleaseH3 = release.h3 as React.ComponentType<any>;
		const ReleaseUl = release.ul as React.ComponentType<any>;
		const ReleaseOl = release.ol as React.ComponentType<any>;
		const ReleaseLi = release.li as React.ComponentType<any>;

		render(
			<div>
				<WizardP>Wizard paragraph</WizardP>
				<WizardUl>
					<WizardLi>Wizard unordered</WizardLi>
				</WizardUl>
				<WizardOl>
					<WizardLi>Wizard ordered</WizardLi>
				</WizardOl>
				<WizardStrong>Wizard strong</WizardStrong>
				<WizardEm>Wizard em</WizardEm>
				<WizardH1>Wizard h1</WizardH1>
				<WizardH2>Wizard h2</WizardH2>
				<WizardH3>Wizard h3</WizardH3>
				<WizardQuote>Wizard quote</WizardQuote>
				<WizardCode>inline</WizardCode>
				<WizardCode className="language-ts">block-code</WizardCode>
				<WizardPre>preformatted</WizardPre>
				<WizardAnchor href="https://wizard.example">wizard external</WizardAnchor>
				<WizardAnchor href="/local">wizard local</WizardAnchor>
				<ReleaseH1>Release h1</ReleaseH1>
				<ReleaseH2>Release h2</ReleaseH2>
				<ReleaseH3>Release h3</ReleaseH3>
				<ReleaseP>Release paragraph</ReleaseP>
				<ReleaseUl>
					<ReleaseLi>Release unordered</ReleaseLi>
				</ReleaseUl>
				<ReleaseOl>
					<ReleaseLi>Release ordered</ReleaseLi>
				</ReleaseOl>
				<ReleaseCode>release-code</ReleaseCode>
				<ReleaseAnchor href="mailto:test@example.com">release mail</ReleaseAnchor>
			</div>
		);

		fireEvent.click(screen.getByText('wizard external'));
		fireEvent.click(screen.getByText('wizard local'));
		fireEvent.click(screen.getByText('release mail'));

		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://wizard.example');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('mailto:test@example.com');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledTimes(2);
		expect(screen.getByText('preformatted').closest('pre')).toBeInTheDocument();
		expect(screen.getByText('Release paragraph')).toBeInTheDocument();
	});
});
