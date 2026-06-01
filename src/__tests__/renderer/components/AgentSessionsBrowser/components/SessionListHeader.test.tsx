import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionListHeader } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionListHeader';

const theme = {
	colors: {
		textDim: '#888',
		textMain: '#fff',
		accent: '#7C3AED',
		accentForeground: '#000',
	},
} as any;

describe('SessionListHeader', () => {
	it('shows "Claude Sessions for..." for claude-code agent', () => {
		render(
			<SessionListHeader
				agentId="claude-code"
				sessionName="MyProject"
				activeAgentSessionId={null}
				theme={theme}
				onNewSession={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByText(/Claude Sessions for/)).toBeTruthy();
	});

	it('shows "Agent Sessions for..." for non-claude agent', () => {
		render(
			<SessionListHeader
				agentId="codex"
				sessionName="MyProject"
				activeAgentSessionId={null}
				theme={theme}
				onNewSession={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByText(/Agent Sessions for/)).toBeTruthy();
	});

	it('renders active badge with first 8 chars + ellipsis', () => {
		render(
			<SessionListHeader
				agentId="claude-code"
				sessionName="MyProject"
				activeAgentSessionId="abcdef1234567890"
				theme={theme}
				onNewSession={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByText('Active: abcdef12...')).toBeTruthy();
	});

	it('renders no active badge when activeAgentSessionId is null', () => {
		render(
			<SessionListHeader
				agentId="claude-code"
				sessionName="MyProject"
				activeAgentSessionId={null}
				theme={theme}
				onNewSession={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.queryByText(/Active:/)).toBeNull();
	});

	it('renders no active badge when activeAgentSessionId is empty string', () => {
		render(
			<SessionListHeader
				agentId="claude-code"
				sessionName="MyProject"
				activeAgentSessionId=""
				theme={theme}
				onNewSession={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.queryByText(/Active:/)).toBeNull();
	});

	it('calls onNewSession when New Session button is clicked', () => {
		const onNewSession = vi.fn();
		render(
			<SessionListHeader
				agentId="claude-code"
				sessionName="MyProject"
				activeAgentSessionId={null}
				theme={theme}
				onNewSession={onNewSession}
				onClose={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByText('New Session'));
		expect(onNewSession).toHaveBeenCalled();
	});

	it('calls onClose when X button is clicked', () => {
		const onClose = vi.fn();
		render(
			<SessionListHeader
				agentId="claude-code"
				sessionName="MyProject"
				activeAgentSessionId={null}
				theme={theme}
				onNewSession={vi.fn()}
				onClose={onClose}
			/>
		);
		// The X button is the one that doesn't say "New Session"
		const buttons = screen.getAllByRole('button');
		const closeBtn = buttons.find((b) => !b.textContent?.includes('New Session'))!;
		fireEvent.click(closeBtn);
		expect(onClose).toHaveBeenCalled();
	});
});
