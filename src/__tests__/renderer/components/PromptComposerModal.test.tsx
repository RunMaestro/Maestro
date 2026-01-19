import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptComposerModal } from '../../../renderer/components/PromptComposerModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock Lucide icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	PenLine: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="penline-icon" className={className} style={style} />
	),
	Send: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="send-icon" className={className} style={style} />
	),
	Keyboard: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="keyboard-icon" className={className} style={style} />
	),
	ImageIcon: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="image-icon" className={className} style={style} />
	),
	History: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="history-icon" className={className} style={style} />
	),
	Eye: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="eye-icon" className={className} style={style} />
	),
}));

// Mock theme
const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		textFaint: '#555555',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#1a1a1a',
		scrollbarThumb: '#444444',
	},
};

const lightTheme: Theme = {
	id: 'test-light',
	name: 'Test Light',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f5f5f5',
		border: '#e0e0e0',
		textMain: '#000000',
		textDim: '#666666',
		textFaint: '#aaaaaa',
		accent: '#0066cc',
		accentForeground: '#ffffff',
		buttonBg: '#e0e0e0',
		buttonHover: '#d0d0d0',
		headerBg: '#fafafa',
		scrollbarTrack: '#f0f0f0',
		scrollbarThumb: '#cccccc',
	},
};

// Helper to render with LayerStackProvider
const renderWithProvider = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('PromptComposerModal', () => {
	let onClose: ReturnType<typeof vi.fn>;
	let onSubmit: ReturnType<typeof vi.fn>;
	let onSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onClose = vi.fn();
		onSubmit = vi.fn();
		onSend = vi.fn();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Rendering', () => {
		it('should not render when isOpen is false', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={false}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.queryByText('Prompt Composer')).not.toBeInTheDocument();
		});

		it('should render when isOpen is true', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('Prompt Composer')).toBeInTheDocument();
		});

		it('should render header with PenLine icon', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByTestId('penline-icon')).toBeInTheDocument();
		});

		it('should render with default session name "Claude"', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('— Claude')).toBeInTheDocument();
		});

		it('should render with custom session name', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessionName="My Custom Session"
				/>
			);

			expect(screen.getByText('— My Custom Session')).toBeInTheDocument();
		});

		it('should render keyboard shortcut hint when onToggleEnterToSend is provided', () => {
			const onToggle = vi.fn();
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					enterToSend={false}
					onToggleEnterToSend={onToggle}
				/>
			);

			// When enterToSend is false, it shows "⌘ + Enter"
			expect(screen.getByText('⌘ + Enter')).toBeInTheDocument();
		});

		it('should render close button with X icon', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByTitle('Close (Escape)')).toBeInTheDocument();
			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('should render textarea with placeholder', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByPlaceholderText('Write your prompt here...')).toBeInTheDocument();
		});

		it('should render textarea with initial value', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Initial prompt text"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe('Initial prompt text');
		});

		it('should render Send button with icon', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
			expect(screen.getByTestId('send-icon')).toBeInTheDocument();
		});
	});

	describe('Theme colors', () => {
		it('should apply dark theme colors', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const title = screen.getByText('Prompt Composer');
			expect(title).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('should apply light theme colors', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={lightTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const title = screen.getByText('Prompt Composer');
			expect(title).toHaveStyle({ color: lightTheme.colors.textMain });
		});

		it('should apply accent color to PenLine icon', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const icon = screen.getByTestId('penline-icon');
			expect(icon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('should apply accent color to Send button', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="text"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});
	});

	describe('Character and token count', () => {
		it('should display 0 characters for empty text', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('0 characters')).toBeInTheDocument();
		});

		it('should display correct character count', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Hello World"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('11 characters')).toBeInTheDocument();
		});

		it('should display ~0 tokens for empty text', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('~0 tokens')).toBeInTheDocument();
		});

		it('should estimate tokens at 4 chars per token', () => {
			// 20 characters should be ~5 tokens (ceil(20/4) = 5)
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="12345678901234567890"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('~5 tokens')).toBeInTheDocument();
		});

		it('should round up token estimate', () => {
			// 9 characters should be ~3 tokens (ceil(9/4) = 3)
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="123456789"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('~3 tokens')).toBeInTheDocument();
		});

		it('should format large token counts with locale separators', () => {
			// 10000 characters = 2500 tokens, displayed as "2,500"
			const longText = 'a'.repeat(10000);
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue={longText}
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('~2,500 tokens')).toBeInTheDocument();
		});

		it('should update counts when typing', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.change(textarea, { target: { value: 'Hello' } });

			expect(screen.getByText('5 characters')).toBeInTheDocument();
			expect(screen.getByText('~2 tokens')).toBeInTheDocument();
		});
	});

	describe('Focus management', () => {
		it('should focus textarea when modal opens', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			expect(document.activeElement).toBe(textarea);
		});

		it('should position cursor at end of text', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Hello World"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			expect(textarea.selectionStart).toBe(11);
			expect(textarea.selectionEnd).toBe(11);
		});
	});

	describe('Value syncing', () => {
		it('should sync value when modal opens with new initialValue', () => {
			const { rerender } = renderWithProvider(
				<PromptComposerModal
					isOpen={false}
					onClose={onClose}
					theme={mockTheme}
					initialValue="First value"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			// Modal closed, now open with new value
			rerender(
				<LayerStackProvider>
					<PromptComposerModal
						isOpen={true}
						onClose={onClose}
						theme={mockTheme}
						initialValue="New value"
						onSubmit={onSubmit}
						onSend={onSend}
					/>
				</LayerStackProvider>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe('New value');
		});

		it('should update value when initialValue changes while open', () => {
			const { rerender } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="First"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			rerender(
				<LayerStackProvider>
					<PromptComposerModal
						isOpen={true}
						onClose={onClose}
						theme={mockTheme}
						initialValue="Second"
						onSubmit={onSubmit}
						onSend={onSend}
					/>
				</LayerStackProvider>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe('Second');
		});
	});

	describe('Send button', () => {
		it('should be disabled when text is empty', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).toBeDisabled();
		});

		it('should be disabled when text is only whitespace', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="   "
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).toBeDisabled();
		});

		it('should be enabled when text has content', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Hello"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).not.toBeDisabled();
		});

		it('should call onSend and onClose when clicked', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="My prompt"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			fireEvent.click(sendButton);

			expect(onSend).toHaveBeenCalledWith('My prompt');
			expect(onClose).toHaveBeenCalled();
		});

		it('should not call onSend when empty and clicked', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			fireEvent.click(sendButton);

			expect(onSend).not.toHaveBeenCalled();
		});
	});

	describe('Keyboard shortcuts', () => {
		it('should send on Cmd + Enter (Mac)', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Test message"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(onSend).toHaveBeenCalledWith('Test message');
			expect(onClose).toHaveBeenCalled();
		});

		it('should send on Ctrl + Enter (Windows/Linux)', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Test message"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

			expect(onSend).toHaveBeenCalledWith('Test message');
			expect(onClose).toHaveBeenCalled();
		});

		it('should not send on Enter without modifier', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Test message"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(onSend).not.toHaveBeenCalled();
		});

		it('should not send on Cmd + Enter with empty content', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(onSend).not.toHaveBeenCalled();
		});

		it('should not send on Cmd + Enter with only whitespace', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="   "
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(onSend).not.toHaveBeenCalled();
		});
	});

	describe('Close button', () => {
		it('should call onSubmit with current value when clicked', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Current text"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const closeButton = screen.getByTitle('Close (Escape)');
			fireEvent.click(closeButton);

			expect(onSubmit).toHaveBeenCalledWith('Current text');
			expect(onClose).toHaveBeenCalled();
		});

		it('should preserve edited value on close', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Initial"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.change(textarea, { target: { value: 'Edited text' } });

			const closeButton = screen.getByTitle('Close (Escape)');
			fireEvent.click(closeButton);

			expect(onSubmit).toHaveBeenCalledWith('Edited text');
		});
	});

	describe('Backdrop click', () => {
		it('should call onSubmit and onClose when clicking backdrop', () => {
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Saved text"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			// Click the backdrop (outer div) - use the first child of container which is the backdrop
			const backdrop = container.querySelector('.fixed.inset-0');
			if (backdrop) {
				// Need to click exactly on the backdrop, not bubbling from child
				fireEvent.click(backdrop);
			}

			expect(onSubmit).toHaveBeenCalledWith('Saved text');
			expect(onClose).toHaveBeenCalled();
		});

		it('should not close when clicking inside modal content', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Text"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.click(textarea);

			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Layer stack integration', () => {
		it('should call onSubmit with current value when Escape is pressed', async () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="My draft"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			// Simulate Escape key (handled by layer stack)
			fireEvent.keyDown(document, { key: 'Escape' });

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith('My draft');
				expect(onClose).toHaveBeenCalled();
			});
		});

		it('should save edited value on Escape', async () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Original"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.change(textarea, { target: { value: 'Modified' } });

			fireEvent.keyDown(document, { key: 'Escape' });

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith('Modified');
			});
		});
	});

	describe('Textarea behavior', () => {
		it('should update value on change', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			fireEvent.change(textarea, { target: { value: 'New content' } });

			expect((textarea as HTMLTextAreaElement).value).toBe('New content');
		});

		it('should apply theme text color to textarea', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			expect(textarea).toHaveStyle({ color: mockTheme.colors.textMain });
		});
	});

	describe('Edge cases', () => {
		it('should handle empty session name gracefully', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessionName=""
				/>
			);

			expect(screen.getByText('—')).toBeInTheDocument();
		});

		it('should handle very long text', () => {
			const longText = 'a'.repeat(50000);
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue={longText}
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByText('50000 characters')).toBeInTheDocument();
			expect(screen.getByText('~12,500 tokens')).toBeInTheDocument();
		});

		it('should handle unicode characters in text', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Hello 世界 🌍"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			// Unicode chars are still counted as characters
			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe('Hello 世界 🌍');
		});

		it('should handle special characters in session name', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessionName="Test <script>alert('xss')</script>"
				/>
			);

			// React escapes these by default
			expect(screen.getByText("— Test <script>alert('xss')</script>")).toBeInTheDocument();
		});

		it('should handle newlines in text', () => {
			const multilineText = 'Line 1\nLine 2\nLine 3';
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue={multilineText}
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			// 20 characters including newlines (6+1+6+1+6)
			expect(screen.getByText('20 characters')).toBeInTheDocument();
		});
	});

	describe('Modal structure', () => {
		it('should have fixed positioning with z-50', () => {
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const overlay = container.querySelector('.fixed.inset-0.z-50');
			expect(overlay).toBeInTheDocument();
		});

		it('should have semi-transparent backdrop', () => {
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const overlay = container.querySelector('.fixed.inset-0');
			expect(overlay).toHaveStyle({ backgroundColor: 'rgba(0,0,0,0.7)' });
		});

		it('should have modal content with rounded corners and border', () => {
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const modalContent = container.querySelector('.rounded-xl.border.shadow-2xl');
			expect(modalContent).toBeInTheDocument();
			expect(modalContent).toHaveStyle({
				backgroundColor: mockTheme.colors.bgMain,
				borderColor: mockTheme.colors.border,
			});
		});

		it('should have 90vw width and 80vh height', () => {
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const modalContent = container.querySelector('.w-\\[90vw\\].h-\\[80vh\\]');
			expect(modalContent).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('should have accessible textarea', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			expect(textarea.tagName).toBe('TEXTAREA');
		});

		it('should have accessible close button with title', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const closeButton = screen.getByTitle('Close (Escape)');
			expect(closeButton).toBeInTheDocument();
			expect(closeButton.tagName).toBe('BUTTON');
		});

		it('should have accessible send button', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Text"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).toBeInTheDocument();
		});
	});
});
