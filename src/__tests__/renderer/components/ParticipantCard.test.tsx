import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ParticipantCard } from '../../../renderer/components/ParticipantCard';
import type { GroupChatParticipant } from '../../../shared/group-chat-types';
import { mockTheme } from '../../helpers/mockTheme';

const participant: GroupChatParticipant = {
	name: 'Maestro',
	agentId: 'claude-code',
	sessionId: 'participant-session',
	agentSessionId: '9e16b37a-0000-0000-0000-000000000000',
	addedAt: 0,
	contextUsage: 86,
	totalCost: 0.54,
};

const defaultProps = {
	theme: mockTheme,
	participant,
	state: 'idle' as const,
	groupChatId: 'group-chat',
};

describe('ParticipantCard compact controls', () => {
	it('keeps the session pill beside the name, including while the session is pending', () => {
		const { rerender } = render(<ParticipantCard {...defaultProps} />);
		const sessionPill = screen.getByRole('button', { name: '9E16B37A' });
		expect(screen.getByText(participant.name).parentElement).toContainElement(sessionPill);
		expect(sessionPill).toHaveAttribute(
			'title',
			`Session: ${participant.agentSessionId}\nClick to copy`
		);

		rerender(
			<ParticipantCard
				{...defaultProps}
				participant={{ ...participant, agentSessionId: undefined }}
			/>
		);
		expect(screen.getByText(participant.name).parentElement).toContainElement(
			screen.getByText('pending')
		);
	});

	it('shows percentage-only context and keeps icon actions accessible and discoverable', () => {
		render(<ParticipantCard {...defaultProps} onContextReset={vi.fn()} onRemove={vi.fn()} />);

		expect(screen.getByText('86%')).toBeInTheDocument();
		expect(screen.queryByText('Context')).not.toBeInTheDocument();
		expect(screen.getByRole('meter', { name: 'Context usage' })).toHaveAttribute(
			'aria-valuenow',
			'86'
		);
		for (const name of ['Reset context', 'Remove participant', 'Peek at live output']) {
			const button = screen.getByRole('button', { name });
			expect(button.textContent).toBe('');
			expect(button).toHaveAttribute('title');
		}
	});

	it('keeps reset pending feedback accessible until the reset finishes', async () => {
		let finishReset!: () => void;
		const onContextReset = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishReset = resolve;
				})
		);
		render(<ParticipantCard {...defaultProps} onContextReset={onContextReset} />);

		fireEvent.click(screen.getByRole('button', { name: 'Reset context' }));
		expect(onContextReset).toHaveBeenCalledWith(participant.name);
		expect(screen.getByRole('status', { name: 'Resetting context' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Reset context' })).not.toBeInTheDocument();

		await act(async () => finishReset());
		expect(screen.getByRole('button', { name: 'Reset context' })).toBeInTheDocument();
	});

	it('requires confirmation for removal and lets the user cancel', async () => {
		let finishRemoval!: (removed: boolean) => void;
		const onRemove = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					finishRemoval = resolve;
				})
		);
		render(<ParticipantCard {...defaultProps} onRemove={onRemove} />);

		fireEvent.click(screen.getByRole('button', { name: 'Remove participant' }));
		expect(onRemove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
		expect(onRemove).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Remove participant' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(onRemove).toHaveBeenCalledWith(participant.name);
		expect(screen.getByRole('status', { name: 'Removing participant' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();

		await act(async () => finishRemoval(true));
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
	});

	it('toggles live output using the icon button and exposes its pressed state', () => {
		render(<ParticipantCard {...defaultProps} liveOutput="Participant is working" />);
		const peek = screen.getByRole('button', { name: 'Peek at live output' });
		expect(peek).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(peek);
		expect(peek).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByText('Participant is working')).toBeInTheDocument();
		fireEvent.click(peek);
		expect(peek).toHaveAttribute('aria-pressed', 'false');
		expect(screen.queryByText('Participant is working')).not.toBeInTheDocument();
	});

	it('keeps the moderator compact without exposing participant-only actions', () => {
		render(
			<ParticipantCard
				theme={mockTheme}
				participant={{ name: 'Moderator', agentId: 'claude-code', sessionId: 'mod', addedAt: 0 }}
				state="idle"
			/>
		);
		expect(screen.getByText('0%')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Peek at live output' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Reset context' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Remove participant' })).not.toBeInTheDocument();
	});
});
