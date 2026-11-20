import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	ComposerSendColumn,
	ComposerVoiceSessionButton,
} from '../../../../renderer/components/ChatComposer';
import { inputAreaTheme } from '../InputArea/_fixtures';

vi.mock('../../../../renderer/components/NotificationPopover', () => ({
	NotificationPopover: vi.fn(() => null),
}));

describe('ComposerVoiceSessionButton', () => {
	it('starts a voice session when clicked', () => {
		const onToggle = vi.fn();
		render(
			<ComposerVoiceSessionButton
				theme={inputAreaTheme}
				active={false}
				onToggle={onToggle}
				label="Talk to this agent"
				activeLabel="End the voice session"
				testId="composer-voice-button"
			/>
		);

		const button = screen.getByTestId('composer-voice-button');
		expect(button.getAttribute('aria-label')).toBe('Talk to this agent');
		expect(button.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(button);
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('offers to END the session while the floor is open', () => {
		// The one button here that can leave a microphone running, so it must not
		// read the same open as shut.
		render(
			<ComposerVoiceSessionButton
				theme={inputAreaTheme}
				active
				onToggle={vi.fn()}
				label="Talk to this agent"
				activeLabel="End the voice session"
			/>
		);

		const button = screen.getByRole('button', { name: 'End the voice session' });
		expect(button.getAttribute('aria-pressed')).toBe('true');
	});

	it('keeps its label while active when a click does not end the session', () => {
		render(
			<ComposerVoiceSessionButton
				theme={inputAreaTheme}
				active
				onToggle={vi.fn()}
				label="Talk to group chat"
			/>
		);

		expect(screen.getByRole('button', { name: 'Talk to group chat' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('sits under Send in the send column', () => {
		render(
			<ComposerSendColumn
				theme={inputAreaTheme}
				onSend={vi.fn()}
				sendTitle="Send message"
				belowSend={
					<ComposerVoiceSessionButton
						theme={inputAreaTheme}
						active={false}
						onToggle={vi.fn()}
						label="Talk to this agent"
						testId="composer-voice-button"
					/>
				}
			/>
		);

		const send = screen.getByTitle('Send message');
		expect(send.nextElementSibling).toBe(screen.getByTestId('composer-voice-button'));
	});
});
