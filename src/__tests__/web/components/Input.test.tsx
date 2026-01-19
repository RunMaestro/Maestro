/**
 * Tests for Input, TextArea, and InputGroup components
 *
 * Tests core behavior and user interactions.
 * Implementation details (exact CSS classes, colors) are not tested.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { Input, TextArea, InputGroup } from '../../../web/components/Input';

// Mock the ThemeProvider
vi.mock('../../../web/components/ThemeProvider', () => ({
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: {
				bgMain: '#0b0b0d',
				bgSidebar: '#111113',
				bgActivity: '#1c1c1f',
				border: '#27272a',
				textMain: '#e4e4e7',
				textDim: '#a1a1aa',
				accent: '#6366f1',
				accentDim: 'rgba(99, 102, 241, 0.2)',
				accentText: '#a5b4fc',
				success: '#22c55e',
				warning: '#eab308',
				error: '#ef4444',
			},
		},
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('Input Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('rendering', () => {
		it('renders an input element', () => {
			render(<Input data-testid="input" />);
			expect(screen.getByTestId('input')).toBeInTheDocument();
		});

		it('renders with placeholder and value', () => {
			render(<Input placeholder="Enter text..." defaultValue="default" data-testid="input" />);
			expect(screen.getByPlaceholderText('Enter text...')).toBeInTheDocument();
			expect(screen.getByTestId('input')).toHaveValue('default');
		});

		it('passes through HTML attributes', () => {
			render(
				<Input id="test-id" type="email" name="email" className="custom" data-testid="input" />
			);
			const input = screen.getByTestId('input');
			expect(input).toHaveAttribute('id', 'test-id');
			expect(input).toHaveAttribute('type', 'email');
			expect(input.className).toContain('custom');
		});

		it('forwards ref', () => {
			const ref = React.createRef<HTMLInputElement>();
			render(<Input ref={ref} />);
			expect(ref.current).toBeInstanceOf(HTMLInputElement);
		});

		it('sets aria-invalid based on error prop', () => {
			const { rerender } = render(<Input error data-testid="input" />);
			expect(screen.getByTestId('input')).toHaveAttribute('aria-invalid', 'true');

			rerender(<Input data-testid="input" />);
			expect(screen.getByTestId('input')).toHaveAttribute('aria-invalid', 'false');
		});
	});

	describe('variants and sizes', () => {
		it('renders all variants', () => {
			const variants = ['default', 'filled', 'ghost'] as const;
			variants.forEach((variant) => {
				render(<Input variant={variant} data-testid="input" />);
				expect(screen.getByTestId('input')).toBeInTheDocument();
				cleanup();
			});
		});

		it('renders all sizes', () => {
			const sizes = ['sm', 'md', 'lg'] as const;
			sizes.forEach((size) => {
				render(<Input size={size} data-testid="input" />);
				expect(screen.getByTestId('input')).toBeInTheDocument();
				cleanup();
			});
		});

		it('handles unknown variant gracefully', () => {
			render(<Input variant={'unknown' as any} data-testid="input" />);
			expect(screen.getByTestId('input')).toBeInTheDocument();
		});
	});

	describe('disabled state', () => {
		it('disables input when disabled prop is true', () => {
			render(<Input disabled data-testid="input" />);
			expect(screen.getByTestId('input')).toBeDisabled();
		});
	});

	describe('full width', () => {
		it('applies full width when fullWidth is true', () => {
			render(<Input fullWidth data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('w-full');
		});
	});

	describe('icons', () => {
		it('renders left and right icons', () => {
			render(
				<Input
					leftIcon={<span data-testid="left-icon">L</span>}
					rightIcon={<span data-testid="right-icon">R</span>}
					data-testid="input"
				/>
			);
			expect(screen.getByTestId('left-icon')).toBeInTheDocument();
			expect(screen.getByTestId('right-icon')).toBeInTheDocument();
		});

		it('wraps input with icons in container', () => {
			const { container } = render(<Input leftIcon={<span>L</span>} data-testid="input" />);
			expect(container.querySelector('.relative.inline-flex')).toBeInTheDocument();
		});
	});

	describe('event handling', () => {
		it('calls event handlers', () => {
			const handlers = {
				onChange: vi.fn(),
				onFocus: vi.fn(),
				onBlur: vi.fn(),
				onKeyDown: vi.fn(),
			};
			render(<Input {...handlers} data-testid="input" />);
			const input = screen.getByTestId('input');

			fireEvent.change(input, { target: { value: 'test' } });
			fireEvent.focus(input);
			fireEvent.blur(input);
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(handlers.onChange).toHaveBeenCalled();
			expect(handlers.onFocus).toHaveBeenCalled();
			expect(handlers.onBlur).toHaveBeenCalled();
			expect(handlers.onKeyDown).toHaveBeenCalled();
		});
	});

	describe('input types', () => {
		it('supports various input types', () => {
			const types = ['text', 'password', 'email', 'number', 'search', 'tel', 'url'] as const;
			types.forEach((type) => {
				render(<Input type={type} data-testid="input" />);
				expect(screen.getByTestId('input')).toHaveAttribute('type', type);
				cleanup();
			});
		});
	});

	describe('accessibility', () => {
		it('is focusable and supports aria attributes', () => {
			render(<Input aria-label="Search field" required data-testid="input" />);
			const input = screen.getByTestId('input');
			input.focus();
			expect(document.activeElement).toBe(input);
			expect(screen.getByLabelText('Search field')).toBeInTheDocument();
			expect(input).toBeRequired();
		});
	});
});

describe('TextArea Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('rendering', () => {
		it('renders a textarea element', () => {
			render(<TextArea data-testid="textarea" />);
			expect(screen.getByTestId('textarea').tagName).toBe('TEXTAREA');
		});

		it('renders with placeholder and value', () => {
			render(
				<TextArea placeholder="Enter message..." defaultValue="text" data-testid="textarea" />
			);
			expect(screen.getByPlaceholderText('Enter message...')).toBeInTheDocument();
			expect(screen.getByTestId('textarea')).toHaveValue('text');
		});

		it('forwards ref', () => {
			const ref = React.createRef<HTMLTextAreaElement>();
			render(<TextArea ref={ref} />);
			expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
		});
	});

	describe('variants and sizes', () => {
		it('renders all variants', () => {
			const variants = ['default', 'filled', 'ghost'] as const;
			variants.forEach((variant) => {
				render(<TextArea variant={variant} data-testid="textarea" />);
				expect(screen.getByTestId('textarea')).toBeInTheDocument();
				cleanup();
			});
		});

		it('renders all sizes', () => {
			const sizes = ['sm', 'md', 'lg'] as const;
			sizes.forEach((size) => {
				render(<TextArea size={size} data-testid="textarea" />);
				expect(screen.getByTestId('textarea')).toBeInTheDocument();
				cleanup();
			});
		});
	});

	describe('rows configuration', () => {
		it('applies minRows', () => {
			render(<TextArea minRows={5} data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toHaveAttribute('rows', '5');
		});

		it('defaults to 3 rows', () => {
			render(<TextArea data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toHaveAttribute('rows', '3');
		});
	});

	describe('auto resize', () => {
		it('sets resize to none when autoResize is true', () => {
			render(<TextArea autoResize data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toHaveStyle({ resize: 'none' });
		});

		it('sets resize to vertical when autoResize is false', () => {
			render(<TextArea autoResize={false} data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toHaveStyle({ resize: 'vertical' });
		});

		it('triggers resize on input', () => {
			const handleInput = vi.fn();
			render(<TextArea autoResize onInput={handleInput} data-testid="textarea" />);
			fireEvent.input(screen.getByTestId('textarea'), { target: { value: 'test' } });
			expect(handleInput).toHaveBeenCalled();
		});
	});

	describe('disabled state', () => {
		it('disables textarea when disabled prop is true', () => {
			render(<TextArea disabled data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toBeDisabled();
		});
	});

	describe('accessibility', () => {
		it('is focusable and supports aria attributes', () => {
			render(<TextArea aria-label="Message input" required data-testid="textarea" />);
			const textarea = screen.getByTestId('textarea');
			textarea.focus();
			expect(document.activeElement).toBe(textarea);
			expect(screen.getByLabelText('Message input')).toBeInTheDocument();
			expect(textarea).toBeRequired();
		});
	});
});

describe('InputGroup Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('rendering', () => {
		it('renders children', () => {
			render(
				<InputGroup>
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(screen.getByTestId('input')).toBeInTheDocument();
		});

		it('renders with label', () => {
			render(
				<InputGroup label="Email">
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(screen.getByText('Email')).toBeInTheDocument();
		});

		it('renders helper text', () => {
			render(
				<InputGroup helperText="Enter your email">
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(screen.getByText('Enter your email')).toBeInTheDocument();
		});

		it('renders error message and hides helper text', () => {
			render(
				<InputGroup helperText="Enter your email" error="Invalid email">
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(screen.getByText('Invalid email')).toBeInTheDocument();
			expect(screen.queryByText('Enter your email')).not.toBeInTheDocument();
		});

		it('renders required indicator with label', () => {
			render(
				<InputGroup label="Email" required>
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(screen.getByText('*')).toBeInTheDocument();
		});

		it('does not render required indicator without label', () => {
			render(
				<InputGroup required>
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(screen.queryByText('*')).not.toBeInTheDocument();
		});
	});

	describe('custom styling', () => {
		it('applies custom className', () => {
			const { container } = render(
				<InputGroup className="custom-class">
					<Input data-testid="input" />
				</InputGroup>
			);
			expect(container.firstChild).toHaveClass('custom-class');
		});
	});

	describe('with TextArea', () => {
		it('works with TextArea children', () => {
			render(
				<InputGroup label="Message" helperText="Max 500 characters">
					<TextArea data-testid="textarea" />
				</InputGroup>
			);
			expect(screen.getByText('Message')).toBeInTheDocument();
			expect(screen.getByTestId('textarea')).toBeInTheDocument();
		});
	});
});
