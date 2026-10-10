import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

	it('tells the user how to change the routing: reword the message', () => {
		render(
			<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
		);

		const hint = screen.getByText('reword to change');
		expect(hint.getAttribute('title')).toMatch(/first/);
		expect(hint.getAttribute('title')).toMatch(/then send what you find/);
	});

	it('says a leading mention leaves this agent out', () => {
		render(<MentionRoutingBar theme={inputAreaTheme} routing="only" agentNames={['Backend']} />);

		expect(screen.getByText('@Backend answers; this agent does not')).toBeInTheDocument();
	});
});
