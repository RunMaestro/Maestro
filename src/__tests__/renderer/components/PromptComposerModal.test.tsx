import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptComposerModal } from '../../../renderer/components/PromptComposerModal';
import { formatEnterToSend } from '../../../renderer/utils/shortcutFormatter';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, Session, Group } from '../../../renderer/types';

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
	Users: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="users-icon" className={className} style={style} />
	),
	Brain: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="brain-icon" className={className} style={style} />
	),
	Pin: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="pin-icon" className={className} style={style} />
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

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

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
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (originalScrollIntoView) {
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
				configurable: true,
				value: originalScrollIntoView,
			});
		} else {
			Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
		}
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

		it('keeps the live textarea out of bionify reading mode', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Reading-mode exclusions stay in the editor."
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			expect(screen.getByRole('textbox')).toHaveValue(
				'Reading-mode exclusions stay in the editor.'
			);
			expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
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

			expect(screen.getByText(formatEnterToSend(false))).toBeInTheDocument();
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

	describe('@mention autocomplete (group chat mode)', () => {
		function createMockSession(
			id: string,
			name: string,
			toolType: string = 'claude-code'
		): Session {
			return {
				id,
				name,
				toolType,
				state: 'idle',
				cwd: '/test',
				fullPath: '/test',
				projectRoot: '/test',
				aiLogs: [],
				shellLogs: [],
				workLog: [],
				contextUsage: 0,
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 0,
				isLive: false,
				changedFiles: [],
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				executionQueue: [],
				activeTimeMs: 0,
				aiTabs: [],
				activeTabId: '',
				closedTabHistory: [],
			};
		}

		function createMockGroup(id: string, name: string, emoji: string = '📁'): Group {
			return { id, name, emoji, collapsed: false };
		}

		it('should show mention placeholder when sessions are provided', () => {
			const sessions = [createMockSession('s1', 'Agent1')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			expect(
				screen.getByPlaceholderText('Write your prompt here... (@ to mention agent)')
			).toBeInTheDocument();
		});

		it('should show mention dropdown when typing @', () => {
			const sessions = [createMockSession('s1', 'Agent1'), createMockSession('s2', 'Agent2')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.getByText('@Agent1')).toBeInTheDocument();
			expect(screen.getByText('@Agent2')).toBeInTheDocument();
		});

		it('should filter mentions as user types', () => {
			const sessions = [createMockSession('s1', 'Agent1'), createMockSession('s2', 'Other')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@Age' } });

			expect(screen.getByText('@Agent1')).toBeInTheDocument();
			expect(screen.queryByText('@Other')).not.toBeInTheDocument();
		});

		it('should insert mention on click', () => {
			const sessions = [createMockSession('s1', 'Agent1')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			fireEvent.click(screen.getByText('@Agent1'));

			expect(textarea.value).toBe('@Agent1 ');
		});

		it('should insert mention on Tab key', () => {
			const sessions = [createMockSession('s1', 'Agent1')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			fireEvent.keyDown(textarea, { key: 'Tab' });

			expect(textarea.value).toBe('@Agent1 ');
		});

		it('should navigate mentions with arrow keys', () => {
			const sessions = [createMockSession('s1', 'Agent1'), createMockSession('s2', 'Agent2')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'Tab' });

			expect(textarea.value).toBe('@Agent2 ');
		});

		it('should wrap mention navigation at both ends', () => {
			const sessions = [createMockSession('s1', 'Agent1'), createMockSession('s2', 'Agent2')];
			const first = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea.value).toBe('@Agent1 ');
			first.unmount();

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const secondTextarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(secondTextarea, { target: { value: '@' } });
			fireEvent.keyDown(secondTextarea, { key: 'ArrowDown' });
			fireEvent.keyDown(secondTextarea, { key: 'ArrowUp' });
			fireEvent.keyDown(secondTextarea, { key: 'Tab' });
			expect(secondTextarea.value).toBe('@Agent1 ');
		});

		it('should close dropdown on Escape', () => {
			const sessions = [createMockSession('s1', 'Agent1')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });
			expect(screen.getByText('@Agent1')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 'Escape' });
			expect(screen.queryByText('@Agent1')).not.toBeInTheDocument();
		});

		it('should exclude terminal sessions', () => {
			const sessions = [
				createMockSession('s1', 'Agent1', 'claude-code'),
				createMockSession('s2', 'Terminal', 'terminal'),
			];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.getByText('@Agent1')).toBeInTheDocument();
			expect(screen.queryByText('@Terminal')).not.toBeInTheDocument();
		});

		it('should expand group into member mentions', () => {
			const groups = [createMockGroup('g1', 'TEAM', '🏢')];
			const sessions = [
				{ ...createMockSession('s1', 'Agent1'), groupId: 'g1' },
				{ ...createMockSession('s2', 'Agent2'), groupId: 'g1' },
			];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
					groups={groups}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			fireEvent.click(screen.getByText('@TEAM'));

			expect(textarea.value).toBe('@Agent1 @Agent2 ');
		});

		it('should not show mention dropdown without sessions prop', () => {
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
			fireEvent.change(textarea, { target: { value: '@' } });

			// No mention dropdown should appear
			const buttons = screen.queryAllByRole('button');
			const mentionButtons = buttons.filter((btn) => btn.textContent?.startsWith('@'));
			expect(mentionButtons).toHaveLength(0);
		});

		it('should filter groups by normalized names and expand their normalized members', () => {
			const groups = [createMockGroup('g1', 'Frontend Team', '🏢')];
			const sessions = [
				{ ...createMockSession('s1', 'Lead Agent'), groupId: 'g1' },
				{ ...createMockSession('s2', 'Review Agent'), groupId: 'g1' },
				createMockSession('s3', 'Solo Agent'),
			];

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
					groups={groups}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@frontend-' } });
			fireEvent.click(screen.getByText('@Frontend-Team'));

			expect(textarea.value).toBe('@Lead-Agent @Review-Agent ');
			expect(onSubmit).toHaveBeenCalledWith('@Lead-Agent @Review-Agent ');
		});

		it('should skip groups without mentionable members', () => {
			const groups = [createMockGroup('g1', 'Empty Team', '🏢')];
			const sessions = [createMockSession('s1', 'Solo Agent')];

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
					groups={groups}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.queryByText('@Empty-Team')).not.toBeInTheDocument();
			expect(screen.getByText('@Solo-Agent')).toBeInTheDocument();
		});

		it('should render the original agent name when the mention is normalized', () => {
			const sessions = [createMockSession('s1', 'Lead Agent')];

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.getByText('@Lead-Agent')).toBeInTheDocument();
			expect(screen.getByText('(Lead Agent)')).toBeInTheDocument();
		});

		it('should omit the alias label when a mention name matches the session name', () => {
			const sessions = [createMockSession('s1', 'Agent1')];

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.getByText('@Agent1')).toBeInTheDocument();
			expect(screen.queryByText('(Agent1)')).not.toBeInTheDocument();
		});

		it('should not insert a mention on modified Enter while suggestions are open', () => {
			const sessions = [createMockSession('s1', 'Agent1')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

			expect(textarea.value).toBe('@');
			expect(screen.getByText('@Agent1')).toBeInTheDocument();
		});

		it('should navigate upward, scroll the selected mention, and insert with Enter', async () => {
			vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			});
			const scrollIntoView = vi.fn();
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
				configurable: true,
				value: scrollIntoView,
			});
			const sessions = [createMockSession('s1', 'Agent1'), createMockSession('s2', 'Agent2')];

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });
			await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

			fireEvent.keyDown(textarea, { key: 'ArrowUp' });
			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(textarea.value).toBe('@Agent2 ');
		});

		it('should close mention suggestions once the active mention ends or disappears', () => {
			const sessions = [createMockSession('s1', 'Agent1')];
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					sessions={sessions}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Write your prompt here... (@ to mention agent)'
			);
			fireEvent.change(textarea, { target: { value: '@' } });
			expect(screen.getByText('@Agent1')).toBeInTheDocument();

			fireEvent.change(textarea, { target: { value: '@Agent1 done' } });
			expect(screen.queryByText('@Agent1')).not.toBeInTheDocument();

			fireEvent.change(textarea, { target: { value: 'plain text' } });
			expect(screen.queryByText('@Agent1')).not.toBeInTheDocument();
		});
	});

	describe('Editing shortcuts and paste handling', () => {
		it('should insert a tab character at the cursor and restore selection', () => {
			let pendingFrame: FrameRequestCallback | undefined;
			vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
				pendingFrame = callback;
				return 1;
			});
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="HelloWorld"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);
			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			textarea.selectionStart = 5;
			textarea.selectionEnd = 5;

			fireEvent.keyDown(textarea, { key: 'Tab' });
			pendingFrame?.(0);

			expect(textarea.value).toBe('Hello\tWorld');
			expect(textarea.selectionStart).toBe(6);
			expect(textarea.selectionEnd).toBe(6);
		});

		it('should trim pasted plain text and keep the cursor after the inserted text', () => {
			vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			});
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Hello world"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);
			const textarea = screen.getByPlaceholderText(
				'Write your prompt here...'
			) as HTMLTextAreaElement;
			textarea.selectionStart = 6;
			textarea.selectionEnd = 11;
			const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(pasteEvent, 'clipboardData', {
				value: {
					items: [],
					getData: () => '  Maestro  ',
				},
			});

			fireEvent(textarea, pasteEvent);

			expect(pasteEvent.defaultPrevented).toBe(true);
			expect(textarea.value).toBe('Hello Maestro');
			expect(textarea.selectionStart).toBe(13);
			expect(textarea.selectionEnd).toBe(13);
		});

		it('should leave already-trimmed pasted text to the browser default path', () => {
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
			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(pasteEvent, 'clipboardData', {
				value: {
					items: [],
					getData: () => 'Maestro',
				},
			});

			fireEvent(textarea, pasteEvent);

			expect(pasteEvent.defaultPrevented).toBe(false);
		});

		it('should leave empty pasted text to the browser default path', () => {
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
			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(pasteEvent, 'clipboardData', {
				value: {
					items: [],
					getData: () => '',
				},
			});

			fireEvent(textarea, pasteEvent);

			expect(pasteEvent.defaultPrevented).toBe(false);
		});

		it('should ignore partial modifier shortcuts that are reserved for footer actions', () => {
			const onOpenLightbox = vi.fn();
			const onToggleTabSaveToHistory = vi.fn();

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Draft"
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={['img-a']}
					onOpenLightbox={onOpenLightbox}
					onToggleTabSaveToHistory={onToggleTabSaveToHistory}
				/>
			);
			const textarea = screen.getByPlaceholderText('Write your prompt here...');

			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
			fireEvent.keyDown(textarea, { key: 's', metaKey: true, shiftKey: true });

			expect(onOpenLightbox).not.toHaveBeenCalled();
			expect(onToggleTabSaveToHistory).not.toHaveBeenCalled();
		});

		it('should support Ctrl variants for footer keyboard shortcuts', () => {
			const onOpenLightbox = vi.fn();
			const onToggleTabSaveToHistory = vi.fn();

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Draft"
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={['img-a']}
					onOpenLightbox={onOpenLightbox}
					onToggleTabSaveToHistory={onToggleTabSaveToHistory}
				/>
			);
			const textarea = screen.getByPlaceholderText('Write your prompt here...');

			fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true, shiftKey: true });
			fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });

			expect(onOpenLightbox).toHaveBeenCalledWith('img-a', ['img-a'], 'staged');
			expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(1);
		});

		it('should ignore the lightbox shortcut when no staged image can be opened', () => {
			const onOpenLightbox = vi.fn();

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Draft"
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					onOpenLightbox={onOpenLightbox}
				/>
			);
			const textarea = screen.getByPlaceholderText('Write your prompt here...');

			fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true, shiftKey: true });

			expect(onOpenLightbox).not.toHaveBeenCalled();
		});
	});

	describe('Image attachments and staged previews', () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;

			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,loaded' } });
			}
		}

		it('should block pasted images when image attachment is unavailable', () => {
			const onImageAttachBlocked = vi.fn();
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					onImageAttachBlocked={onImageAttachBlocked}
				/>
			);
			const textarea = screen.getByPlaceholderText('Write your prompt here...');
			const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(pasteEvent, 'clipboardData', {
				value: {
					items: [{ type: 'image/png', getAsFile: () => new File(['img'], 'paste.png') }],
					getData: () => '',
				},
			});

			fireEvent(textarea, pasteEvent);

			expect(pasteEvent.defaultPrevented).toBe(true);
			expect(onImageAttachBlocked).toHaveBeenCalled();
			expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		});

		it('should load pasted and selected image files into staged images', () => {
			vi.stubGlobal('FileReader', MockFileReader);
			const setStagedImages = vi.fn();
			const clickInput = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
				/>
			);
			const textarea = screen.getByPlaceholderText('Write your prompt here...');

			fireEvent.paste(textarea, {
				clipboardData: {
					items: [{ type: 'image/png', getAsFile: () => new File(['img'], 'paste.png') }],
					getData: () => '',
				},
			});
			fireEvent.click(screen.getByTitle('Attach Image'));
			const input = container.querySelector('input[type="file"]') as HTMLInputElement;
			fireEvent.change(input, {
				target: {
					files: [new File(['img'], 'select.png', { type: 'image/png' })],
				},
			});

			expect(clickInput).toHaveBeenCalled();
			expect(setStagedImages).toHaveBeenCalledTimes(2);
			const pasteUpdater = setStagedImages.mock.calls[0][0] as (prev: string[]) => string[];
			const fileUpdater = setStagedImages.mock.calls[1][0] as (prev: string[]) => string[];
			expect(pasteUpdater(['existing'])).toEqual(['existing', 'data:image/png;base64,loaded']);
			expect(fileUpdater([])).toEqual(['data:image/png;base64,loaded']);
			expect(input.value).toBe('');
		});

		it('should skip non-image paste items before loading the pasted image', () => {
			vi.stubGlobal('FileReader', MockFileReader);
			const setStagedImages = vi.fn();
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
				/>
			);

			fireEvent.paste(screen.getByPlaceholderText('Write your prompt here...'), {
				clipboardData: {
					items: [
						{ type: 'text/html', getAsFile: () => null },
						{ type: 'image/png', getAsFile: () => new File(['img'], 'paste.png') },
					],
					getData: () => '',
				},
			});

			expect(setStagedImages).toHaveBeenCalledTimes(1);
		});

		it('should ignore pasted image items without files or reader data', () => {
			const setStagedImages = vi.fn();
			const nullFile = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
				/>
			);

			fireEvent.paste(screen.getByPlaceholderText('Write your prompt here...'), {
				clipboardData: {
					items: [{ type: 'image/png', getAsFile: () => null }],
					getData: () => '',
				},
			});
			expect(setStagedImages).not.toHaveBeenCalled();
			nullFile.unmount();

			class EmptyFileReader {
				onload: ((event: { target: { result: string } }) => void) | null = null;
				readAsDataURL() {
					this.onload?.({ target: { result: '' } });
				}
			}
			vi.stubGlobal('FileReader', EmptyFileReader);
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
				/>
			);

			fireEvent.paste(screen.getByPlaceholderText('Write your prompt here...'), {
				clipboardData: {
					items: [{ type: 'image/png', getAsFile: () => new File(['img'], 'paste.png') }],
					getData: () => '',
				},
			});
			expect(setStagedImages).not.toHaveBeenCalled();
		});

		it('should ignore selected image files when FileReader has no result', () => {
			class EmptyFileReader {
				onload: ((event: { target: { result: string } }) => void) | null = null;
				readAsDataURL() {
					this.onload?.({ target: { result: '' } });
				}
			}
			vi.stubGlobal('FileReader', EmptyFileReader);
			const setStagedImages = vi.fn();
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
				/>
			);
			const input = container.querySelector('input[type="file"]') as HTMLInputElement;

			fireEvent.change(input, {
				target: {
					files: [new File(['img'], 'select.png', { type: 'image/png' })],
				},
			});

			expect(setStagedImages).not.toHaveBeenCalled();
		});

		it('should leave selected image state unchanged when file input has no files', () => {
			const setStagedImages = vi.fn();
			const { container } = renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={[]}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
				/>
			);
			const input = container.querySelector('input[type="file"]') as HTMLInputElement;

			fireEvent.change(input, { target: { files: null } });

			expect(setStagedImages).not.toHaveBeenCalled();
		});

		it('should open and remove staged image previews with pointer and keyboard controls', () => {
			const onOpenLightbox = vi.fn();
			const setStagedImages = vi.fn();
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Review this"
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={['img-a', 'img-b']}
					setStagedImages={setStagedImages as React.Dispatch<React.SetStateAction<string[]>>}
					onOpenLightbox={onOpenLightbox}
				/>
			);
			const firstImage = screen.getByAltText('Prompt composer staged image 1');

			fireEvent.click(firstImage);
			fireEvent.keyDown(firstImage, { key: 'Enter' });
			fireEvent.keyDown(firstImage, { key: ' ' });
			fireEvent.keyDown(firstImage, { key: 'Escape' });
			const removeButton = screen.getAllByTestId('x-icon')[1].closest('button');
			expect(removeButton).not.toBeNull();
			fireEvent.click(removeButton!);

			expect(onOpenLightbox).toHaveBeenCalledWith('img-a', ['img-a', 'img-b'], 'staged');
			expect(onOpenLightbox).toHaveBeenCalledTimes(3);
			const updater = setStagedImages.mock.calls[0][0] as (prev: string[]) => string[];
			expect(updater(['img-a', 'img-b'])).toEqual(['img-b']);
		});

		it('should ignore unrelated staged image keyboard events', () => {
			const onOpenLightbox = vi.fn();
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Review this"
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={['img-a']}
					onOpenLightbox={onOpenLightbox}
				/>
			);

			fireEvent.keyDown(screen.getByAltText('Prompt composer staged image 1'), { key: 'a' });

			expect(onOpenLightbox).not.toHaveBeenCalled();
		});
	});

	describe('Footer controls and modal close controls', () => {
		it('should trigger footer toggles from buttons and keyboard shortcuts', () => {
			const onOpenLightbox = vi.fn();
			const onToggleTabSaveToHistory = vi.fn();
			const onToggleTabReadOnlyMode = vi.fn();
			const onToggleTabShowThinking = vi.fn();
			const onToggleEnterToSend = vi.fn();

			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Ask the team"
					onSubmit={onSubmit}
					onSend={onSend}
					stagedImages={['img-a']}
					tabSaveToHistory={true}
					onToggleTabSaveToHistory={onToggleTabSaveToHistory}
					tabReadOnlyMode={true}
					onToggleTabReadOnlyMode={onToggleTabReadOnlyMode}
					agentId="claude-code"
					tabShowThinking="sticky"
					supportsThinking={true}
					onToggleTabShowThinking={onToggleTabShowThinking}
					enterToSend={true}
					onToggleEnterToSend={onToggleEnterToSend}
					onOpenLightbox={onOpenLightbox}
				/>
			);
			const textarea = screen.getByPlaceholderText('Write your prompt here...');

			fireEvent.keyDown(textarea, { key: 'l', metaKey: true, shiftKey: true });
			fireEvent.keyDown(textarea, { key: 's', metaKey: true });
			fireEvent.keyDown(textarea, { key: 'r', ctrlKey: true });
			fireEvent.click(screen.getByRole('button', { name: /history/i }));
			fireEvent.click(screen.getByRole('button', { name: /plan-mode/i }));
			fireEvent.click(screen.getByRole('button', { name: /thinking/i }));
			fireEvent.click(screen.getByRole('button', { name: formatEnterToSend(true) }));

			expect(onOpenLightbox).toHaveBeenCalledWith('img-a', ['img-a'], 'staged');
			expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(2);
			expect(onToggleTabReadOnlyMode).toHaveBeenCalledTimes(2);
			expect(onToggleTabShowThinking).toHaveBeenCalledTimes(1);
			expect(onToggleEnterToSend).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId('pin-icon')).toBeInTheDocument();
		});

		it('should render inactive footer toggle labels and fallback read-only text', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					tabSaveToHistory={false}
					onToggleTabSaveToHistory={vi.fn()}
					tabReadOnlyMode={false}
					onToggleTabReadOnlyMode={vi.fn()}
					tabShowThinking="on"
					supportsThinking={true}
					onToggleTabShowThinking={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: /history/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /read-only/i })).toHaveAttribute(
				'title',
				"Toggle Read-Only mode (agent won't modify files)"
			);
			expect(screen.getByRole('button', { name: /thinking/i })).toHaveAttribute(
				'title',
				'Thinking (temporary) - Click for sticky mode'
			);
		});

		it('should render the off state for the thinking toggle', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue=""
					onSubmit={onSubmit}
					onSend={onSend}
					tabShowThinking="off"
					supportsThinking={true}
					onToggleTabShowThinking={vi.fn()}
				/>
			);

			const button = screen.getByRole('button', { name: /thinking/i });
			expect(button).toHaveAttribute('title', 'Show Thinking - Click to stream AI reasoning');
			expect(button).toHaveClass('opacity-40');
		});

		it('should save and close from the accessible backdrop button', () => {
			renderWithProvider(
				<PromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={mockTheme}
					initialValue="Backdrop draft"
					onSubmit={onSubmit}
					onSend={onSend}
				/>
			);

			fireEvent.click(screen.getByLabelText('Close prompt composer'));

			expect(onSubmit).toHaveBeenCalledWith('Backdrop draft');
			expect(onClose).toHaveBeenCalled();
		});
	});
});
