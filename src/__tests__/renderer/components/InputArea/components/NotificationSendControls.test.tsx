import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationSendControls } from '../../../../../renderer/components/InputArea/components/NotificationSendControls';
import { inputAreaTheme } from '../_fixtures';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../../../renderer/stores/composerInputStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { createMockAITab, createMockSession } from '../../../../helpers';

vi.mock('../../../../../renderer/components/InputArea/components/SendMenuPopover', () => ({
	SendMenuPopover: vi.fn(() => <div data-testid="send-menu-popover" />),
}));

function seedWorkingAgent(draft: string) {
	const session = createMockSession({
		state: 'busy',
		activeTabId: 'tab-1',
		aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	useComposerInputStore.setState({ aiValue: draft, aiCommandMode: 'off' });
}

vi.mock('../../../../../renderer/components/NotificationPopover', () => ({
	NotificationPopover: vi.fn(({ onClose }) => (
		<div data-testid="notification-popover">
			<button onClick={onClose}>Close</button>
		</div>
	)),
}));

describe('NotificationSendControls', () => {
	afterEach(() => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		useComposerInputStore.setState({ aiValue: '' });
		useSettingsStore.setState({ sendButtonMenu: true });
	});

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

	it('opens the send menu instead of sending while the agent works', () => {
		seedWorkingAgent('also check the retry path');
		const processInput = vi.fn();
		render(
			<NotificationSendControls
				theme={inputAreaTheme}
				isTerminalMode={false}
				processInput={processInput}
			/>
		);

		fireEvent.click(screen.getByTitle('Send message'));

		expect(screen.getByTestId('send-menu-popover')).toBeInTheDocument();
		expect(processInput).not.toHaveBeenCalled();
	});

	it('sends at once when the menu is turned off', () => {
		seedWorkingAgent('also check the retry path');
		useSettingsStore.setState({ sendButtonMenu: false });
		const processInput = vi.fn();
		render(
			<NotificationSendControls
				theme={inputAreaTheme}
				isTerminalMode={false}
				processInput={processInput}
			/>
		);

		fireEvent.click(screen.getByTitle('Send message'));

		expect(processInput).toHaveBeenCalled();
		expect(screen.queryByTestId('send-menu-popover')).not.toBeInTheDocument();
	});

	it('sends at once when the draft is empty', () => {
		seedWorkingAgent('');
		const processInput = vi.fn();
		render(
			<NotificationSendControls
				theme={inputAreaTheme}
				isTerminalMode={false}
				processInput={processInput}
			/>
		);

		fireEvent.click(screen.getByTitle('Send message'));

		expect(processInput).toHaveBeenCalled();
	});
});
