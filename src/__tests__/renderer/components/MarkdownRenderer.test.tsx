import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownRenderer } from '../../../renderer/components/MarkdownRenderer';

import { mockTheme } from '../../helpers/mockTheme';
// Mock react-syntax-highlighter
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children, language }: { children: string; language?: string }) => (
		<pre data-testid="syntax-highlighter" data-language={language}>
			{children}
		</pre>
	),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	Loader2: () => <span data-testid="loader-icon">Loader</span>,
	ImageOff: () => <span data-testid="image-off-icon">ImageOff</span>,
	Copy: () => <span data-testid="copy-icon">Copy</span>,
	ExternalLink: () => <span data-testid="external-link-icon">ExternalLink</span>,
	Globe: () => <span data-testid="globe-icon">Globe</span>,
	FileText: () => <span data-testid="file-text-icon">FileText</span>,
	Target: () => <span data-testid="target-icon">Target</span>,
}));

// Mock window.maestro for IPC calls (LocalImage, shell, etc.)
const mockMaestro = {
	fs: { readFile: vi.fn().mockResolvedValue(null) },
	shell: { openExternal: vi.fn(), openPath: vi.fn() },
	settings: { get: vi.fn(), set: vi.fn() },
	clipboard: { writeText: vi.fn() },
};
Object.defineProperty(window, 'maestro', { value: mockMaestro, writable: true });

// Mock fileExplorerStore for FileContextMenu's Document Graph action
vi.mock('../../../renderer/stores/fileExplorerStore', () => ({
	useFileExplorerStore: {
		getState: () => ({
			focusFileInGraph: vi.fn(),
		}),
	},
}));

const defaultProps = {
	content: '',
	theme: mockTheme,
	onCopy: vi.fn(),
};

// ============================================================================
// Helper to render markdown and return the container
// ============================================================================
function renderMd(content: string, props?: Partial<typeof defaultProps>) {
	return render(<MarkdownRenderer {...defaultProps} {...props} content={content} />);
}

// ============================================================================
// Tests
// ============================================================================

describe('MarkdownRenderer', () => {
	// ========================================================================
	// Basic inline formatting
	// ========================================================================
	describe('inline formatting', () => {
		it('renders plain text', () => {
			renderMd('Hello world');
			expect(screen.getByText('Hello world')).toBeInTheDocument();
		});

		it('renders bold with **', () => {
			const { container } = renderMd('This is **bold** text');
			expect(container.querySelector('strong')).toBeInTheDocument();
			expect(container.querySelector('strong')!.textContent).toBe('bold');
		});

		it('renders bold with __', () => {
			const { container } = renderMd('This is __bold__ text');
			expect(container.querySelector('strong')).toBeInTheDocument();
		});

		it('renders italic with *', () => {
			const { container } = renderMd('This is *italic* text');
			expect(container.querySelector('em')).toBeInTheDocument();
			expect(container.querySelector('em')!.textContent).toBe('italic');
		});

		it('renders italic with _', () => {
			const { container } = renderMd('This is _italic_ text');
			expect(container.querySelector('em')).toBeInTheDocument();
		});

		it('renders bold+italic with ***', () => {
			const { container } = renderMd('This is ***bold and italic*** text');
			// Should have both strong and em (nested in either order)
			const strong = container.querySelector('strong');
			const em = container.querySelector('em');
			expect(strong || em).toBeTruthy();
		});

		it('renders inline code with backticks', () => {
			const { container } = renderMd('Use `console.log()` to debug');
			const code = container.querySelector('code');
			expect(code).toBeInTheDocument();
			expect(code!.textContent).toBe('console.log()');
		});

		it('renders strikethrough (GFM)', () => {
			const { container } = renderMd('This is ~~deleted~~ text');
			const del = container.querySelector('del');
			expect(del).toBeInTheDocument();
			expect(del!.textContent).toBe('deleted');
		});
	});

	// ========================================================================
	// Headings
	// ========================================================================
	describe('headings', () => {
		it('renders h1 through h6', () => {
			const content = [
				'# Heading 1',
				'## Heading 2',
				'### Heading 3',
				'#### Heading 4',
				'##### Heading 5',
				'###### Heading 6',
			].join('\n\n');
			const { container } = renderMd(content);

			expect(container.querySelector('h1')).toBeInTheDocument();
			expect(container.querySelector('h2')).toBeInTheDocument();
			expect(container.querySelector('h3')).toBeInTheDocument();
			expect(container.querySelector('h4')).toBeInTheDocument();
			expect(container.querySelector('h5')).toBeInTheDocument();
			expect(container.querySelector('h6')).toBeInTheDocument();
		});

		it('renders heading with inline formatting', () => {
			const { container } = renderMd('## This is **bold** heading');
			const h2 = container.querySelector('h2');
			expect(h2).toBeInTheDocument();
			expect(h2!.querySelector('strong')).toBeInTheDocument();
		});

		it('renders heading with inline code', () => {
			const { container } = renderMd('### The `useState` hook');
			const h3 = container.querySelector('h3');
			expect(h3).toBeInTheDocument();
			expect(h3!.querySelector('code')).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Lists
	// ========================================================================
	describe('lists', () => {
		it('renders unordered list with -', () => {
			const content = '- Item one\n- Item two\n- Item three';
			const { container } = renderMd(content);
			const ul = container.querySelector('ul');
			expect(ul).toBeInTheDocument();
			const items = ul!.querySelectorAll('li');
			expect(items.length).toBe(3);
		});

		it('renders unordered list with *', () => {
			const content = '* Item one\n* Item two';
			const { container } = renderMd(content);
			expect(container.querySelector('ul')).toBeInTheDocument();
		});

		it('renders ordered list', () => {
			const content = '1. First\n2. Second\n3. Third';
			const { container } = renderMd(content);
			const ol = container.querySelector('ol');
			expect(ol).toBeInTheDocument();
			expect(ol!.querySelectorAll('li').length).toBe(3);
		});

		it('renders nested lists', () => {
			const content = '- Parent\n  - Child\n    - Grandchild\n- Sibling';
			const { container } = renderMd(content);
			const lists = container.querySelectorAll('ul');
			// Should have nested ul elements
			expect(lists.length).toBeGreaterThanOrEqual(2);
		});

		it('renders mixed ordered/unordered nested lists', () => {
			const content = '1. First\n   - Sub bullet\n   - Another\n2. Second';
			const { container } = renderMd(content);
			expect(container.querySelector('ol')).toBeInTheDocument();
			expect(container.querySelector('ul')).toBeInTheDocument();
		});

		it('renders task lists (GFM)', () => {
			const content = '- [ ] Unchecked task\n- [x] Checked task\n- [ ] Another unchecked';
			const { container } = renderMd(content);
			const checkboxes = container.querySelectorAll('input[type="checkbox"]');
			expect(checkboxes.length).toBe(3);
			// First should be unchecked, second checked
			expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
			expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
			expect((checkboxes[2] as HTMLInputElement).checked).toBe(false);
		});

		it('renders list items with inline formatting', () => {
			const content = '- **Bold item**\n- *Italic item*\n- `Code item`';
			const { container } = renderMd(content);
			const ul = container.querySelector('ul');
			expect(ul).toBeInTheDocument();
			expect(ul!.querySelector('strong')).toBeInTheDocument();
			expect(ul!.querySelector('em')).toBeInTheDocument();
			expect(ul!.querySelector('code')).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Code blocks
	// ========================================================================
	describe('code blocks', () => {
		it('renders fenced code block with language', () => {
			const content = '```typescript\nconst x: number = 42;\n```';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter).toBeInTheDocument();
			expect(highlighter!.getAttribute('data-language')).toBe('typescript');
			expect(highlighter!.textContent).toBe('const x: number = 42;');
		});

		it('renders fenced code block without language', () => {
			const content = '```\nsome code here\n```';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter).toBeInTheDocument();
			expect(highlighter!.getAttribute('data-language')).toBe('text');
		});

		it('renders multiple code blocks', () => {
			const content = [
				'```python',
				'def hello():',
				'    print("Hello")',
				'```',
				'',
				'Some text between',
				'',
				'```javascript',
				'console.log("world");',
				'```',
			].join('\n');
			const { container } = renderMd(content);
			const highlighters = container.querySelectorAll('[data-testid="syntax-highlighter"]');
			expect(highlighters.length).toBe(2);
		});

		it('renders code block with special characters', () => {
			const content = '```html\n<div class="foo">&amp; bar</div>\n```';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter).toBeInTheDocument();
		});

		it('renders code block with empty lines preserved', () => {
			const content = '```\nline 1\n\nline 3\n```';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter!.textContent).toContain('line 1');
			expect(highlighter!.textContent).toContain('line 3');
		});

		it('shows copy button on code blocks', () => {
			const content = '```\nsome code\n```';
			const { container } = renderMd(content);
			const copyBtn = container.querySelector('[title="Copy code"]');
			expect(copyBtn).toBeInTheDocument();
		});

		it('calls onCopy when copy button is clicked', () => {
			const onCopy = vi.fn();
			const content = '```\nmy code content\n```';
			const { container } = renderMd(content, { onCopy });
			const copyBtn = container.querySelector('[title="Copy code"]');
			fireEvent.click(copyBtn!);
			expect(onCopy).toHaveBeenCalledWith('my code content');
		});

		it('renders various language identifiers', () => {
			const languages = [
				'js',
				'ts',
				'py',
				'rust',
				'go',
				'bash',
				'sh',
				'json',
				'yaml',
				'sql',
				'css',
				'diff',
			];
			for (const lang of languages) {
				const { container, unmount } = renderMd(`\`\`\`${lang}\ncode\n\`\`\``);
				const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
				expect(highlighter).toBeInTheDocument();
				expect(highlighter!.getAttribute('data-language')).toBe(lang);
				unmount();
			}
		});
	});

	// ========================================================================
	// Links
	// ========================================================================
	describe('links', () => {
		// ---- Basic link syntax ----

		it('renders a standard markdown link', () => {
			const { container } = renderMd('[Click here](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toBe('Click here');
			expect(link!.getAttribute('href')).toBe('https://example.com');
		});

		it('renders autolinks (GFM)', () => {
			const { container } = renderMd('Visit https://example.com for more');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('https://example.com');
		});

		it('opens external links via shell.openExternal', () => {
			mockMaestro.shell.openExternal.mockClear();
			const { container } = renderMd('[Link](https://example.com)');
			const link = container.querySelector('a');
			fireEvent.click(link!);
			expect(mockMaestro.shell.openExternal).toHaveBeenCalledWith('https://example.com');
		});

		it('renders link with inline code in label', () => {
			const { container } = renderMd('[`package.json`](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.querySelector('code')).toBeInTheDocument();
		});

		// ---- Spaces in URL (CommonMark rejects bare spaces) ----

		it('handles spaces in file path URL', () => {
			const { container } = renderMd('[file](path/with spaces/file.ts)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toBe('file');
		});

		it('handles spaces in URL with multiple path segments', () => {
			const { container } = renderMd('[doc](my docs/sub folder/readme.md)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toBe('doc');
		});

		it('does not mangle URLs without spaces', () => {
			const { container } = renderMd('[file](https://example.com/no-spaces)');
			const link = container.querySelector('a');
			expect(link!.getAttribute('href')).toBe('https://example.com/no-spaces');
		});

		// ---- Brackets in label (Next.js dynamic routes, arrays, etc.) ----

		it('handles brackets in label: [id].tsx', () => {
			const { container } = renderMd('[src/[id].tsx](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('[id]');
		});

		it('handles brackets in label + spaces in URL', () => {
			const { container } = renderMd('[src/[id].tsx](path with/spaces)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('[id]');
		});

		it('handles Array[0] in label', () => {
			const { container } = renderMd('[Array[0]](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('Array[0]');
		});

		it('handles Array[0] in label + spaces in URL', () => {
			const { container } = renderMd('[Array[0]](path with spaces)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('Array[0]');
		});

		it('handles [[nested]] brackets in label', () => {
			const { container } = renderMd('[[[nested]]](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
		});

		it('handles Next.js catch-all [...slug] in label', () => {
			const { container } = renderMd('[pages/[...slug].tsx](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('[...slug]');
		});

		// ---- Parentheses in URL ----

		it('handles balanced parentheses in URL (Wikipedia-style)', () => {
			const { container } = renderMd('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
		});

		it('handles parentheses in URL + spaces', () => {
			const { container } = renderMd('[file](path (copy)/file.ts)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toBe('file');
		});

		it('handles nested parentheses in URL', () => {
			const { container } = renderMd('[ref](https://example.com/a(b(c)))');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
		});

		// ---- File path URLs (relative, absolute, anchors) ----

		it('handles relative file path URL', () => {
			const { container } = renderMd('[file](./src/file.ts)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('./src/file.ts');
		});

		it('handles absolute file path URL', () => {
			const { container } = renderMd('[file.ts](/Users/test/project/file.ts)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('/Users/test/project/file.ts');
		});

		it('handles anchor/hash link', () => {
			const { container } = renderMd('[section](#heading-name)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('#heading-name');
		});

		it('handles file path with hash anchor', () => {
			const { container } = renderMd('[section](file.md#heading)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('file.md#heading');
		});

		it('handles URL with query parameters', () => {
			const { container } = renderMd('[search](https://api.com/q?a=1&b=2)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toContain('?a=1');
		});

		// ---- Special label content ----

		it('handles bold text in label', () => {
			const { container } = renderMd('[**bold label**](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.querySelector('strong')).toBeInTheDocument();
		});

		it('handles pipe character in label', () => {
			const { container } = renderMd('[a | b](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('|');
		});

		it('handles empty label', () => {
			const { container } = renderMd('[](https://example.com)');
			const link = container.querySelector('a');
			// CommonMark may or may not render empty labels as links
			// Just ensure no crash
			expect(container.querySelector('.prose')).toBeInTheDocument();
		});

		it('handles label with colon (file:line pattern)', () => {
			const { container } = renderMd('[src/main.ts:42](https://example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toBe('src/main.ts:42');
		});

		// ---- Multiple links on same line ----

		it('handles multiple links with spaces on the same line', () => {
			const content = '[a](one two) and [b](three four)';
			const { container } = renderMd(content);
			const links = container.querySelectorAll('a');
			expect(links.length).toBe(2);
			expect(links[0].textContent).toBe('a');
			expect(links[1].textContent).toBe('b');
		});

		it('handles mix of space and no-space links on same line', () => {
			const content = '[a](has space) and [b](https://example.com)';
			const { container } = renderMd(content);
			const links = container.querySelectorAll('a');
			expect(links.length).toBe(2);
		});

		it('handles consecutive links without separator', () => {
			const { container } = renderMd('[a](url1)[b](url2)');
			const links = container.querySelectorAll('a');
			expect(links.length).toBe(2);
		});

		// ---- Git / special URL schemes ----

		it('handles git@ URL', () => {
			const { container } = renderMd('[repo](git@github.com:user/repo.git)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
		});

		it('handles mailto: URL', () => {
			const { container } = renderMd('[email](mailto:user@example.com)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
		});

		// ---- Combined edge cases ----

		it('handles brackets in label + parens in URL + spaces', () => {
			// The trifecta: all three problematic patterns at once
			const { container } = renderMd('[src/[id].tsx](path (copy)/file name.ts)');
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('[id]');
		});

		it('handles link inside list item with brackets and spaces', () => {
			const content = '- See [pages/[slug].tsx](my docs/file.ts) for details';
			const { container } = renderMd(content);
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.textContent).toContain('[slug]');
		});

		it('handles link inside bold with brackets and spaces', () => {
			const content = '**See [src/[id].tsx](path with spaces) for details**';
			const { container } = renderMd(content);
			const link = container.querySelector('a');
			expect(link).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Tables (GFM)
	// ========================================================================
	describe('tables', () => {
		it('renders a basic table', () => {
			const content = ['| Name | Age |', '| ---- | --- |', '| Alice | 30 |', '| Bob | 25 |'].join(
				'\n'
			);
			const { container } = renderMd(content);
			const table = container.querySelector('table');
			expect(table).toBeInTheDocument();
			const rows = table!.querySelectorAll('tr');
			// Header + 2 data rows
			expect(rows.length).toBe(3);
		});

		it('renders table headers', () => {
			const content = '| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |';
			const { container } = renderMd(content);
			const ths = container.querySelectorAll('th');
			expect(ths.length).toBe(2);
			expect(ths[0].textContent).toBe('Header 1');
			expect(ths[1].textContent).toBe('Header 2');
		});

		it('renders table with alignment', () => {
			const content = [
				'| Left | Center | Right |',
				'| :--- | :---: | ---: |',
				'| L | C | R |',
			].join('\n');
			const { container } = renderMd(content);
			const tds = container.querySelectorAll('td');
			expect(tds.length).toBe(3);
		});

		it('renders table with inline formatting in cells', () => {
			const content = [
				'| Feature | Status |',
				'| --- | --- |',
				'| **Bold** feature | `done` |',
				'| *Italic* feature | ~~removed~~ |',
			].join('\n');
			const { container } = renderMd(content);
			const table = container.querySelector('table');
			expect(table!.querySelector('strong')).toBeInTheDocument();
			expect(table!.querySelector('code')).toBeInTheDocument();
			expect(table!.querySelector('em')).toBeInTheDocument();
			expect(table!.querySelector('del')).toBeInTheDocument();
		});

		it('renders wide table with horizontal scroll wrapper', () => {
			const content = [
				'| Col1 | Col2 | Col3 | Col4 | Col5 | Col6 | Col7 | Col8 |',
				'| --- | --- | --- | --- | --- | --- | --- | --- |',
				'| a | b | c | d | e | f | g | h |',
			].join('\n');
			const { container } = renderMd(content);
			// Table should be wrapped in an overflow-x-auto div
			const wrapper = container.querySelector('.overflow-x-auto');
			expect(wrapper).toBeInTheDocument();
			expect(wrapper!.querySelector('table')).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Blockquotes
	// ========================================================================
	describe('blockquotes', () => {
		it('renders a blockquote', () => {
			const { container } = renderMd('> This is a quote');
			expect(container.querySelector('blockquote')).toBeInTheDocument();
		});

		it('renders nested blockquotes', () => {
			const content = '> Outer quote\n>\n> > Inner quote';
			const { container } = renderMd(content);
			const blockquotes = container.querySelectorAll('blockquote');
			expect(blockquotes.length).toBe(2);
		});

		it('renders blockquote with formatting', () => {
			const content = '> **Important:** This is `critical` information';
			const { container } = renderMd(content);
			const bq = container.querySelector('blockquote');
			expect(bq).toBeInTheDocument();
			expect(bq!.querySelector('strong')).toBeInTheDocument();
			expect(bq!.querySelector('code')).toBeInTheDocument();
		});

		it('renders multi-line blockquote', () => {
			const content = '> Line one\n> Line two\n> Line three';
			const { container } = renderMd(content);
			const bq = container.querySelector('blockquote');
			expect(bq).toBeInTheDocument();
			expect(bq!.textContent).toContain('Line one');
			expect(bq!.textContent).toContain('Line three');
		});
	});

	// ========================================================================
	// Horizontal rules
	// ========================================================================
	describe('horizontal rules', () => {
		it('renders --- as hr', () => {
			const { container } = renderMd('Before\n\n---\n\nAfter');
			expect(container.querySelector('hr')).toBeInTheDocument();
		});

		it('renders *** as hr', () => {
			const { container } = renderMd('Before\n\n***\n\nAfter');
			expect(container.querySelector('hr')).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Complex / real-world LLM output patterns
	// ========================================================================
	describe('real-world LLM output patterns', () => {
		it('renders a step-by-step explanation with code', () => {
			const content = [
				"Here's how to fix the issue:",
				'',
				'1. First, update the import:',
				'',
				'```typescript',
				'import { useState } from "react";',
				'```',
				'',
				'2. Then modify the component:',
				'',
				'```typescript',
				'const [count, setCount] = useState(0);',
				'```',
				'',
				'3. Finally, add the handler:',
				'',
				'```typescript',
				'const handleClick = () => setCount(c => c + 1);',
				'```',
			].join('\n');
			const { container } = renderMd(content);
			expect(container.querySelector('ol')).toBeInTheDocument();
			const highlighters = container.querySelectorAll('[data-testid="syntax-highlighter"]');
			expect(highlighters.length).toBe(3);
		});

		it('renders file path references with inline code', () => {
			const content = [
				'The changes are in these files:',
				'',
				'- `src/components/App.tsx` - Main component',
				'- `src/utils/helpers.ts` - Utility functions',
				'- `package.json` - Dependencies',
			].join('\n');
			const { container } = renderMd(content);
			const codeElements = container.querySelectorAll('code');
			expect(codeElements.length).toBe(3);
		});

		it('renders a summary with bold labels', () => {
			// Claude often outputs "**Key:** value" patterns
			const content = [
				'**Status:** Complete',
				'',
				'**Files changed:** 3',
				'',
				'**Tests:** All passing',
			].join('\n');
			const { container } = renderMd(content);
			const strongs = container.querySelectorAll('strong');
			expect(strongs.length).toBe(3);
		});

		it('renders mixed prose and code blocks without breaking', () => {
			const content = [
				"I've made the following changes:",
				'',
				'The function `processData` was updated to handle edge cases.',
				'',
				'```diff',
				'- const result = data.map(x => x * 2);',
				'+ const result = data?.map(x => x * 2) ?? [];',
				'```',
				'',
				"This ensures we don't crash when `data` is `undefined`.",
				'',
				'> **Note:** This is a breaking change if callers depend on the throw behavior.',
			].join('\n');
			const { container } = renderMd(content);
			expect(container.querySelector('[data-testid="syntax-highlighter"]')).toBeInTheDocument();
			expect(container.querySelector('blockquote')).toBeInTheDocument();
			// Multiple inline code elements
			const codes = container.querySelectorAll('code');
			expect(codes.length).toBeGreaterThanOrEqual(2);
		});

		it('renders a table followed by explanation', () => {
			const content = [
				'Here are the results:',
				'',
				'| Test | Result | Time |',
				'| --- | --- | --- |',
				'| Unit tests | Pass | 2.3s |',
				'| Integration | Pass | 15.1s |',
				'| E2E | Fail | 45.2s |',
				'',
				'The E2E failure is due to a timeout in the login flow.',
			].join('\n');
			const { container } = renderMd(content);
			expect(container.querySelector('table')).toBeInTheDocument();
			const rows = container.querySelectorAll('tr');
			expect(rows.length).toBe(4); // header + 3 data rows
		});

		it('renders a multi-section response with headers and lists', () => {
			const content = [
				'## Summary',
				'',
				'Fixed the authentication bug.',
				'',
				'## Changes',
				'',
				'- Updated token validation logic',
				'- Added retry mechanism',
				'- Fixed race condition in session refresh',
				'',
				'## Testing',
				'',
				'1. Run `npm test`',
				'2. Check the auth flow manually',
				'3. Verify token refresh works',
			].join('\n');
			const { container } = renderMd(content);
			const h2s = container.querySelectorAll('h2');
			expect(h2s.length).toBe(3);
			expect(container.querySelector('ul')).toBeInTheDocument();
			expect(container.querySelector('ol')).toBeInTheDocument();
		});

		it('renders deeply nested content', () => {
			const content = [
				'- Level 1',
				'  - Level 2',
				'    - Level 3 with **bold** and `code`',
				'      - Level 4',
			].join('\n');
			const { container } = renderMd(content);
			// Should render without errors
			expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(4);
		});

		it('renders a long code block with many lines', () => {
			const lines = Array.from({ length: 50 }, (_, i) => `  line ${i + 1}: doSomething(${i});`);
			const content = '```javascript\nfunction big() {\n' + lines.join('\n') + '\n}\n```';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter).toBeInTheDocument();
			expect(highlighter!.textContent).toContain('line 1');
			expect(highlighter!.textContent).toContain('line 50');
		});

		it('renders inline code inside list items inside blockquote', () => {
			const content = [
				'> Changes made:',
				'>',
				'> - Updated `config.ts`',
				'> - Fixed `index.html`',
			].join('\n');
			const { container } = renderMd(content);
			const bq = container.querySelector('blockquote');
			expect(bq).toBeInTheDocument();
			const codes = bq!.querySelectorAll('code');
			expect(codes.length).toBe(2);
		});

		it('renders file:line_number pattern from Claude output', () => {
			const content =
				'The issue is at `src/components/App.tsx:42` where the state is not being updated.';
			renderMd(content);
			expect(screen.getByText(/src\/components\/App\.tsx:42/)).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Edge cases / tricky markdown
	// ========================================================================
	describe('edge cases', () => {
		it('handles empty content', () => {
			const { container } = renderMd('');
			expect(container.querySelector('.prose')).toBeInTheDocument();
		});

		it('handles content with only whitespace', () => {
			const { container } = renderMd('   \n\n   ');
			expect(container.querySelector('.prose')).toBeInTheDocument();
		});

		it('handles consecutive code blocks with no gap', () => {
			const content = '```js\nfirst\n```\n```py\nsecond\n```';
			const { container } = renderMd(content);
			const highlighters = container.querySelectorAll('[data-testid="syntax-highlighter"]');
			expect(highlighters.length).toBe(2);
		});

		it('handles backtick-heavy inline code (double backticks)', () => {
			const { container } = renderMd('Use ``code with `backticks` inside`` here');
			const code = container.querySelector('code');
			expect(code).toBeInTheDocument();
			expect(code!.textContent).toContain('backticks');
		});

		it('renders escaped special characters', () => {
			const content = 'Use \\*asterisks\\* without emphasis and \\#not a heading';
			renderMd(content);
			// Should render literal * and # not as formatting
			expect(screen.getByText(/\*asterisks\*/)).toBeInTheDocument();
		});

		it('handles HTML entities in code blocks', () => {
			const content = '```\n<div>&amp;</div>\n```';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter).toBeInTheDocument();
		});

		it('handles really long unbroken strings', () => {
			const longWord = 'a'.repeat(500);
			const { container } = renderMd(`Here is a long word: ${longWord}`);
			expect(container.textContent).toContain(longWord);
		});

		it('handles mixed line endings (CRLF and LF)', () => {
			const content = '# Title\r\n\r\nParagraph\r\n\r\n- Item 1\r\n- Item 2';
			const { container } = renderMd(content);
			expect(container.querySelector('h1')).toBeInTheDocument();
			expect(container.querySelector('ul')).toBeInTheDocument();
		});

		it('handles unicode and emoji in content', () => {
			const content =
				'## 🚀 Release Notes\n\n- ✅ Fixed the bug\n- 🔧 Improved performance\n- 日本語テスト';
			const { container } = renderMd(content);
			expect(container.querySelector('h2')).toBeInTheDocument();
			expect(container.textContent).toContain('🚀');
			expect(container.textContent).toContain('✅');
			expect(container.textContent).toContain('日本語テスト');
		});

		it('handles code block immediately after heading', () => {
			const content = '### Example\n```ts\nconst x = 1;\n```';
			const { container } = renderMd(content);
			expect(container.querySelector('h3')).toBeInTheDocument();
			expect(container.querySelector('[data-testid="syntax-highlighter"]')).toBeInTheDocument();
		});

		it('handles paragraphs separated by single newline (should merge)', () => {
			// In CommonMark, single newline within a paragraph is a soft break
			const content = 'Line one\nLine two\nLine three';
			const { container } = renderMd(content);
			// Should be one paragraph, not three
			const paragraphs = container.querySelectorAll('p');
			expect(paragraphs.length).toBe(1);
		});

		it('handles paragraphs separated by double newline', () => {
			const content = 'Paragraph one\n\nParagraph two\n\nParagraph three';
			const { container } = renderMd(content);
			const paragraphs = container.querySelectorAll('p');
			expect(paragraphs.length).toBe(3);
		});

		it('handles content with YAML frontmatter', () => {
			const content = '---\ntitle: Test\ndate: 2026-01-01\n---\n\n# Hello World';
			const { container } = renderMd(content);
			// Frontmatter should not appear as raw text
			expect(container.textContent).not.toContain('title: Test');
			expect(container.querySelector('h1')).toBeInTheDocument();
		});
	});

	// ========================================================================
	// Raw HTML passthrough (allowRawHtml=true)
	// ========================================================================
	describe('raw HTML rendering', () => {
		it('renders <details> / <summary> blocks', () => {
			const content = [
				'<details>',
				'<summary>Click to expand</summary>',
				'',
				'Hidden content here with **bold** text.',
				'',
				'</details>',
			].join('\n');
			const { container } = renderMd(content, { allowRawHtml: true } as any);
			expect(container.querySelector('details')).toBeInTheDocument();
			expect(container.querySelector('summary')).toBeInTheDocument();
		});

		it('renders <kbd> tags for keyboard shortcuts', () => {
			const content = 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy';
			const { container } = renderMd(content, { allowRawHtml: true } as any);
			const kbds = container.querySelectorAll('kbd');
			expect(kbds.length).toBe(2);
		});

		it('renders <sup> and <sub> tags', () => {
			const content = 'H<sub>2</sub>O and x<sup>2</sup>';
			const { container } = renderMd(content, { allowRawHtml: true } as any);
			expect(container.querySelector('sub')).toBeInTheDocument();
			expect(container.querySelector('sup')).toBeInTheDocument();
		});

		it('renders <mark> tags for highlights', () => {
			const content = 'This is <mark>highlighted</mark> text';
			const { container } = renderMd(content, { allowRawHtml: true } as any);
			expect(container.querySelector('mark')).toBeInTheDocument();
		});
	});

	// ========================================================================
	// DOMPurify sanitization (allowRawHtml=true)
	// ========================================================================
	describe('DOMPurify sanitization with allowRawHtml', () => {
		it('strips script tags when allowRawHtml is true', () => {
			const maliciousContent = 'Hello <script>alert("xss")</script> world';
			const { container } = renderMd(maliciousContent, { allowRawHtml: true } as any);
			expect(container.innerHTML).not.toContain('<script>');
			expect(container.innerHTML).not.toContain('alert');
			expect(screen.getByText(/Hello/)).toBeInTheDocument();
			expect(screen.getByText(/world/)).toBeInTheDocument();
		});

		it('strips event handler attributes when allowRawHtml is true', () => {
			const maliciousContent = '<img src="x" onerror="alert(1)">';
			const { container } = renderMd(maliciousContent, { allowRawHtml: true } as any);
			expect(container.innerHTML).not.toContain('onerror');
			expect(container.innerHTML).not.toContain('alert');
		});

		it('strips iframe tags when allowRawHtml is true', () => {
			const maliciousContent = 'Text <iframe src="https://evil.com"></iframe> more text';
			const { container } = renderMd(maliciousContent, { allowRawHtml: true } as any);
			expect(container.innerHTML).not.toContain('<iframe');
			expect(screen.getByText(/Text/)).toBeInTheDocument();
		});

		it('preserves safe HTML when allowRawHtml is true', () => {
			const safeContent = '<strong>bold</strong> and <em>italic</em>';
			const { container } = renderMd(safeContent, { allowRawHtml: true } as any);
			expect(container.querySelector('strong')).toBeInTheDocument();
			expect(container.querySelector('em')).toBeInTheDocument();
		});

		it('does not apply DOMPurify when allowRawHtml is false (default)', () => {
			const content = 'Hello <b>bold</b> world';
			const { container } = renderMd(content, { allowRawHtml: false } as any);
			expect(container.innerHTML).not.toContain('<script>');
		});

		it('strips onload event handlers from body tags when allowRawHtml is true', () => {
			const maliciousContent = '<body onload="alert(1)"><p>Content</p></body>';
			const { container } = renderMd(maliciousContent, { allowRawHtml: true } as any);
			expect(container.innerHTML).not.toContain('onload');
		});

		it('strips javascript: URLs from anchor tags when allowRawHtml is true', () => {
			const maliciousContent = '<a href="javascript:alert(1)">click me</a>';
			const { container } = renderMd(maliciousContent, { allowRawHtml: true } as any);
			expect(container.innerHTML).not.toContain('javascript:');
		});

		it('strips style-based XSS when allowRawHtml is true', () => {
			const maliciousContent = '<div style="background:url(javascript:alert(1))">styled</div>';
			const { container } = renderMd(maliciousContent, { allowRawHtml: true } as any);
			expect(container.innerHTML).not.toContain('javascript:');
		});
	});

	// ========================================================================
	// Context menus
	// ========================================================================
	describe('file context menu', () => {
		it('renders file context menu on right-click of a file link', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content='<a href="#" data-maestro-file="report.csv">report.csv</a>'
					allowRawHtml={true}
					projectRoot="/Users/test/project"
					onFileClick={vi.fn()}
				/>
			);
			const link = container.querySelector('a[data-maestro-file]');
			expect(link).not.toBeNull();

			fireEvent.contextMenu(link!, { clientX: 150, clientY: 250 });

			expect(screen.getByText('Preview')).toBeInTheDocument();
			expect(screen.getByText('Copy Path')).toBeInTheDocument();
			expect(screen.getByText('Open in Default App')).toBeInTheDocument();
			expect(screen.queryByText('Copy Link')).toBeNull();
			expect(screen.queryByText('Open in Maestro Browser')).toBeNull();
			expect(screen.queryByText('Open in System Browser')).toBeNull();
		});

		it('shows Document Graph option for markdown file references', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content='<a href="#" data-maestro-file="README.md">README.md</a>'
					allowRawHtml={true}
					projectRoot="/Users/test/project"
				/>
			);
			const link = container.querySelector('a[data-maestro-file]');
			expect(link).not.toBeNull();
			fireEvent.contextMenu(link!, { clientX: 150, clientY: 250 });

			expect(screen.getByText('Document Graph')).toBeInTheDocument();
		});

		it('does not show Document Graph for non-markdown files', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content='<a href="#" data-maestro-file="data.csv">data.csv</a>'
					allowRawHtml={true}
					projectRoot="/Users/test/project"
				/>
			);
			const link = container.querySelector('a[data-maestro-file]');
			expect(link).not.toBeNull();
			fireEvent.contextMenu(link!, { clientX: 150, clientY: 250 });

			expect(screen.queryByText('Document Graph')).toBeNull();
			expect(screen.getByText('Copy Path')).toBeInTheDocument();
		});
	});

	describe('link context menu', () => {
		it('renders a context menu with Copy Link, Open in Maestro Browser, and Open in System Browser on right-click', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content="Visit [Example](https://example.com) for details"
				/>
			);
			const link = container.querySelector('a[href="https://example.com"]');
			expect(link).not.toBeNull();

			fireEvent.contextMenu(link!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Copy Link')).toBeInTheDocument();
			expect(screen.getByText('Open in Maestro Browser')).toBeInTheDocument();
			expect(screen.getByText('Open in System Browser')).toBeInTheDocument();
		});

		it('does not show context menu for links without href', () => {
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content="Just **bold** text, no links" />
			);

			fireEvent.contextMenu(container.firstElementChild!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Copy Link')).toBeNull();
		});
	});

	// ========================================================================
	// Pathological / adversarial LLM outputs
	// ========================================================================
	describe('adversarial and pathological outputs', () => {
		it('handles unclosed code fence gracefully', () => {
			const content = '```typescript\nconst x = 1;\n// oops, no closing fence';
			const { container } = renderMd(content);
			// Should still render something, not crash
			expect(container.querySelector('.prose')).toBeInTheDocument();
		});

		it('handles markdown with excessive blank lines', () => {
			const content = 'Start\n\n\n\n\n\n\n\n\n\nEnd';
			renderMd(content);
			expect(screen.getByText('Start')).toBeInTheDocument();
			expect(screen.getByText('End')).toBeInTheDocument();
		});

		it('handles interleaved HTML and markdown', () => {
			const content = [
				'# Title',
				'',
				'<div>',
				'',
				'**Bold inside div**',
				'',
				'</div>',
				'',
				'Regular paragraph',
			].join('\n');
			const { container } = renderMd(content, { allowRawHtml: true } as any);
			expect(container.querySelector('h1')).toBeInTheDocument();
			expect(container.textContent).toContain('Regular paragraph');
		});

		it('handles a list item that contains a code block', () => {
			const content = [
				'1. First step:',
				'',
				'   ```bash',
				'   npm install',
				'   ```',
				'',
				'2. Second step:',
				'',
				'   ```bash',
				'   npm start',
				'   ```',
			].join('\n');
			const { container } = renderMd(content);
			const ol = container.querySelector('ol');
			expect(ol).toBeInTheDocument();
			const highlighters = container.querySelectorAll('[data-testid="syntax-highlighter"]');
			expect(highlighters.length).toBe(2);
		});

		it('handles markdown table with pipe characters in cells', () => {
			const content = [
				'| Command | Description |',
				'| --- | --- |',
				'| `a \\| b` | Pipe in code |',
			].join('\n');
			const { container } = renderMd(content);
			expect(container.querySelector('table')).toBeInTheDocument();
		});

		it('handles rapidly alternating formatting', () => {
			const content = '**bold** *italic* **bold** *italic* `code` **bold** `code`';
			const { container } = renderMd(content);
			const strongs = container.querySelectorAll('strong');
			const ems = container.querySelectorAll('em');
			const codes = container.querySelectorAll('code');
			expect(strongs.length).toBe(3);
			expect(ems.length).toBe(2);
			expect(codes.length).toBe(2);
		});

		it('handles code block with triple backticks inside (nested fences)', () => {
			// Using 4 backticks to wrap content that contains 3 backticks
			const content = '````\n```\ninner code\n```\n````';
			const { container } = renderMd(content);
			const highlighter = container.querySelector('[data-testid="syntax-highlighter"]');
			expect(highlighter).toBeInTheDocument();
		});

		it('handles extremely long single-line content', () => {
			const longLine = 'word '.repeat(1000);
			const { container } = renderMd(longLine);
			expect(container.textContent!.length).toBeGreaterThan(4000);
		});

		it('handles content that looks like a table but is not', () => {
			// Missing the separator row
			const content = '| Not | A | Table |';
			const { container } = renderMd(content);
			// Without the separator row, this should not render as a table
			expect(container.querySelector('table')).toBeNull();
		});

		it('handles link within bold within list item', () => {
			const content = '- **See [the docs](https://example.com) for details**';
			const { container } = renderMd(content);
			const li = container.querySelector('li');
			expect(li).toBeInTheDocument();
			const strong = li!.querySelector('strong');
			expect(strong).toBeInTheDocument();
			const link = strong!.querySelector('a');
			expect(link).toBeInTheDocument();
			expect(link!.getAttribute('href')).toBe('https://example.com');
		});
	});
});
