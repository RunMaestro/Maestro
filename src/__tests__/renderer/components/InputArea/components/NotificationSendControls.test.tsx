import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationSendControls } from '../../../../../renderer/components/InputArea/components/NotificationSendControls';
import { inputAreaTheme } from '../_fixtures';

vi.mock('../../../../../renderer/components/NotificationPopover', () => ({
	NotificationPopover: vi.fn(({ onClose }) => (
		<div data-testid="notification-popover">
			<button onClick={onClose}>Close</button>
		</div>
	)),
}));

describe('NotificationSendControls', () => {
	it('toggles notification popover', () => {
		render(
			<NotificationSendControls
				theme={inputAreaTheme}
				isTerminalMode={false}
				processInput={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByTitle('Notification Settings'));
		expect(screen.getByTestId('notification-popover')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Notification Settings'));
		expect(screen.queryByTestId('notification-popover')).not.toBeInTheDocument();
	});

	it('sends input and uses terminal title in terminal mode', () => {
		const processInput = vi.fn();
		render(
			<NotificationSendControls theme={inputAreaTheme} isTerminalMode processInput={processInput} />
		);

		fireEvent.click(screen.getByTitle('Run command (Enter)'));

		expect(processInput).toHaveBeenCalled();
	});

	describe('the A Cappella microphone', () => {
		it('is absent unless A Cappella owns the composer microphone', () => {
			// The default. With the Encore Feature off the button stays the Web Speech
			// one in the toolbar row, so this column must not draw a second mic.
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={vi.fn()}
				/>
			);

			expect(screen.queryByTestId('composer-voice-button')).toBeNull();
		});

		it('starts a voice session when clicked', () => {
			const onToggleVoice = vi.fn();
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={vi.fn()}
					showVoiceButton
					onToggleVoice={onToggleVoice}
				/>
			);

			fireEvent.click(screen.getByTestId('composer-voice-button'));

			expect(onToggleVoice).toHaveBeenCalledTimes(1);
		});

		it('offers to END the session while the floor is open', () => {
			// The one button here that can leave a microphone running, so it must not
			// read the same open as shut.
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={vi.fn()}
					showVoiceButton
					isVoiceListening
					onToggleVoice={vi.fn()}
				/>
			);

			const button = screen.getByTestId('composer-voice-button');
			expect(button.getAttribute('aria-pressed')).toBe('true');
			expect(button.getAttribute('aria-label')).toBe('End the voice session');
		});
	});
});
