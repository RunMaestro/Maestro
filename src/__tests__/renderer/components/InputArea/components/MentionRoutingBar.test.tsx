import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MentionRoutingBar } from '../../../../../renderer/components/InputArea/components/MentionRoutingBar';
import { inputAreaTheme } from '../_fixtures';

describe('MentionRoutingBar', () => {
	it('says a hand-off runs AFTER this agent answers', () => {
		render(<MentionRoutingBar theme={inputAreaTheme} routing="handoff" agentNames={['Kensho']} />);

		expect(screen.getByTestId('mention-routing-bar')).toHaveAttribute('data-routing', 'handoff');
		expect(screen.getByText('Hand-off')).toBeInTheDocument();
		expect(
			screen.getByText('This agent answers, then its answer goes to @Kensho')
		).toBeInTheDocument();
	});

	it('says a consult-first mention answers before this agent starts', () => {
		render(
			<MentionRoutingBar
				theme={inputAreaTheme}
				routing="consult-first"
				agentNames={['Backend', 'API']}
			/>
		);

		expect(
			screen.getByText('@Backend and @API answer first; this agent starts once the reply is in')
		).toBeInTheDocument();
	});

	it('says a leading mention leaves this agent out', () => {
		render(<MentionRoutingBar theme={inputAreaTheme} routing="only" agentNames={['Backend']} />);

		expect(screen.getByText('@Backend answers; this agent does not')).toBeInTheDocument();
	});

	it('"reword to change" opens the phrasings for every mode, marking the current one', () => {
		render(
			<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
		);

		fireEvent.click(screen.getByText('reword to change'));

		const hint = screen.getByTestId('mention-routing-hint');
		expect(within(hint).getByText('Check with @agent first, then fix it')).toBeInTheDocument();
		expect(
			within(hint).getByText('Fix the bug, then send what you find to @agent')
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId('mention-routing-hint-parallel')).getByText('now')
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId('mention-routing-hint-handoff')).queryByText('now')
		).not.toBeInTheDocument();
	});

	it('closes the hint on Escape without letting the key reach the composer', () => {
		const composerKeyDown = vi.fn();
		document.addEventListener('keydown', composerKeyDown);
		render(
			<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
		);

		fireEvent.click(screen.getByText('reword to change'));
		fireEvent.keyDown(screen.getByTestId('mention-routing-hint'), { key: 'Escape' });

		expect(screen.queryByTestId('mention-routing-hint')).not.toBeInTheDocument();
		expect(composerKeyDown).not.toHaveBeenCalled();
		document.removeEventListener('keydown', composerKeyDown);
	});

	it('shows a plain label, not a menu, when the routing cannot be changed', () => {
		render(
			<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
		);

		expect(screen.queryByTestId('mention-routing-mode-button')).not.toBeInTheDocument();
	});

	it('the mode menu picks a routing for this message', () => {
		const onRoutingChange = vi.fn();
		render(
			<MentionRoutingBar
				theme={inputAreaTheme}
				routing="parallel"
				agentNames={['Backend']}
				onRoutingChange={onRoutingChange}
			/>
		);

		fireEvent.click(screen.getByTestId('mention-routing-mode-button'));
		// Auto names what the wording says, and is the selected row while nothing is picked.
		const auto = screen.getByTestId('mention-routing-option-auto');
		expect(auto).toHaveTextContent('Auto: Parallel');
		expect(auto).toHaveAttribute('aria-checked', 'true');

		fireEvent.click(screen.getByTestId('mention-routing-option-consult-first'));

		expect(onRoutingChange).toHaveBeenCalledWith('consult-first');
		expect(screen.queryByTestId('mention-routing-menu')).not.toBeInTheDocument();
	});

	it('marks a picked routing and lets Auto hand control back to the wording', () => {
		const onRoutingChange = vi.fn();
		render(
			<MentionRoutingBar
				theme={inputAreaTheme}
				routing="handoff"
				inferredRouting="parallel"
				explicit
				agentNames={['Backend']}
				onRoutingChange={onRoutingChange}
			/>
		);

		expect(screen.getByTestId('mention-routing-explicit-badge')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('mention-routing-mode-button'));
		expect(screen.getByTestId('mention-routing-option-handoff')).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(screen.getByTestId('mention-routing-option-auto')).toHaveAttribute(
			'aria-checked',
			'false'
		);

		fireEvent.click(screen.getByTestId('mention-routing-option-auto'));

		expect(onRoutingChange).toHaveBeenCalledWith(null);
	});
});
