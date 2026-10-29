import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerSendColumn } from '../../../../renderer/components/ChatComposer';
import { createMockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/components/NotificationPopover', () => ({
	NotificationPopover: vi.fn(() => <div data-testid="notification-popover" />),
}));

const theme = createMockTheme();

describe('ComposerSendColumn', () => {
	it('toggles the notification settings popover from the bell', () => {
		render(<ComposerSendColumn theme={theme} onSend={vi.fn()} sendTitle="Send message" />);

		fireEvent.click(screen.getByTitle('Notification Settings'));
		expect(screen.getByTestId('notification-popover')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Notification Settings'));
		expect(screen.queryByTestId('notification-popover')).not.toBeInTheDocument();
	});

	describe('without a send menu (Group Chat)', () => {
		it('sends on click and advertises no popup', () => {
			const onSend = vi.fn();
			render(<ComposerSendColumn theme={theme} onSend={onSend} sendTitle="Send message" />);

			const send = screen.getByTitle('Send message');
			expect(send).not.toHaveAttribute('aria-haspopup');
			expect(send).not.toHaveAttribute('aria-expanded');
			fireEvent.click(send);

			expect(onSend).toHaveBeenCalledTimes(1);
		});

		it('ignores clicks and draws muted while disabled', () => {
			const onSend = vi.fn();
			render(
				<ComposerSendColumn theme={theme} onSend={onSend} sendTitle="Send message" sendDisabled />
			);

			const send = screen.getByTitle('Send message');
			expect(send).toBeDisabled();
			expect(send).toHaveStyle({
				backgroundColor: theme.colors.border,
				color: theme.colors.textDim,
			});
			fireEvent.click(send);

			expect(onSend).not.toHaveBeenCalled();
		});

		it('draws the warning tint for a send that will queue', () => {
			render(
				<ComposerSendColumn
					theme={theme}
					onSend={vi.fn()}
					sendTitle="Queue message"
					sendTone="warning"
				/>
			);

			expect(screen.getByTitle('Queue message')).toHaveStyle({
				backgroundColor: theme.colors.warning,
			});
		});
	});

	describe('with a send menu (AI chat)', () => {
		function renderWithMenu(shouldOpen: () => boolean, available = true) {
			const onSend = vi.fn();
			render(
				<ComposerSendColumn
					theme={theme}
					onSend={onSend}
					sendTitle="Send message"
					sendMenu={{
						available,
						shouldOpen,
						render: (_anchor, onClose) => (
							<button data-testid="send-menu" onClick={onClose}>
								menu
							</button>
						),
					}}
				/>
			);
			return { onSend, send: screen.getByTitle('Send message') };
		}

		it('opens the menu instead of sending when the surface asks for it', () => {
			const { onSend, send } = renderWithMenu(() => true);
			expect(send).toHaveAttribute('aria-haspopup', 'menu');
			expect(send).toHaveAttribute('aria-expanded', 'false');

			fireEvent.click(send);

			expect(screen.getByTestId('send-menu')).toBeInTheDocument();
			expect(send).toHaveAttribute('aria-expanded', 'true');
			expect(onSend).not.toHaveBeenCalled();
		});

		it('closes an open menu on the next click without sending', () => {
			const { onSend, send } = renderWithMenu(() => true);
			fireEvent.click(send);
			fireEvent.click(send);

			expect(screen.queryByTestId('send-menu')).not.toBeInTheDocument();
			expect(onSend).not.toHaveBeenCalled();
		});

		it('lets the menu close itself', () => {
			const { send } = renderWithMenu(() => true);
			fireEvent.click(send);
			fireEvent.click(screen.getByTestId('send-menu'));

			expect(screen.queryByTestId('send-menu')).not.toBeInTheDocument();
		});

		it('sends when the surface does not want the menu', () => {
			const { onSend, send } = renderWithMenu(() => false);
			fireEvent.click(send);

			expect(onSend).toHaveBeenCalledTimes(1);
			expect(screen.queryByTestId('send-menu')).not.toBeInTheDocument();
		});

		it('drops the popup attributes when the menu is unavailable (terminal mode)', () => {
			const { send } = renderWithMenu(() => false, false);

			expect(send).not.toHaveAttribute('aria-haspopup');
			expect(send).not.toHaveAttribute('aria-expanded');
		});
	});
});
