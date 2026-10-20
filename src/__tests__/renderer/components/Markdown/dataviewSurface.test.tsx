/**
 * Where Dataview renders (D3, D7, DV-10): only on a document surface that opted
 * in, only while the Encore Feature is on, and never in the chat preset. Also
 * covers the line tags `createPrismCodeBlock()` now keeps around a rendered
 * block, which preview/edit scroll sync reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { Markdown } from '../../../../renderer/components/Markdown/Markdown';
import { rehypeSourceLine } from '../../../../renderer/components/Markdown/rehypeSourceLine';
import {
	createMarkdownComponents,
	REMARK_GFM_PLUGINS,
} from '../../../../renderer/utils/markdownConfig';
import {
	DATAVIEW_LANGUAGE_RENDERERS,
	dataviewInlineCodeRenderer,
	withDataviewLanguageRenderers,
	type LanguageRenderers,
} from '../../../../renderer/components/Markdown/components/dataviewSurface';
import { DataviewBlock } from '../../../../renderer/components/Markdown/components/DataviewBlock';
import { DataviewJsBlock } from '../../../../renderer/components/Markdown/components/DataviewJsBlock';
import {
	DataviewDocumentContext,
	type DataviewDocumentScope,
} from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import { DataviewDocumentProvider } from '../../../../renderer/components/Markdown/components/DataviewDocumentProvider';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

// The chat preset highlights through Shiki; stub it so the synchronous fallback renders.
vi.mock('shiki', () => ({
	createHighlighter: vi.fn(async () => ({
		codeToHtml: () => '<pre class="shiki"><code>mocked</code></pre>',
		getLoadedLanguages: () => [],
		loadLanguage: async () => undefined,
	})),
	bundledLanguagesInfo: [],
	bundledLanguagesAlias: {},
}));
vi.mock('highlight.js', () => ({
	default: { highlightAuto: vi.fn(() => ({ language: null, relevance: 0 })) },
}));

const FENCE = '# Notes\n\n```dataview\nLIST FROM "People"\n```\n';
const JS_FENCE = '```dataviewjs\ndv.paragraph(dv.current().file.name)\n```\n';
const JS_SPAN = 'Pages: `$= dv.pages().length`\n';

let noteCounter = 0;
function scope(): DataviewDocumentScope {
	// A fresh note per test keeps the module-level result cache from leaking.
	noteCounter += 1;
	return { filePath: `/vault/Note-${noteCounter}.md`, agentId: 'agent-1', openLink: vi.fn() };
}

function setDataviewEnabled(enabled: boolean) {
	useSettingsStore.setState((state) => ({
		encoreFeatures: { ...state.encoreFeatures, dataview: enabled },
	}));
}

/** A document surface as File Preview and Auto Run build it. */
function renderDocumentSurface(
	content: string,
	options: { enabled: boolean; renderers?: LanguageRenderers; doc?: DataviewDocumentScope | null }
) {
	const components = createMarkdownComponents({
		theme: mockTheme,
		customLanguageRenderers: withDataviewLanguageRenderers(
			options.renderers ?? {},
			options.enabled
		),
		renderInlineCode: dataviewInlineCodeRenderer(mockTheme, options.enabled),
	});
	const doc = options.doc === undefined ? scope() : options.doc;
	return render(
		<DataviewDocumentProvider value={doc}>
			<ReactMarkdown
				remarkPlugins={REMARK_GFM_PLUGINS}
				rehypePlugins={[rehypeSourceLine]}
				components={components}
			>
				{content}
			</ReactMarkdown>
		</DataviewDocumentProvider>
	);
}

describe('dataviewSurface', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearCachedResources();
		setDataviewEnabled(true);
		useSettingsStore.setState({ dataviewJsEnabled: false, dataviewJsTrustedRoots: [] });
		vi.mocked(window.maestro.dataview.jsRoot).mockResolvedValue({
			root: '/vault',
			sshRemoteId: null,
		});
	});

	/** DataviewJS on and the vault trusted: anything that could run a script would. */
	function trustEverything() {
		useSettingsStore.setState({ dataviewJsEnabled: true, dataviewJsTrustedRoots: ['/vault'] });
	}

	describe('registration helpers', () => {
		it('adds the dataview and dataviewjs renderers only while the feature is on', () => {
			const base: LanguageRenderers = { mermaid: () => null };
			expect(withDataviewLanguageRenderers(base, false)).toBe(base);
			const on = withDataviewLanguageRenderers(base, true);
			expect(on.mermaid).toBe(base.mermaid);
			expect(on.dataview).toBe(DataviewBlock);
			expect(on.dataviewjs).toBe(DataviewJsBlock);
			expect(DATAVIEW_LANGUAGE_RENDERERS).toEqual({
				dataview: DataviewBlock,
				dataviewjs: DataviewJsBlock,
			});
		});

		it('claims `= expr` and `$= expr` spans, and nothing else', () => {
			const renderSpan = dataviewInlineCodeRenderer(mockTheme, true)!;
			const fallback = <code>x</code>;
			expect(renderSpan('= this.file.name', fallback)).not.toBeNull();
			expect(renderSpan('$= dv.current()', fallback)).not.toBeNull();
			expect(renderSpan('const x = 1', fallback)).toBeNull();
			expect(renderSpan('$=', fallback)).toBeNull();
		});

		it('offers the inline renderer only while the feature is on', () => {
			expect(dataviewInlineCodeRenderer(mockTheme, false)).toBeUndefined();
			expect(typeof dataviewInlineCodeRenderer(mockTheme, true)).toBe('function');
		});
	});

	describe('document surface', () => {
		it('renders a dataview fence as a block and runs its query', () => {
			const doc = scope();
			const { container } = renderDocumentSurface(FENCE, { enabled: true, doc });
			expect(container.querySelector('[data-dataview-block]')).toBeTruthy();
			expect(window.maestro.dataview.query).toHaveBeenCalledWith({
				filePath: doc.filePath,
				source: 'LIST FROM "People"',
				agentId: 'agent-1',
			});
		});

		it('keeps the fence line on a wrapper around the block, and none inside it', () => {
			const { container } = renderDocumentSurface(FENCE, { enabled: true });
			const block = container.querySelector('[data-dataview-block]');
			expect(block?.parentElement?.getAttribute('data-source-line')).toBe('3');
			expect(block?.querySelector('[data-source-line]')).toBeNull();
			// The tags still ascend in document order, which line sync assumes.
			const lines = Array.from(container.querySelectorAll('[data-source-line]')).map((el) =>
				Number(el.getAttribute('data-source-line'))
			);
			expect(lines).toEqual([...lines].sort((a, b) => a - b));
		});

		it('renders the fence as ordinary code while the feature is off', () => {
			setDataviewEnabled(false);
			const { container } = renderDocumentSurface(FENCE, { enabled: false });
			expect(container.querySelector('[data-dataview-block]')).toBeNull();
			expect(container.textContent).toContain('LIST FROM "People"');
			expect(window.maestro.dataview.query).not.toHaveBeenCalled();
		});

		it('leaves an inline `= expr` span as code while the feature is off', () => {
			setDataviewEnabled(false);
			const { container } = renderDocumentSurface('Name: `= this.file.name`\n', {
				enabled: false,
			});
			expect(container.querySelector('code')?.textContent).toBe('= this.file.name');
			expect(window.maestro.dataview.queryInline).not.toHaveBeenCalled();
		});

		it('renders a dataviewjs fence as ordinary code while DataviewJS is off', () => {
			const { container } = renderDocumentSurface(JS_FENCE, { enabled: true });
			expect(container.querySelector('.dataview-js')).toBeNull();
			expect(container.textContent).toContain('dv.paragraph(dv.current().file.name)');
			expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
		});

		it('hands a dataviewjs fence to the DataviewJS block once DataviewJS is on', async () => {
			trustEverything();
			const { container } = renderDocumentSurface(JS_FENCE, { enabled: true });
			// The block asks main for the note's root, then (trusted) mounts the frame, which waits for a slot.
			expect(window.maestro.dataview.jsRoot).toHaveBeenCalled();
			await vi.waitFor(() =>
				expect(container.querySelector('[data-dataview-js-block]')).not.toBeNull()
			);
		});

		it('leaves an inline `$= expr` span as code, with no guest, while DataviewJS is off', () => {
			const { container } = renderDocumentSurface(JS_SPAN, { enabled: true });
			expect(container.querySelector('code')?.textContent).toBe('$= dv.pages().length');
			expect(container.querySelector('[data-dataview-js-inline]')).toBeNull();
			expect(container.querySelector('webview')).toBeNull();
		});

		it('tags an ordinary highlighted code block with its line', () => {
			const { container } = renderDocumentSurface('intro\n\n```js\nconst x = 1;\n```\n', {
				enabled: true,
			});
			expect(container.querySelector('div[data-source-line="3"]')?.textContent).toContain(
				'const x = 1;'
			);
		});

		it('does not resolve a fence language through Object.prototype', () => {
			expect(() =>
				renderDocumentSurface('```constructor\nx\n```\n\n```toString\ny\n```\n', {
					enabled: true,
				})
			).not.toThrow();
		});
	});

	describe('chat preset (DV-10)', () => {
		it('never renders a dataview fence or inline span, even inside a document scope', () => {
			const { container } = render(
				<DataviewDocumentContext.Provider value={scope()}>
					<Markdown
						preset="chat"
						content={`${FENCE}\nName: \`= this.file.name\`\n`}
						theme={mockTheme}
						onCopy={() => {}}
					/>
				</DataviewDocumentContext.Provider>
			);
			expect(container.querySelector('[data-dataview-block]')).toBeNull();
			expect(container.querySelector('[data-dataview-inline]')).toBeNull();
			expect(container.textContent).toContain('LIST FROM "People"');
			expect(window.maestro.dataview.query).not.toHaveBeenCalled();
			expect(window.maestro.dataview.queryInline).not.toHaveBeenCalled();
		});

		it('never mounts a DataviewJS guest for a dataviewjs fence or a `$=` span, even fully trusted', async () => {
			trustEverything();
			const { container } = render(
				<DataviewDocumentProvider value={scope()}>
					<Markdown
						preset="chat"
						content={`${JS_FENCE}\n${JS_SPAN}`}
						theme={mockTheme}
						onCopy={() => {}}
					/>
				</DataviewDocumentProvider>
			);
			await Promise.resolve();
			expect(container.querySelector('webview')).toBeNull();
			expect(container.querySelector('.dataview-js')).toBeNull();
			expect(container.querySelector('[data-dataview-js-inline]')).toBeNull();
			expect(container.textContent).toContain('dv.paragraph(dv.current().file.name)');
			expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
			expect(window.maestro.dataview.jsSnapshot).not.toHaveBeenCalled();
		});

		it('the document preset does not register Dataview on its own either', () => {
			const { container } = render(
				<DataviewDocumentContext.Provider value={scope()}>
					<Markdown preset="document" content={FENCE} theme={mockTheme} />
				</DataviewDocumentContext.Provider>
			);
			expect(container.querySelector('[data-dataview-block]')).toBeNull();
			expect(window.maestro.dataview.query).not.toHaveBeenCalled();
		});
	});
});
