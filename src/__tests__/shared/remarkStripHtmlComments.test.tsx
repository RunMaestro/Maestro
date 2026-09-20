/**
 * An HTML comment is the one piece of markdown a reader is never supposed to
 * see, and react-markdown v9 shows it anyway: without `rehype-raw` in the
 * chain, every raw HTML node becomes a plain text node. That made ordinary
 * bookkeeping comments (`<!-- reminders:edit-boundary -->`) render as body copy
 * in the Auto Run panel, the wizard's document editor, and mobile chat.
 *
 * These render through the real react-markdown pipeline rather than asserting
 * on the AST, because the failure being guarded against lives in react-markdown
 * itself, not in the plugin.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { remarkStripHtmlComments } from '../../shared/remarkStripHtmlComments';
import { REMARK_GFM_PLUGINS } from '../../shared/markdownPlugins';
import { remarkMaestroMarkers } from '../../renderer/components/Markdown/remarkMaestroMarkers';
import { createMarkdownComponents } from '../../renderer/utils/markdownConfig';
import { mockTheme } from '../helpers/mockTheme';

function renderMarkdown(content: string, plugins: unknown[] = [remarkStripHtmlComments]) {
	const components = createMarkdownComponents({ theme: mockTheme }) as Components;
	return render(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		<ReactMarkdown remarkPlugins={plugins as any} components={components}>
			{content}
		</ReactMarkdown>
	);
}

describe('remarkStripHtmlComments', () => {
	it('hides a standalone comment that react-markdown would otherwise print', () => {
		const { container } = renderMarkdown('# Reports\n\n<!-- reminders:edit-boundary -->\n');
		expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
		expect(container.textContent).not.toContain('reminders:edit-boundary');
		expect(container.textContent).not.toContain('<!--');
	});

	it('hides a comment sitting inside a paragraph', () => {
		const { container } = renderMarkdown('Body text with <!-- inline note --> trailing.\n');
		expect(container.textContent).toContain('Body text with');
		expect(container.textContent).toContain('trailing.');
		expect(container.textContent).not.toContain('inline note');
	});

	it('is not fooled by a double hyphen inside the comment', () => {
		// The reported symptom blamed `--` in the comment body. It was never that,
		// and a fix that only handled simple comments would leave this one visible.
		const { container } = renderMarkdown(
			'<!-- reminders:edit-boundary --reminders -->\n\nAfter.\n'
		);
		expect(container.textContent).toContain('After.');
		expect(container.textContent).not.toContain('reminders');
	});

	it('hides a multi-line comment', () => {
		const { container } = renderMarkdown(
			'<!--\nnotes for the author\nsecond line\n-->\n\nAfter.\n'
		);
		expect(container.textContent).toContain('After.');
		expect(container.textContent).not.toContain('notes for the author');
	});

	it('leaves non-comment raw HTML rendering exactly as it did before', () => {
		// A surface with raw HTML off shows `<div>` as literal text. That is honest
		// about content the author wrote; silently deleting it would not be.
		const { container } = renderMarkdown('Text\n\n<div>keep me</div>\n');
		expect(container.textContent).toContain('<div>keep me</div>');
	});

	it('leaves an unterminated comment alone', () => {
		const { container } = renderMarkdown('Text\n\n<!-- never closed\n');
		expect(container.textContent).toContain('<!-- never closed');
	});

	it('leaves a comment inside a fence alone', () => {
		// A fence is a `code` node, never an `html` one, so documentation examples
		// of marker syntax keep rendering as the examples they are.
		const { container } = renderMarkdown('```\n<!-- MAESTRO:HITL -->\n```\n');
		expect(container.textContent).toContain('<!-- MAESTRO:HITL -->');
	});

	it('runs after remarkMaestroMarkers, so marker pills survive and the rest do not', () => {
		const { container } = renderMarkdown(
			[
				'<!-- reminders:edit-boundary -->',
				'',
				'<!-- MAESTRO:HITL reason="Add STRIPE_SECRET_KEY to .env" -->',
				'',
				'- [ ] Bill the customer',
			].join('\n'),
			[...REMARK_GFM_PLUGINS, remarkMaestroMarkers, remarkStripHtmlComments]
		);
		const pill = screen.getByTestId('maestro-marker-hitl');
		expect(pill).toHaveTextContent('Pauses here');
		expect(container.textContent).not.toContain('reminders:edit-boundary');
	});
});
