/**
 * A citation is a claim about the user's files, so the cases here are the ones
 * where the chip could misstate that claim or lose the path behind it: the full
 * path has to stay reachable, a click has to reach the surface's own file
 * handler rather than a second one, and an output must not be drawn as a source
 * (or the reverse) when the wire says something unexpected.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodexFileCitation } from '../../../../renderer/components/Markdown/components/CodexFileCitation';
import { createMarkdownLink } from '../../../../renderer/components/Markdown/components/MarkdownLink';
import { mockTheme } from '../../../helpers/mockTheme';

const PATH = '/Users/pedram/Projects/Maestro/src/renderer/components/Markdown/Markdown.tsx';

function renderCitation(overrides: Partial<ComponentProps<typeof CodexFileCitation>> = {}) {
	const onFileClick = vi.fn();
	const Link = createMarkdownLink({
		theme: mockTheme,
		linkColor: 'accentText',
		onFileClick,
		behavior: { directExternal: true },
	});
	render(
		<CodexFileCitation
			path={PATH}
			purpose="source"
			theme={mockTheme}
			LinkComponent={Link}
			{...overrides}
		/>
	);
	return { onFileClick };
}

describe('CodexFileCitation', () => {
	it('shows the base name and keeps the full path on hover', () => {
		renderCitation();

		const link = screen.getByRole('link');
		expect(link).toHaveTextContent('Markdown.tsx');
		// The directory is sixty characters of noise mid-sentence, but it is also
		// the only thing that identifies the file - so it moves to the title.
		expect(link.textContent).not.toContain('/Users/pedram');
		expect(link.getAttribute('title')).toContain(PATH);
	});

	it('opens the cited file through the surface own file handler', () => {
		const { onFileClick } = renderCitation();

		fireEvent.click(screen.getByRole('link'));

		expect(onFileClick).toHaveBeenCalledWith(PATH);
	});

	it('draws an output differently from a source, and says which on hover', () => {
		const { container } = render(
			<>
				<CodexFileCitation
					path={PATH}
					purpose="source"
					theme={mockTheme}
					LinkComponent={createMarkdownLink({ theme: mockTheme })}
				/>
				<CodexFileCitation
					path="/repo/out/report.md"
					purpose="output"
					theme={mockTheme}
					LinkComponent={createMarkdownLink({ theme: mockTheme })}
				/>
			</>
		);

		const [source, output] = Array.from(
			container.querySelectorAll<HTMLElement>('[data-testid="codex-file-citation"]')
		);
		expect(source).toHaveAttribute('data-citation-purpose', 'source');
		expect(output).toHaveAttribute('data-citation-purpose', 'output');
		// A file the agent CHANGED is the one a reader may have to act on, so the
		// two are not allowed to paint the same chip.
		expect(output.style.backgroundColor).not.toBe(source.style.backgroundColor);

		expect(source.querySelector('a')?.getAttribute('title')).toContain('Read by the agent');
		expect(output.querySelector('a')?.getAttribute('title')).toContain('Written by the agent');
	});

	it('shows a page number beside the link without putting it in the link text', () => {
		renderCitation({ path: '/repo/docs/spec.pdf', pageNumber: '12' });

		expect(screen.getByTestId('codex-file-citation')).toHaveTextContent('p. 12');
		expect(screen.getByRole('link')).toHaveTextContent('spec.pdf');
		expect(screen.getByRole('link').textContent).not.toContain('12');
	});

	it('carries the path and the provenance in the accessible name', () => {
		// The hover title is mouse-only. A keyboard or screen-reader user reads
		// what the agent did to this file here or not at all.
		renderCitation({ purpose: 'output', pageNumber: '3' });

		const name = screen.getByRole('link').getAttribute('aria-label') ?? '';
		expect(name).toContain('Written by the agent');
		expect(name).toContain(PATH);
		expect(name).toContain('page 3');
	});

	it('names the artifact kind on hover when the directive carried one', () => {
		renderCitation({ artifactKind: 'report' });

		expect(screen.getByRole('link').getAttribute('title')).toContain('Kind: report');
	});
});
