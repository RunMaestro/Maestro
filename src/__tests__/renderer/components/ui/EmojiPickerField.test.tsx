/**
 * Tests for EmojiPickerField component
 *
 * The EmojiPickerField component provides a themed emoji selector with
 * a picker overlay, used in group modals for selecting group icons.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { EmojiPickerField } from '../../../../renderer/components/ui/EmojiPickerField';
import type { Theme } from '../../../../renderer/types';

// Mock emoji-mart to avoid loading actual emoji data in tests
vi.mock('@emoji-mart/data', () => ({
	default: {},
}));

vi.mock('@emoji-mart/react', () => ({
	default: ({
		onEmojiSelect,
		autoFocus,
	}: {
		onEmojiSelect: (emoji: { native: string }) => void;
		autoFocus?: boolean;
	}) => (
		<div data-testid="emoji-picker-mock">
			<button
				onClick={() => onEmojiSelect({ native: '🎉' })}
				data-testid="emoji-option"
				autoFocus={autoFocus}
			>
				Select party emoji
			</button>
		</div>
	),
}));

// Mock theme for testing
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
		cursor: '#ffffff',
		terminalBg: '#1a1a1a',
	},
};

describe('EmojiPickerField', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('rendering', () => {
		it('should render emoji button with current value', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toBeInTheDocument();
			expect(button).toHaveTextContent('📂');
		});

		it('should render with default label "Icon"', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			expect(screen.getByText('Icon')).toBeInTheDocument();
		});

		it('should render with custom label when provided', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} label="Group Icon" />
			);

			expect(screen.getByText('Group Icon')).toBeInTheDocument();
		});

		it('should apply data-testid when provided', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			expect(screen.getByTestId('emoji-field')).toBeInTheDocument();
			expect(screen.getByTestId('emoji-field-button')).toBeInTheDocument();
		});

		it('should not show picker overlay initially', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});
	});

	describe('disabled state', () => {
		it('should disable button when disabled prop is true', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} disabled />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toBeDisabled();
		});

		it('should not open picker when disabled', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					disabled
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByRole('button', { name: /select emoji/i });
			fireEvent.click(button);

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should apply opacity styling when disabled', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} disabled />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveStyle({ opacity: '0.5' });
		});
	});

	describe('picker interactions', () => {
		it('should open picker overlay when button is clicked', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);

			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();
			expect(screen.getByTestId('emoji-picker-mock')).toBeInTheDocument();
		});

		it('should call onOpen when picker opens', () => {
			const onChange = vi.fn();
			const onOpen = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onOpen={onOpen}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);

			expect(onOpen).toHaveBeenCalledTimes(1);
		});

		it('should close picker when backdrop is clicked', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Click backdrop (the overlay itself)
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should close picker when close button is clicked', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Click close button
			const closeButton = screen.getByTestId('emoji-field-close');
			fireEvent.click(closeButton);

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should close picker when Escape key is pressed', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should call onClose when picker closes via backdrop', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via backdrop
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when picker closes via close button', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via close button
			fireEvent.click(screen.getByTestId('emoji-field-close'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when picker closes via Escape', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Press Escape
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('emoji selection', () => {
		it('should call onChange with selected emoji', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Select emoji (from mock)
			fireEvent.click(screen.getByTestId('emoji-option'));

			expect(onChange).toHaveBeenCalledWith('🎉');
		});

		it('should close picker after emoji selection', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Select emoji
			fireEvent.click(screen.getByTestId('emoji-option'));

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should call onClose after emoji selection', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Select emoji
			fireEvent.click(screen.getByTestId('emoji-option'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus restoration', () => {
		it('should restore focus to restoreFocusRef after closing via backdrop', async () => {
			const onChange = vi.fn();
			const inputRef = React.createRef<HTMLInputElement>();

			render(
				<div>
					<input ref={inputRef} data-testid="target-input" />
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						restoreFocusRef={inputRef}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via backdrop
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			// Run timers to allow focus restoration
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.getByTestId('target-input')).toHaveFocus();
		});

		it('should restore focus to restoreFocusRef after emoji selection', async () => {
			const onChange = vi.fn();
			const inputRef = React.createRef<HTMLInputElement>();

			render(
				<div>
					<input ref={inputRef} data-testid="target-input" />
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						restoreFocusRef={inputRef}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Select emoji
			fireEvent.click(screen.getByTestId('emoji-option'));

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.getByTestId('target-input')).toHaveFocus();
		});

		it('should restore focus to restoreFocusRef after Escape', async () => {
			const onChange = vi.fn();
			const inputRef = React.createRef<HTMLInputElement>();

			render(
				<div>
					<input ref={inputRef} data-testid="target-input" />
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						restoreFocusRef={inputRef}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Press Escape
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.getByTestId('target-input')).toHaveFocus();
		});

		it('should handle missing restoreFocusRef gracefully', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via backdrop (should not throw)
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			// Should complete without error
			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('should have correct aria attributes on button', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveAttribute('aria-haspopup', 'dialog');
			expect(button).toHaveAttribute('aria-expanded', 'false');
		});

		it('should update aria-expanded when picker opens', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveAttribute('aria-expanded', 'false');

			fireEvent.click(button);
			expect(button).toHaveAttribute('aria-expanded', 'true');
		});

		it('should have dialog role on overlay', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			const overlay = screen.getByRole('dialog');
			expect(overlay).toBeInTheDocument();
			expect(overlay).toHaveAttribute('aria-modal', 'true');
			expect(overlay).toHaveAttribute('aria-label', 'Emoji picker');
		});

		it('should have accessible close button', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			const closeButton = screen.getByRole('button', { name: /close emoji picker/i });
			expect(closeButton).toBeInTheDocument();
		});
	});

	describe('theming', () => {
		it('should apply theme border color to button', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveStyle({ borderColor: '#333333' });
		});

		it('should apply theme colors to label', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} label="Test Label" />
			);

			const label = screen.getByText('Test Label');
			expect(label).toHaveStyle({ color: '#ffffff' });
		});
	});

	describe('toggle behavior', () => {
		it('should toggle picker closed when button clicked while open', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByTestId('emoji-field-button');

			// Open
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Toggle closed
			fireEvent.click(button);
			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});
	});

	describe('event propagation', () => {
		it('should stop propagation on picker container click', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Click on picker container (not backdrop) should not close
			fireEvent.click(screen.getByTestId('emoji-picker-mock'));

			// Should still be open
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();
		});

		it('should stop escape propagation to prevent parent handlers', () => {
			const onChange = vi.fn();
			const parentEscapeHandler = vi.fn();

			render(
				<div onKeyDown={(e) => e.key === 'Escape' && parentEscapeHandler()}>
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Press Escape on overlay
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			// Parent should not receive event
			expect(parentEscapeHandler).not.toHaveBeenCalled();
		});
	});

	describe('custom button className', () => {
		it('should apply custom buttonClassName when provided', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					buttonClassName="custom-emoji-button"
				/>
			);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveClass('custom-emoji-button');
		});
	});
});
