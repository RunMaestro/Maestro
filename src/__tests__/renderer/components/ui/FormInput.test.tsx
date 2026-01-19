/**
 * Tests for FormInput component
 *
 * The FormInput component provides consistent themed form inputs with
 * built-in label, validation, and keyboard handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { FormInput } from '../../../../renderer/components/ui/FormInput';
import type { Theme } from '../../../../renderer/types';

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

describe('FormInput', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('should render input with required props', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="test value" onChange={onChange} />);

			const input = screen.getByRole('textbox');
			expect(input).toBeInTheDocument();
			expect(input).toHaveValue('test value');
		});

		it('should render with label when provided', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} label="Agent Name" />);

			expect(screen.getByText('Agent Name')).toBeInTheDocument();
			expect(screen.getByLabelText('Agent Name')).toBeInTheDocument();
		});

		it('should render with placeholder when provided', () => {
			const onChange = vi.fn();

			render(
				<FormInput theme={mockTheme} value="" onChange={onChange} placeholder="Enter name..." />
			);

			expect(screen.getByPlaceholderText('Enter name...')).toBeInTheDocument();
		});

		it('should render with helper text when provided', () => {
			const onChange = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value=""
					onChange={onChange}
					helperText="This field is required"
				/>
			);

			expect(screen.getByText('This field is required')).toBeInTheDocument();
		});

		it('should render error message when provided', () => {
			const onChange = vi.fn();

			render(
				<FormInput theme={mockTheme} value="" onChange={onChange} error="Name already exists" />
			);

			const errorMsg = screen.getByText('Name already exists');
			expect(errorMsg).toBeInTheDocument();
			expect(errorMsg).toHaveStyle({ color: mockTheme.colors.error });
		});

		it('should hide helper text when error is shown', () => {
			const onChange = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value=""
					onChange={onChange}
					helperText="Helper text"
					error="Error message"
				/>
			);

			expect(screen.getByText('Error message')).toBeInTheDocument();
			expect(screen.queryByText('Helper text')).not.toBeInTheDocument();
		});

		it('should render addon content when provided', () => {
			const onChange = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value=""
					onChange={onChange}
					addon={<button data-testid="addon-button">Browse</button>}
				/>
			);

			expect(screen.getByTestId('addon-button')).toBeInTheDocument();
		});

		it('should apply testId when provided', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} testId="my-form-input" />);

			expect(screen.getByTestId('my-form-input')).toBeInTheDocument();
		});

		it('should apply custom id when provided', () => {
			const onChange = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value=""
					onChange={onChange}
					id="custom-input-id"
					label="My Input"
				/>
			);

			const input = screen.getByLabelText('My Input');
			expect(input).toHaveAttribute('id', 'custom-input-id');
		});
	});

	describe('styling', () => {
		it('should apply theme border color normally', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('should apply error border color when error is provided', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} error="Invalid input" />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveStyle({ borderColor: mockTheme.colors.error });
		});

		it('should apply monospace font when monospace is true', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} monospace={true} />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveClass('font-mono');
		});

		it('should apply custom className when provided', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} className="custom-class" />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveClass('custom-class');
		});

		it('should apply custom height class when provided', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} heightClass="h-16" />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveClass('h-16');
		});

		it('should apply label styling correctly', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} label="Test Label" />);

			const label = screen.getByText('Test Label');
			expect(label).toHaveClass('uppercase', 'font-bold', 'text-xs');
			expect(label).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('should apply disabled styling when disabled is true', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} disabled={true} />);

			const input = screen.getByRole('textbox');
			expect(input).toBeDisabled();
			expect(input).toHaveClass('opacity-50', 'cursor-not-allowed');
		});
	});

	describe('interactions', () => {
		it('should call onChange when value changes', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} />);

			const input = screen.getByRole('textbox');
			fireEvent.change(input, { target: { value: 'new value' } });

			expect(onChange).toHaveBeenCalledWith('new value');
		});

		it('should call onSubmit when Enter is pressed', () => {
			const onChange = vi.fn();
			const onSubmit = vi.fn();

			render(<FormInput theme={mockTheme} value="test" onChange={onChange} onSubmit={onSubmit} />);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSubmit).toHaveBeenCalledTimes(1);
		});

		it('should NOT call onSubmit when submitEnabled is false', () => {
			const onChange = vi.fn();
			const onSubmit = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value="test"
					onChange={onChange}
					onSubmit={onSubmit}
					submitEnabled={false}
				/>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('should call custom onKeyDown before Enter handling', () => {
			const onChange = vi.fn();
			const onSubmit = vi.fn();
			const onKeyDown = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value="test"
					onChange={onChange}
					onSubmit={onSubmit}
					onKeyDown={onKeyDown}
				/>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onKeyDown).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledTimes(1);
		});

		it('should NOT call onSubmit if custom onKeyDown prevents default', () => {
			const onChange = vi.fn();
			const onSubmit = vi.fn();
			const onKeyDown = vi.fn((e) => e.preventDefault());

			render(
				<FormInput
					theme={mockTheme}
					value="test"
					onChange={onChange}
					onSubmit={onSubmit}
					onKeyDown={onKeyDown}
				/>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onKeyDown).toHaveBeenCalledTimes(1);
			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('should NOT call onSubmit for non-Enter keys', () => {
			const onChange = vi.fn();
			const onSubmit = vi.fn();

			render(<FormInput theme={mockTheme} value="test" onChange={onChange} onSubmit={onSubmit} />);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Escape' });
			fireEvent.keyDown(input, { key: 'Tab' });
			fireEvent.keyDown(input, { key: 'a' });

			expect(onSubmit).not.toHaveBeenCalled();
		});
	});

	describe('focus management', () => {
		it('should forward ref to input element', () => {
			const onChange = vi.fn();
			const ref = React.createRef<HTMLInputElement>();

			render(<FormInput ref={ref} theme={mockTheme} value="" onChange={onChange} />);

			expect(ref.current).toBeInstanceOf(HTMLInputElement);
			expect(ref.current).toBe(screen.getByRole('textbox'));
		});

		it('should select text on focus when selectOnFocus is true', () => {
			const onChange = vi.fn();

			render(
				<FormInput theme={mockTheme} value="select me" onChange={onChange} selectOnFocus={true} />
			);

			const input = screen.getByRole('textbox') as HTMLInputElement;

			// Mock the select method
			const selectMock = vi.fn();
			input.select = selectMock;

			fireEvent.focus(input);

			expect(selectMock).toHaveBeenCalledTimes(1);
		});

		it('should NOT select text on focus when selectOnFocus is false', () => {
			const onChange = vi.fn();

			render(
				<FormInput
					theme={mockTheme}
					value="don't select"
					onChange={onChange}
					selectOnFocus={false}
				/>
			);

			const input = screen.getByRole('textbox') as HTMLInputElement;

			const selectMock = vi.fn();
			input.select = selectMock;

			fireEvent.focus(input);

			expect(selectMock).not.toHaveBeenCalled();
		});
	});

	describe('input types', () => {
		it('should support password type', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="secret" onChange={onChange} type="password" />);

			const input = screen.getByDisplayValue('secret');
			expect(input).toHaveAttribute('type', 'password');
		});

		it('should support email type', () => {
			const onChange = vi.fn();

			render(
				<FormInput theme={mockTheme} value="test@example.com" onChange={onChange} type="email" />
			);

			const input = screen.getByDisplayValue('test@example.com');
			expect(input).toHaveAttribute('type', 'email');
		});

		it('should default to text type', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveAttribute('type', 'text');
		});
	});

	describe('accessibility', () => {
		it('should associate label with input via htmlFor', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} label="Email Address" />);

			const label = screen.getByText('Email Address');
			const input = screen.getByLabelText('Email Address');

			expect(label).toHaveAttribute('for', input.id);
		});

		it('should generate unique id if not provided', () => {
			const onChange = vi.fn();

			const { rerender } = render(
				<FormInput theme={mockTheme} value="" onChange={onChange} label="First" />
			);

			const firstInput = screen.getByLabelText('First');
			const firstId = firstInput.id;
			expect(firstId).toBeTruthy();
			expect(firstId).toContain(':');

			// Render a second one
			rerender(
				<>
					<FormInput theme={mockTheme} value="" onChange={onChange} label="First" />
					<FormInput theme={mockTheme} value="" onChange={onChange} label="Second" />
				</>
			);

			// Both should have unique IDs
			const inputs = screen.getAllByRole('textbox');
			expect(inputs[0].id).toBeTruthy();
			expect(inputs[1].id).toBeTruthy();
			expect(inputs[0].id).not.toBe(inputs[1].id);
		});
	});

	describe('layout with addon', () => {
		it('should render input and addon in flex container', () => {
			const onChange = vi.fn();

			const { container } = render(
				<FormInput theme={mockTheme} value="" onChange={onChange} addon={<button>Icon</button>} />
			);

			const flexContainer = container.querySelector('.flex.gap-2');
			expect(flexContainer).toBeInTheDocument();
		});

		it('should apply flex-1 to input when addon is present', () => {
			const onChange = vi.fn();

			render(
				<FormInput theme={mockTheme} value="" onChange={onChange} addon={<button>Icon</button>} />
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveClass('flex-1');
		});

		it('should apply w-full to input when no addon', () => {
			const onChange = vi.fn();

			render(<FormInput theme={mockTheme} value="" onChange={onChange} />);

			const input = screen.getByRole('textbox');
			expect(input).toHaveClass('w-full');
		});
	});
});
