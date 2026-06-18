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
});
