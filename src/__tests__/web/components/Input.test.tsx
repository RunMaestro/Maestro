/**
 * Tests for Input, TextArea, and InputGroup components
 *
 * Tests core behavior, props plumbing, and the Tailwind class tokens that
 * encode variant/size/error/disabled state. jsdom does not resolve Tailwind
 * classes to computed styles (no Tailwind CSS loaded in the test env), so
 * color/border checks are className-contains assertions against the
 * `--maestro-*`-backed tokens from `tailwind.config.mjs`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { Input, TextArea, InputGroup } from '../../../web/components/Input';

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

		it('applies custom style prop', () => {
			render(<Input style={{ marginTop: '10px' }} data-testid="input" />);
			expect(screen.getByTestId('input')).toHaveStyle({ marginTop: '10px' });
		});
	});

	describe('variants', () => {
		it('applies default variant classes', () => {
			render(<Input variant="default" data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('bg-bg-main');
			expect(input.className).toContain('text-text-main');
			expect(input.className).toContain('border-border');
		});

		it('applies filled variant classes', () => {
			render(<Input variant="filled" data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('bg-bg-activity');
			expect(input.className).toContain('border-transparent');
		});

		it('applies ghost variant classes', () => {
			render(<Input variant="ghost" data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('bg-transparent');
			expect(input.className).toContain('border-transparent');
		});

		it('uses default variant when none specified', () => {
			render(<Input data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('bg-bg-main');
		});

		it('handles unknown variant gracefully', () => {
			render(<Input variant={'unknown' as any} data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input).toBeInTheDocument();
			expect(input.className).not.toContain('bg-bg-main');
			expect(input.className).not.toContain('bg-bg-activity');
			expect(input.className).not.toContain('bg-transparent');
		});

		it('swaps border token to error when error flag is set', () => {
			render(<Input variant="default" error data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('border-error');
			expect(input.className).not.toContain('border-border');
		});

		it('swaps border on filled variant when error flag is set', () => {
			render(<Input variant="filled" error data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('border-error');
			expect(input.className).not.toContain('border-transparent');
		});
	});

	describe('sizes', () => {
		it('applies sm size classes', () => {
			render(<Input size="sm" data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('px-2');
			expect(input.className).toContain('py-1');
			expect(input.className).toContain('text-xs');
			expect(input.className).toContain('rounded');
			expect(input.className).not.toContain('rounded-md');
			expect(input.className).not.toContain('rounded-lg');
		});

		it('applies md size classes', () => {
			render(<Input size="md" data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('px-3');
			expect(input.className).toContain('py-1.5');
			expect(input.className).toContain('text-sm');
			expect(input.className).toContain('rounded-md');
		});

		it('applies lg size classes', () => {
			render(<Input size="lg" data-testid="input" />);
			const input = screen.getByTestId('input');
			expect(input.className).toContain('px-4');
			expect(input.className).toContain('py-2');
			expect(input.className).toContain('text-base');
			expect(input.className).toContain('rounded-lg');
		});

		it('uses md size as default', () => {
			render(<Input data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('rounded-md');
		});
	});

	describe('disabled state', () => {
		it('disables input when disabled prop is true', () => {
			render(<Input disabled data-testid="input" />);
			expect(screen.getByTestId('input')).toBeDisabled();
		});

		it('applies disabled utility classes', () => {
			render(<Input data-testid="input" />);
			const input = screen.getByTestId('input');
			// disabled:* utilities are always present; the disabled attribute activates them.
			expect(input.className).toContain('disabled:opacity-50');
			expect(input.className).toContain('disabled:cursor-not-allowed');
		});
	});

	describe('full width', () => {
		it('applies w-full class when fullWidth is true', () => {
			render(<Input fullWidth data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('w-full');
		});

		it('does not apply w-full when fullWidth is false', () => {
			render(<Input data-testid="input" />);
			expect(screen.getByTestId('input').className).not.toContain('w-full');
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

		it('applies left icon padding class for each size', () => {
			const { rerender } = render(
				<Input size="sm" leftIcon={<span>L</span>} data-testid="input" />
			);
			expect(screen.getByTestId('input').className).toContain('pl-7');

			rerender(<Input size="md" leftIcon={<span>L</span>} data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('pl-9');

			rerender(<Input size="lg" leftIcon={<span>L</span>} data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('pl-11');
		});

		it('applies right icon padding class for each size', () => {
			const { rerender } = render(
				<Input size="sm" rightIcon={<span>R</span>} data-testid="input" />
			);
			expect(screen.getByTestId('input').className).toContain('pr-7');

			rerender(<Input size="md" rightIcon={<span>R</span>} data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('pr-9');

			rerender(<Input size="lg" rightIcon={<span>R</span>} data-testid="input" />);
			expect(screen.getByTestId('input').className).toContain('pr-11');
		});

		it('applies text-text-dim to icon wrapper', () => {
			const { container } = render(
				<Input
					leftIcon={<span data-testid="left-icon">L</span>}
					rightIcon={<span data-testid="right-icon">R</span>}
				/>
			);
			const iconWrappers = container.querySelectorAll('.pointer-events-none');
			expect(iconWrappers.length).toBe(2);
			iconWrappers.forEach((wrapper) => {
				expect(wrapper.className).toContain('text-text-dim');
			});
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

	describe('variants', () => {
		it('applies default variant classes', () => {
			render(<TextArea variant="default" data-testid="textarea" />);
			const textarea = screen.getByTestId('textarea');
			expect(textarea.className).toContain('bg-bg-main');
			expect(textarea.className).toContain('border-border');
		});

		it('applies filled variant classes', () => {
			render(<TextArea variant="filled" data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('bg-bg-activity');
		});

		it('applies ghost variant classes', () => {
			render(<TextArea variant="ghost" data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('bg-transparent');
		});

		it('swaps border token to error when error flag is set', () => {
			render(<TextArea error data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('border-error');
		});
	});

	describe('sizes', () => {
		it('applies sm size classes', () => {
			render(<TextArea size="sm" data-testid="textarea" />);
			const textarea = screen.getByTestId('textarea');
			expect(textarea.className).toContain('px-2');
			expect(textarea.className).toContain('rounded');
		});

		it('applies md size classes', () => {
			render(<TextArea size="md" data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('rounded-md');
		});

		it('applies lg size classes', () => {
			render(<TextArea size="lg" data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('rounded-lg');
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

		it('applies min-height based on minRows and size (md)', () => {
			render(<TextArea size="md" minRows={4} data-testid="textarea" />);
			// 4 rows × 20px line height (md) = 80px
			expect(screen.getByTestId('textarea')).toHaveStyle({ minHeight: '80px' });
		});

		it('applies min-height based on minRows and size (sm)', () => {
			render(<TextArea size="sm" minRows={3} data-testid="textarea" />);
			// 3 rows × 16px line height (sm) = 48px
			expect(screen.getByTestId('textarea')).toHaveStyle({ minHeight: '48px' });
		});

		it('applies min-height based on minRows and size (lg)', () => {
			render(<TextArea size="lg" minRows={2} data-testid="textarea" />);
			// 2 rows × 24px line height (lg) = 48px
			expect(screen.getByTestId('textarea')).toHaveStyle({ minHeight: '48px' });
		});
	});

	describe('auto resize', () => {
		it('applies resize-none class when autoResize is true', () => {
			render(<TextArea autoResize data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('resize-none');
		});

		it('applies resize-y class when autoResize is false', () => {
			render(<TextArea autoResize={false} data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('resize-y');
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

		it('applies disabled utility classes', () => {
			render(<TextArea data-testid="textarea" />);
			const textarea = screen.getByTestId('textarea');
			expect(textarea.className).toContain('disabled:opacity-50');
			expect(textarea.className).toContain('disabled:cursor-not-allowed');
		});
	});

	describe('full width', () => {
		it('applies w-full class when fullWidth is true', () => {
			render(<TextArea fullWidth data-testid="textarea" />);
			expect(screen.getByTestId('textarea').className).toContain('w-full');
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

		it('sets aria-invalid based on error prop', () => {
			const { rerender } = render(<TextArea error data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toHaveAttribute('aria-invalid', 'true');

			rerender(<TextArea data-testid="textarea" />);
			expect(screen.getByTestId('textarea')).toHaveAttribute('aria-invalid', 'false');
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

		it('applies text-text-main to label', () => {
			render(
				<InputGroup label="Email">
					<Input />
				</InputGroup>
			);
			const label = screen.getByText('Email');
			expect(label.className).toContain('text-text-main');
		});

		it('renders helper text', () => {
			render(
				<InputGroup helperText="Enter your email">
					<Input data-testid="input" />
				</InputGroup>
			);
			const helper = screen.getByText('Enter your email');
			expect(helper).toBeInTheDocument();
			expect(helper.className).toContain('text-text-dim');
		});

		it('renders error message and hides helper text', () => {
			render(
				<InputGroup helperText="Enter your email" error="Invalid email">
					<Input data-testid="input" />
				</InputGroup>
			);
			const errorEl = screen.getByText('Invalid email');
			expect(errorEl).toBeInTheDocument();
			expect(errorEl.className).toContain('text-error');
			expect(screen.queryByText('Enter your email')).not.toBeInTheDocument();
		});

		it('renders required indicator with label', () => {
			render(
				<InputGroup label="Email" required>
					<Input data-testid="input" />
				</InputGroup>
			);
			const marker = screen.getByText('*');
			expect(marker).toBeInTheDocument();
			expect(marker.className).toContain('text-error');
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
