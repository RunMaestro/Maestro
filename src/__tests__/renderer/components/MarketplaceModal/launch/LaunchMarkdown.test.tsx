/**
 * Tests for LaunchMarkdown: the block of author markdown the launch dialog and the outro draw. The
 * renderer behind it pulls in the whole remark stack and has its own suite, so a stand-in records
 * how the block calls it.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../../../renderer/components/Markdown', () => ({
	Markdown: ({
		content,
		preset,
		frontmatter,
	}: {
		content: string;
		preset: string;
		frontmatter?: boolean;
	}) => (
		<div data-testid="markdown" data-preset={preset} data-frontmatter={String(frontmatter)}>
			{content}
		</div>
	),
}));

import { LaunchMarkdown } from '../../../../../renderer/components/MarketplaceModal/launch/LaunchMarkdown';
import { mockTheme } from '../../../../helpers/mockTheme';

describe('LaunchMarkdown', () => {
	it('draws the markdown with the document preset the Exchange previews use, with no front matter', () => {
		render(<LaunchMarkdown theme={mockTheme} content={'**Done.** See `INDEX.md`.'} />);

		const markdown = screen.getByTestId('markdown');
		expect(markdown).toHaveTextContent('**Done.** See `INDEX.md`.');
		expect(markdown).toHaveAttribute('data-preset', 'document');
		expect(markdown).toHaveAttribute('data-frontmatter', 'false');
	});

	it('is named for tests with a default, or with the id the caller gives it', () => {
		const { rerender } = render(<LaunchMarkdown theme={mockTheme} content="a" />);
		expect(screen.getByTestId('launch-markdown')).toBeInTheDocument();

		rerender(<LaunchMarkdown theme={mockTheme} content="a" testId="outro-summary" />);

		expect(screen.queryByTestId('launch-markdown')).not.toBeInTheDocument();
		expect(screen.getByTestId('outro-summary')).toBeInTheDocument();
	});

	it('can be selected and copied, even inside a click-driven dialog', () => {
		render(<LaunchMarkdown theme={mockTheme} content="a" />);

		expect(screen.getByTestId('launch-markdown')).toHaveClass('select-text');
	});

	it('scopes its prose styles to itself, so two blocks on one screen do not restyle each other', () => {
		const { container } = render(<LaunchMarkdown theme={mockTheme} content="a" />);

		const styles = container.querySelector('style')?.textContent ?? '';
		expect(styles).toContain('.launch-markdown');
	});

	it('draws two blocks side by side, each with its own text', () => {
		render(
			<>
				<LaunchMarkdown theme={mockTheme} content="first" testId="one" />
				<LaunchMarkdown theme={mockTheme} content="second" testId="two" />
			</>
		);

		expect(screen.getByTestId('one')).toHaveTextContent('first');
		expect(screen.getByTestId('two')).toHaveTextContent('second');
	});
});
