import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ExpandedModeSendInterruptButton,
	InputModeToggleButton,
	SendInterruptButton,
	SlashCommandButton,
	VoiceInputButton,
} from '../../../web/mobile/CommandInputButtons';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		accent: '#6366f1',
		border: '#444444',
		textDim: '#888888',
	}),
}));

describe('CommandInputButtons', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vi.fn(),
			writable: true,
		});
	});

	describe('InputModeToggleButton', () => {
		it('renders AI mode styling and toggles with haptic feedback', () => {
			const onModeToggle = vi.fn();
			render(<InputModeToggleButton inputMode="ai" onModeToggle={onModeToggle} disabled={false} />);

			const button = screen.getByRole('button', {
				name: 'Switch to terminal mode. Currently in AI mode.',
			});
			expect(button).toHaveAttribute('aria-pressed', 'true');
			expect(button).toHaveTextContent('AI');
			expect(button.style.border).toBe('2px solid rgb(99, 102, 241)');

			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('scale(0.95)');
			fireEvent.touchEnd(button);
			expect(button.style.transform).toBe('scale(1)');

			fireEvent.click(button);
			expect(navigator.vibrate).toHaveBeenCalledWith(10);
			expect(onModeToggle).toHaveBeenCalledTimes(1);
		});

		it('renders terminal mode and suppresses touch feedback when disabled', () => {
			const onModeToggle = vi.fn();
			render(
				<InputModeToggleButton inputMode="terminal" onModeToggle={onModeToggle} disabled={true} />
			);

			const button = screen.getByRole('button', {
				name: 'Switch to AI mode. Currently in terminal mode.',
			});
			expect(button).toBeDisabled();
			expect(button).toHaveAttribute('aria-pressed', 'false');
			expect(button).toHaveTextContent('CLI');
			expect(button.style.opacity).toBe('0.5');

			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('');
			fireEvent.click(button);
			expect(onModeToggle).not.toHaveBeenCalled();
		});
	});

	describe('VoiceInputButton', () => {
		it('toggles voice input and reflects listening state', () => {
			const onToggle = vi.fn();
			const { rerender } = render(
				<VoiceInputButton isListening={false} onToggle={onToggle} disabled={false} />
			);

			const startButton = screen.getByRole('button', { name: 'Start voice input' });
			expect(startButton).toHaveAttribute('aria-pressed', 'false');
			expect(startButton.style.animation).toBe('none');

			fireEvent.touchStart(startButton);
			expect(startButton.style.transform).toBe('scale(0.95)');
			fireEvent.touchEnd(startButton);
			expect(startButton.style.transform).toBe('scale(1)');
			fireEvent.click(startButton);
			expect(onToggle).toHaveBeenCalledTimes(1);

			rerender(<VoiceInputButton isListening={true} onToggle={onToggle} disabled={false} />);
			const stopButton = screen.getByRole('button', { name: 'Stop voice input' });
			expect(stopButton).toHaveAttribute('aria-pressed', 'true');
			expect(stopButton.style.border).toBe('2px solid rgb(239, 68, 68)');
			expect(stopButton.querySelector('svg')).toHaveAttribute('fill', '#ef4444');
		});

		it('disables voice input without touch feedback', () => {
			const onToggle = vi.fn();
			render(<VoiceInputButton isListening={false} onToggle={onToggle} disabled={true} />);

			const button = screen.getByRole('button', { name: 'Start voice input' });
			expect(button).toBeDisabled();
			expect(button.style.opacity).toBe('0.5');
			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('');
			fireEvent.click(button);
			expect(onToggle).not.toHaveBeenCalled();
		});
	});

	describe('SlashCommandButton', () => {
		it('opens slash commands and applies open-state styling', () => {
			const onOpen = vi.fn();
			const { rerender } = render(
				<SlashCommandButton isOpen={false} onOpen={onOpen} disabled={false} />
			);

			const button = screen.getByRole('button', { name: 'Open slash commands' });
			expect(button).toHaveTextContent('/');
			expect(button.style.border).toBe('2px solid rgb(68, 68, 68)');

			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('scale(0.95)');
			fireEvent.touchEnd(button);
			expect(button.style.transform).toBe('scale(1)');
			fireEvent.click(button);
			expect(onOpen).toHaveBeenCalledTimes(1);

			rerender(<SlashCommandButton isOpen={true} onOpen={onOpen} disabled={false} />);
			expect(button.style.border).toBe('2px solid rgb(99, 102, 241)');
		});

		it('disables slash command opening and touch feedback', () => {
			const onOpen = vi.fn();
			render(<SlashCommandButton isOpen={false} onOpen={onOpen} disabled={true} />);

			const button = screen.getByRole('button', { name: 'Open slash commands' });
			expect(button).toBeDisabled();
			expect(button.style.opacity).toBe('0.5');
			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('');
			fireEvent.click(button);
			expect(onOpen).not.toHaveBeenCalled();
		});
	});

	describe('SendInterruptButton', () => {
		it('renders interrupt mode with haptics and pressed feedback', () => {
			const onInterrupt = vi.fn();
			render(
				<SendInterruptButton
					isInterruptMode={true}
					isSendDisabled={false}
					onInterrupt={onInterrupt}
				/>
			);

			const button = screen.getByRole('button', { name: 'Cancel running command or AI query' });
			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('scale(0.95)');
			expect(button.style.backgroundColor).toBe('rgb(220, 38, 38)');
			fireEvent.touchEnd(button);
			expect(button.style.transform).toBe('scale(1)');
			expect(button.style.backgroundColor).toBe('rgb(239, 68, 68)');

			fireEvent.click(button);
			expect(navigator.vibrate).toHaveBeenCalledWith(50);
			expect(onInterrupt).toHaveBeenCalledTimes(1);
		});

		it('renders send mode with refs, disabled state, and long-press handlers', () => {
			const sendButtonRef = React.createRef<HTMLButtonElement>();
			const onTouchStart = vi.fn();
			const onTouchEnd = vi.fn();
			const onTouchMove = vi.fn();
			render(
				<SendInterruptButton
					isInterruptMode={false}
					isSendDisabled={true}
					onInterrupt={vi.fn()}
					sendButtonRef={sendButtonRef}
					onTouchStart={onTouchStart}
					onTouchEnd={onTouchEnd}
					onTouchMove={onTouchMove}
				/>
			);

			const button = screen.getByRole('button', {
				name: 'Send command (long press for quick actions)',
			});
			expect(button).toBeDisabled();
			expect(button.getAttribute('type')).toBe('submit');
			expect(button.style.opacity).toBe('0.5');
			expect(sendButtonRef.current).toBe(button);

			fireEvent.touchStart(button);
			fireEvent.touchMove(button);
			fireEvent.touchEnd(button);
			expect(onTouchStart).toHaveBeenCalledTimes(1);
			expect(onTouchMove).toHaveBeenCalledTimes(1);
			expect(onTouchEnd).toHaveBeenCalledTimes(1);
		});
	});

	describe('ExpandedModeSendInterruptButton', () => {
		it('renders full-width interrupt mode with haptics and pressed feedback', () => {
			const onInterrupt = vi.fn();
			render(
				<ExpandedModeSendInterruptButton
					isInterruptMode={true}
					isSendDisabled={false}
					onInterrupt={onInterrupt}
				/>
			);

			const button = screen.getByRole('button', { name: 'Cancel running AI query' });
			expect(button).toHaveTextContent('Stop');
			fireEvent.touchStart(button);
			expect(button.style.backgroundColor).toBe('rgb(220, 38, 38)');
			fireEvent.touchEnd(button);
			expect(button.style.backgroundColor).toBe('rgb(239, 68, 68)');

			fireEvent.click(button);
			expect(navigator.vibrate).toHaveBeenCalledWith(50);
			expect(onInterrupt).toHaveBeenCalledTimes(1);
		});

		it('renders full-width send mode and disabled state', () => {
			render(
				<ExpandedModeSendInterruptButton
					isInterruptMode={false}
					isSendDisabled={true}
					onInterrupt={vi.fn()}
				/>
			);

			const button = screen.getByRole('button', { name: 'Send message' });
			expect(button).toHaveTextContent('Send');
			expect(button).toBeDisabled();
			expect(button.getAttribute('type')).toBe('submit');
			expect(button.style.opacity).toBe('0.5');
			expect(button.style.cursor).toBe('default');
		});
	});
});
