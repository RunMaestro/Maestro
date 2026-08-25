/**
 * Auto Run markers are HTML comments, so the thing under test is that they stop
 * being invisible on document surfaces - and stay invisible on chat ones.
 *
 * These render through the real react-markdown pipeline rather than asserting
 * on the AST, because the failure mode being guarded against is "the plugin
 * transformed the node and react-markdown dropped it anyway".
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { remarkMaestroMarkers } from '../../../../renderer/components/Markdown/remarkMaestroMarkers';
import { createMarkdownComponents } from '../../../../renderer/utils/markdownConfig';
import { createChatMarkdownComponents } from '../../../../renderer/components/Markdown/chatComponents';
import { mockTheme } from '../../../helpers/mockTheme';

function renderDocument(content: string) {
	const components = createMarkdownComponents({ theme: mockTheme }) as Components;
	return render(
		<ReactMarkdown remarkPlugins={[remarkMaestroMarkers]} components={components}>
			{content}
		</ReactMarkdown>
	);
}

describe('marker pills on a document surface', () => {
	it('shows a live HITL gate as something that will pause the run', () => {
		renderDocument(
			[
				'<!-- MAESTRO:HITL reason="Add STRIPE_SECRET_KEY to .env" -->',
				'',
				'- [ ] Bill the customer',
			].join('\n')
		);
		const pill = screen.getByTestId('maestro-marker-hitl');
		expect(pill).toHaveAttribute('data-marker-status', 'live');
		expect(pill).toHaveTextContent('Pauses here');
		// The reason is the actionable half: it names what the human has to do.
		expect(pill).toHaveTextContent('Add STRIPE_SECRET_KEY to .env');
	});

	it('shows a satisfied gate differently from a live one', () => {
		// Same marker text, one character different in the task below it. If both
		// rendered identically the pill would be worthless.
		renderDocument(
			['<!-- MAESTRO:HITL reason="Add the key" -->', '', '- [x] Bill the customer'].join('\n')
		);
		const pill = screen.getByTestId('maestro-marker-hitl');
		expect(pill).toHaveAttribute('data-marker-status', 'spent');
		expect(pill).toHaveTextContent('Approved');
	});

	it('shows a halt marker, which is why a run refuses to start', () => {
		renderDocument(['- [x] Done', '', '<!-- maestro:halt: the build is broken -->'].join('\n'));
		const pill = screen.getByTestId('maestro-marker-halt');
		expect(pill).toHaveAttribute('data-marker-status', 'live');
		expect(pill).toHaveTextContent('Halted');
		expect(pill).toHaveTextContent('the build is broken');
	});

	it('shows a document-scoped model hint', () => {
		renderDocument(
			['<!-- MAESTRO:MODEL tier="high" effort="high" -->', '', '- [ ] Design'].join('\n')
		);
		const pill = screen.getByTestId('maestro-marker-model');
		expect(pill).toHaveTextContent('high model');
		expect(pill).toHaveTextContent('high effort');
	});

	it('shows an inline model hint beside its own task', () => {
		renderDocument('- [ ] Design the migration <!-- MAESTRO:MODEL tier="high" -->');
		const pill = screen.getByTestId('maestro-marker-model');
		expect(pill).toHaveAttribute('data-marker-status', 'live');
		// It must land inside the task's list item, not float off as its own block.
		expect(pill.closest('li')).not.toBeNull();
	});

	it('flags a misspelled attribute instead of rendering it as a real setting', () => {
		renderDocument('<!-- MAESTRO:MODEL tier="hgih" -->\n\n- [ ] Task');
		const pill = screen.getByTestId('maestro-marker-model');
		expect(pill).toHaveAttribute('data-marker-status', 'invalid');
		expect(pill).toHaveTextContent('Unknown setting');
		expect(pill).toHaveTextContent('tier="hgih"');
	});

	it('renders nothing for a marker inside a fenced code block', () => {
		// The docs and the help modal both show this syntax. Drawing a pill on an
		// example would state something false about the document.
		renderDocument(
			['```markdown', '<!-- MAESTRO:HITL reason="example" -->', '```', '', '- [ ] Real task'].join(
				'\n'
			)
		);
		expect(screen.queryByTestId('maestro-marker-hitl')).toBeNull();
	});

	it('leaves an ordinary HTML comment alone', () => {
		const { container } = renderDocument('<!-- just a note -->\n\n- [ ] Task');
		expect(container.querySelector('[data-maestro-marker]')).toBeNull();
	});

	it('leaves ordinary divs and spans untouched', () => {
		// The component override intercepts every div/span, so the pass-through
		// path is what keeps normal content rendering.
		const components = createMarkdownComponents({ theme: mockTheme }) as Components;
		const { container } = render(
			<ReactMarkdown remarkPlugins={[remarkMaestroMarkers]} components={components}>
				{'Plain paragraph text.'}
			</ReactMarkdown>
		);
		expect(container.textContent).toContain('Plain paragraph text.');
	});
});

describe('marker pills are a document affordance', () => {
	it('does not render pills on the chat surface', () => {
		// An agent explaining the syntax in a message is describing a marker, not
		// configuring one. A pill there would assert a setting that does not exist.
		const components = createChatMarkdownComponents({
			theme: mockTheme,
			onCopy: () => {},
		}) as Components;
		const { container } = render(
			<ReactMarkdown components={components}>
				{'You can write <!-- MAESTRO:HITL reason="x" --> to pause a run.'}
			</ReactMarkdown>
		);
		expect(container.querySelector('[data-maestro-marker]')).toBeNull();
	});
});
