/**
 * A review comment is a claim about a specific place in the user's code, so the
 * cases here are the ones where the card could lose the place or misstate the
 * severity: the line range has to be shown and reachable, the body has to
 * survive characters the grammar escapes, and a priority nobody recognizes must
 * not be painted as a P0.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	CodeCommentCard,
	codeCommentLocationLabel,
} from '../../../../renderer/components/Markdown/components/CodeCommentCard';
import { createMarkdownLink } from '../../../../renderer/components/Markdown/components/MarkdownLink';
import { mockTheme } from '../../../helpers/mockTheme';

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
