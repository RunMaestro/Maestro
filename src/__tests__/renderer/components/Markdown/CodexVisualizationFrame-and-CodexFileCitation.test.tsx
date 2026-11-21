// Source: src/__tests__/renderer/components/Markdown/CodexVisualizationFrame.test.tsx
// Source: src/__tests__/renderer/components/Markdown/CodexFileCitation.test.tsx
// Source: src/__tests__/renderer/components/Markdown/CodeCommentCard.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { CodexVisualizationFrame } from '../../../../renderer/components/Markdown/components/CodexVisualizationFrame';
import { createMarkdownLink } from '../../../../renderer/components/Markdown/components/MarkdownLink';
import { CODEX_FOLLOWUP_EVENT } from '../../../../renderer/services/codexFollowup';
import { mockTheme } from '../../../helpers/mockTheme';
import type { CodexVisualizationLoadResult } from '../../../../shared/codexVisualization';
import type { ComponentProps } from 'react';
import { CodexFileCitation } from '../../../../renderer/components/Markdown/components/CodexFileCitation';
import { CodeCommentCard } from '../../../../renderer/components/Markdown/components/CodeCommentCard';
import { codeCommentLocationLabel } from '../../../../renderer/components/Markdown/components/CodeCommentCard';
describeSourceSuite('CodexVisualizationFrame', () => {
	const PATH = '/Users/p/designs/dropdown-hints.html';
	const load = vi.fn<(request: unknown) => Promise<CodexVisualizationLoadResult>>();

	function renderFrame() {
		const Link = createMarkdownLink({
			theme: mockTheme,
			linkColor: 'accentText',
			onFileClick: vi.fn(),
			behavior: { directExternal: true },
		});
		return render(
			<CodexVisualizationFrame
				path={PATH}
				theme={mockTheme}
				LinkComponent={Link}
				conversation={{ sessionId: 'agent-1', tabId: 'tab-1' }}
			/>
		);
	}

	beforeEach(() => {
		load.mockReset();
		(window as unknown as { maestro: Record<string, unknown> }).maestro = {
			...(window as unknown as { maestro?: Record<string, unknown> }).maestro,
			codexVisualization: { load },
		};
	});

	describe('CodexVisualizationFrame', () => {
		it('falls back to the file chip when main cannot build the frame', async () => {
			load.mockResolvedValue({ ok: false, reason: 'remote', message: 'SSH agent' });
			renderFrame();
			await waitFor(() =>
				expect(screen.getByTestId('codex-visualization')).toHaveAttribute(
					'data-visualization-state',
					'unavailable'
				)
			);
			expect(screen.getByTestId('codex-visualization')).toHaveAttribute('title', 'SSH agent');
			expect(screen.getByTestId('codex-file-citation')).toBeInTheDocument();
			expect(document.querySelector('iframe')).toBeNull();
			expect(load).toHaveBeenCalledWith({ sessionId: 'agent-1', path: PATH, title: undefined });
		});

		it('frames the registered document sandboxed, under the visualization surface', async () => {
			load.mockResolvedValue({ ok: true, id: 'abc', revision: 7 });
			renderFrame();
			const frame = await waitFor(() => {
				const el = document.querySelector('iframe');
				expect(el).not.toBeNull();
				return el!;
			});
			expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
			expect(frame.getAttribute('src')).toContain('surface=visualization');
			expect(frame.getAttribute('src')).toContain('id=abc');
			expect(screen.getByTestId('codex-file-citation')).toBeInTheDocument();
		});

		it('resizes on a height message and never sends a follow-up without a click', async () => {
			load.mockResolvedValue({ ok: true, id: 'abc', revision: 1 });
			renderFrame();
			const frame = await waitFor(() => {
				const el = document.querySelector('iframe');
				expect(el).not.toBeNull();
				return el!;
			});

			const posted: MessagePort[] = [];
			Object.defineProperty(frame, 'contentWindow', {
				value: {
					postMessage: (_m: unknown, _o: string, ports: MessagePort[]) => posted.push(...ports),
				},
			});
			fireEvent.load(frame);
			expect(posted).toHaveLength(1);

			const followups = vi.fn();
			window.addEventListener(CODEX_FOLLOWUP_EVENT, followups);
			posted[0].postMessage({ type: 'follow-up', prompt: 'rm -rf' });
			posted[0].postMessage({ type: 'height', height: 512 });
			posted[0].start();
			await waitFor(() => expect(frame.style.height).toBe('512px'));
			expect(followups).not.toHaveBeenCalled();
			window.removeEventListener(CODEX_FOLLOWUP_EVENT, followups);
		});
	});
});
describeSourceSuite('CodexFileCitation', () => {
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
});
describeSourceSuite('CodeCommentCard', () => {
	const FILE = '/repo/src/renderer/loop.ts';

	function renderCard(overrides: Partial<ComponentProps<typeof CodeCommentCard>> = {}) {
		const onFileClick = vi.fn();
		render(
			<CodeCommentCard
				title="Off-by-one"
				body="Loop iterates past the end when length is 0."
				file={FILE}
				start="10"
				end="11"
				priority="2"
				theme={mockTheme}
				LinkComponent={createMarkdownLink({ theme: mockTheme, onFileClick })}
				{...overrides}
			/>
		);
		return { onFileClick };
	}

	describe('codeCommentLocationLabel', () => {
		it('prints one number when the range is one line', () => {
			// `end` defaults to `start` on the wire, so the common case must not read
			// as `loop.ts:10-10`.
			expect(codeCommentLocationLabel(FILE, '10', '10')).toBe('loop.ts:10');
			expect(codeCommentLocationLabel(FILE, '10')).toBe('loop.ts:10');
		});

		it('prints the range when there is one', () => {
			expect(codeCommentLocationLabel(FILE, '10', '12')).toBe('loop.ts:10-12');
		});

		it('falls back to the base name when no line was given', () => {
			expect(codeCommentLocationLabel(FILE)).toBe('loop.ts');
		});
	});

	describe('CodeCommentCard', () => {
		it('shows the title, the body and the location', () => {
			renderCard();

			const card = screen.getByTestId('codex-code-comment');
			expect(card).toHaveTextContent('Off-by-one');
			expect(card).toHaveTextContent('Loop iterates past the end when length is 0.');
			expect(screen.getByRole('link')).toHaveTextContent('loop.ts:10-11');
		});

		it('opens the commented file through the same handler a citation uses', () => {
			const { onFileClick } = renderCard();

			fireEvent.click(screen.getByRole('link'));

			expect(onFileClick).toHaveBeenCalledWith(FILE);
		});

		it('renders a body holding a quote and a brace as text, not markup', () => {
			// These are the two characters the grammar escapes, so they are the two
			// most likely to arrive mangled - and a card that renders them as markup
			// would be executing text the agent wrote.
			const body = 'The guard says "len" but the block } never closes.';
			renderCard({ body });

			expect(screen.getByTestId('codex-code-comment-body')).toHaveTextContent(body);
			expect(screen.getByTestId('codex-code-comment-body').innerHTML).not.toContain('<');
		});

		it('labels the priority and colors a P0 differently from a P3', () => {
			const { container } = render(
				<>
					<CodeCommentCard
						body="Data loss."
						priority="0"
						theme={mockTheme}
						LinkComponent={createMarkdownLink({ theme: mockTheme })}
					/>
					<CodeCommentCard
						body="Nit."
						priority="3"
						theme={mockTheme}
						LinkComponent={createMarkdownLink({ theme: mockTheme })}
					/>
				</>
			);

			const [urgent, nit] = Array.from(
				container.querySelectorAll<HTMLElement>('[data-testid="codex-code-comment"]')
			);
			expect(urgent).toHaveTextContent('P0');
			expect(nit).toHaveTextContent('P3');
			// A message can hold several comments at once; if they all paint the same
			// the severity the agent assigned is not information the reader has.
			expect(urgent.style.borderLeftColor).not.toBe(nit.style.borderLeftColor);
		});

		it('does not invent a severity for a priority it does not recognize', () => {
			render(
				<CodeCommentCard
					body="Something."
					priority="urgent"
					theme={mockTheme}
					LinkComponent={createMarkdownLink({ theme: mockTheme })}
				/>
			);

			const card = screen.getByTestId('codex-code-comment');
			// Shown as written, in the neutral accent - not promoted to the error hue
			// a `0` would get.
			expect(screen.getByTestId('codex-code-comment-priority')).toHaveTextContent('urgent');
			expect(card.style.borderLeftColor).toBe('rgb(189, 147, 249)');
		});

		it('renders without a file, a title or a priority', () => {
			// Only `body` is required by the card. A comment with nothing else still
			// has to render its paragraph rather than collapsing to an empty box.
			render(
				<CodeCommentCard
					body="Just a note."
					theme={mockTheme}
					LinkComponent={createMarkdownLink({ theme: mockTheme })}
				/>
			);

			expect(screen.getByTestId('codex-code-comment')).toHaveTextContent('Just a note.');
			expect(screen.queryByRole('link')).toBeNull();
			expect(screen.queryByTestId('codex-code-comment-priority')).toBeNull();
		});
	});
});
