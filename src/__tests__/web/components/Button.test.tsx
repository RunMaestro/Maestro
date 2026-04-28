/**
 * Tests for Button and IconButton components
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import {
	Button,
	IconButton,
	type ButtonVariant,
	type ButtonSize,
	type ButtonProps,
	type IconButtonProps,
} from '../../../web/components/Button';

describe('Button Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with children text', () => {
			render(<Button>Click me</Button>);
			expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
		});

		it('renders without children', () => {
			render(<Button />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('renders with default props', () => {
			render(<Button>Default Button</Button>);
			const button = screen.getByRole('button');
			expect(button).toBeInTheDocument();
			expect(button).not.toBeDisabled();
		});

		it('passes through HTML button attributes', () => {
			render(
				<Button id="test-id" data-testid="test-button" type="submit">
					Submit
				</Button>
			);
			const button = screen.getByTestId('test-button');
			expect(button).toHaveAttribute('id', 'test-id');
			expect(button).toHaveAttribute('type', 'submit');
		});

		it('applies custom className', () => {
			render(<Button className="custom-class">Styled</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('custom-class');
		});

		it('applies custom style', () => {
			render(<Button style={{ marginTop: '10px' }}>Styled</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ marginTop: '10px' });
		});

		it('forwards ref to button element', () => {
			const ref = React.createRef<HTMLButtonElement>();
			render(<Button ref={ref}>Ref Button</Button>);
			expect(ref.current).toBeInstanceOf(HTMLButtonElement);
			expect(ref.current?.textContent).toContain('Ref Button');
		});
	});

	describe('Variants', () => {
		const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'success'];

		variants.forEach((variant) => {
			it(`renders ${variant} variant`, () => {
				render(<Button variant={variant}>{variant} Button</Button>);
				const button = screen.getByRole('button');
				expect(button).toBeInTheDocument();
			});
		});

		it('applies primary variant classes', () => {
			render(<Button variant="primary">Primary</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-accent');
			expect(button.className).toContain('text-white');
		});

		it('applies secondary variant classes', () => {
			render(<Button variant="secondary">Secondary</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-bg-activity');
			expect(button.className).toContain('text-text-main');
			expect(button.className).toContain('border-border');
		});

		it('applies ghost variant classes', () => {
			render(<Button variant="ghost">Ghost</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-transparent');
			expect(button.className).toContain('text-text-main');
			expect(button.className).toContain('border-transparent');
		});

		it('applies danger variant classes', () => {
			render(<Button variant="danger">Danger</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-error');
			expect(button.className).toContain('text-white');
		});

		it('applies success variant classes', () => {
			render(<Button variant="success">Success</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-success');
			expect(button.className).toContain('text-white');
		});

		it('uses primary variant as default', () => {
			render(<Button>Default Variant</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-accent');
		});

		it('handles unknown variant gracefully (default case)', () => {
			// Cast to any to test the default fallback for an unknown variant
			render(<Button variant={'unknown' as any}>Unknown</Button>);
			const button = screen.getByRole('button');
			// Should still render without error and without any of the known variant background tokens
			expect(button).toBeInTheDocument();
			expect(button.className).not.toContain('bg-accent');
			expect(button.className).not.toContain('bg-bg-activity');
			expect(button.className).not.toContain('bg-error');
			expect(button.className).not.toContain('bg-success');
		});
	});

	describe('Sizes', () => {
		const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

		sizes.forEach((size) => {
			it(`renders ${size} size`, () => {
				render(<Button size={size}>{size} Button</Button>);
				const button = screen.getByRole('button');
				expect(button).toBeInTheDocument();
			});
		});

		it('applies sm size border radius class', () => {
			render(<Button size="sm">Small</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('rounded');
			expect(button.className).not.toContain('rounded-md');
			expect(button.className).not.toContain('rounded-lg');
		});

		it('applies md size border radius class', () => {
			render(<Button size="md">Medium</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('rounded-md');
		});

		it('applies lg size border radius class', () => {
			render(<Button size="lg">Large</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('rounded-lg');
		});

		it('uses md size as default', () => {
			render(<Button>Default Size</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('rounded-md');
		});

		it('applies correct size class for sm', () => {
			render(<Button size="sm">Small</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('px-2');
			expect(button.className).toContain('py-1');
			expect(button.className).toContain('text-xs');
		});

		it('applies correct size class for md', () => {
			render(<Button size="md">Medium</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('px-3');
			expect(button.className).toContain('py-1.5');
			expect(button.className).toContain('text-sm');
		});

		it('applies correct size class for lg', () => {
			render(<Button size="lg">Large</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('px-4');
			expect(button.className).toContain('py-2');
			expect(button.className).toContain('text-base');
		});
	});

	describe('Disabled State', () => {
		it('disables button when disabled prop is true', () => {
			render(<Button disabled>Disabled</Button>);
			expect(screen.getByRole('button')).toBeDisabled();
		});

		it('applies disabled utility classes', () => {
			render(<Button disabled>Disabled</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('disabled:opacity-50');
			expect(button.className).toContain('disabled:cursor-not-allowed');
		});

		it('applies cursor-pointer class when enabled', () => {
			render(<Button>Enabled</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('cursor-pointer');
		});

		it('prevents click when disabled', () => {
			const handleClick = vi.fn();
			render(
				<Button disabled onClick={handleClick}>
					Disabled
				</Button>
			);
			fireEvent.click(screen.getByRole('button'));
			expect(handleClick).not.toHaveBeenCalled();
		});
	});

	describe('Loading State', () => {
		it('disables button when loading', () => {
			render(<Button loading>Loading</Button>);
			expect(screen.getByRole('button')).toBeDisabled();
		});

		it('renders loading spinner when loading', () => {
			render(<Button loading>Loading</Button>);
			const button = screen.getByRole('button');
			const svg = button.querySelector('svg');
			expect(svg).toBeInTheDocument();
			expect(svg?.classList.contains('animate-spin')).toBe(true);
		});

		it('sets aria-busy when loading', () => {
			render(<Button loading>Loading</Button>);
			expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
		});

		it('does not set aria-busy when not loading', () => {
			render(<Button>Not Loading</Button>);
			expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'false');
		});

		it('marks the loading button as disabled so disabled: variants kick in', () => {
			render(<Button loading>Loading</Button>);
			const button = screen.getByRole('button');
			expect(button).toBeDisabled();
			// disabled:* utilities are present in the class list and resolve via the
			// HTML disabled attribute set above; jsdom does not compute the styles.
			expect(button.className).toContain('disabled:opacity-50');
			expect(button.className).toContain('disabled:cursor-not-allowed');
		});

		it('prevents click when loading', () => {
			const handleClick = vi.fn();
			render(
				<Button loading onClick={handleClick}>
					Loading
				</Button>
			);
			fireEvent.click(screen.getByRole('button'));
			expect(handleClick).not.toHaveBeenCalled();
		});

		it('hides left icon when loading', () => {
			render(
				<Button loading leftIcon={<span data-testid="left-icon">L</span>}>
					Loading
				</Button>
			);
			expect(screen.queryByTestId('left-icon')).not.toBeInTheDocument();
		});

		it('hides right icon when loading', () => {
			render(
				<Button loading rightIcon={<span data-testid="right-icon">R</span>}>
					Loading
				</Button>
			);
			expect(screen.queryByTestId('right-icon')).not.toBeInTheDocument();
		});
	});

	describe('Loading Spinner Sizes', () => {
		it('renders small spinner for sm size', () => {
			render(
				<Button loading size="sm">
					Loading
				</Button>
			);
			const svg = screen.getByRole('button').querySelector('svg');
			expect(svg).toHaveAttribute('width', '12');
			expect(svg).toHaveAttribute('height', '12');
		});

		it('renders medium spinner for md size', () => {
			render(
				<Button loading size="md">
					Loading
				</Button>
			);
			const svg = screen.getByRole('button').querySelector('svg');
			expect(svg).toHaveAttribute('width', '14');
			expect(svg).toHaveAttribute('height', '14');
		});

		it('renders large spinner for lg size', () => {
			render(
				<Button loading size="lg">
					Loading
				</Button>
			);
			const svg = screen.getByRole('button').querySelector('svg');
			expect(svg).toHaveAttribute('width', '16');
			expect(svg).toHaveAttribute('height', '16');
		});
	});

	describe('Icons', () => {
		it('renders left icon', () => {
			render(<Button leftIcon={<span data-testid="left-icon">←</span>}>With Left Icon</Button>);
			expect(screen.getByTestId('left-icon')).toBeInTheDocument();
		});

		it('renders right icon', () => {
			render(<Button rightIcon={<span data-testid="right-icon">→</span>}>With Right Icon</Button>);
			expect(screen.getByTestId('right-icon')).toBeInTheDocument();
		});

		it('renders both left and right icons', () => {
			render(
				<Button
					leftIcon={<span data-testid="left-icon">←</span>}
					rightIcon={<span data-testid="right-icon">→</span>}
				>
					With Both Icons
				</Button>
			);
			expect(screen.getByTestId('left-icon')).toBeInTheDocument();
			expect(screen.getByTestId('right-icon')).toBeInTheDocument();
		});

		it('wraps icons in flex-shrink-0 span', () => {
			render(<Button leftIcon={<span data-testid="icon">I</span>}>Icon Button</Button>);
			const wrapper = screen.getByTestId('icon').parentElement;
			expect(wrapper?.className).toContain('flex-shrink-0');
		});
	});

	describe('Full Width', () => {
		it('applies w-full class when fullWidth is true', () => {
			render(<Button fullWidth>Full Width</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('w-full');
		});

		it('does not apply full width by default', () => {
			render(<Button>Normal Width</Button>);
			const button = screen.getByRole('button');
			expect(button.className).not.toContain('w-full');
		});
	});

	describe('Event Handling', () => {
		it('calls onClick handler when clicked', () => {
			const handleClick = vi.fn();
			render(<Button onClick={handleClick}>Click me</Button>);
			fireEvent.click(screen.getByRole('button'));
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it('passes event to onClick handler', () => {
			const handleClick = vi.fn();
			render(<Button onClick={handleClick}>Click me</Button>);
			fireEvent.click(screen.getByRole('button'));
			expect(handleClick).toHaveBeenCalledWith(expect.any(Object));
		});

		it('calls onMouseEnter handler', () => {
			const handleMouseEnter = vi.fn();
			render(<Button onMouseEnter={handleMouseEnter}>Hover</Button>);
			fireEvent.mouseEnter(screen.getByRole('button'));
			expect(handleMouseEnter).toHaveBeenCalledTimes(1);
		});

		it('calls onMouseLeave handler', () => {
			const handleMouseLeave = vi.fn();
			render(<Button onMouseLeave={handleMouseLeave}>Hover</Button>);
			fireEvent.mouseLeave(screen.getByRole('button'));
			expect(handleMouseLeave).toHaveBeenCalledTimes(1);
		});

		it('calls onFocus handler', () => {
			const handleFocus = vi.fn();
			render(<Button onFocus={handleFocus}>Focus</Button>);
			fireEvent.focus(screen.getByRole('button'));
			expect(handleFocus).toHaveBeenCalledTimes(1);
		});

		it('calls onBlur handler', () => {
			const handleBlur = vi.fn();
			render(<Button onBlur={handleBlur}>Blur</Button>);
			fireEvent.blur(screen.getByRole('button'));
			expect(handleBlur).toHaveBeenCalledTimes(1);
		});
	});

	describe('Style Composition', () => {
		it('combines variant and size classes', () => {
			render(
				<Button variant="danger" size="lg">
					Danger Large
				</Button>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-error');
			expect(button.className).toContain('rounded-lg');
		});

		it('applies inline-flex layout class', () => {
			render(<Button>Flex Button</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('inline-flex');
		});

		it('applies center alignment classes', () => {
			render(<Button>Centered Button</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('items-center');
			expect(button.className).toContain('justify-center');
		});

		it('applies font-medium class', () => {
			render(<Button>Bold Button</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('font-medium');
		});

		it('applies outline-none class', () => {
			render(<Button>No Outline</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('outline-none');
		});

		it('applies select-none class', () => {
			render(<Button>Not Selectable</Button>);
			const button = screen.getByRole('button');
			expect(button.className).toContain('select-none');
		});

		it('custom style overrides defaults via the style prop', () => {
			render(<Button style={{ backgroundColor: 'purple' }}>Custom</Button>);
			const button = screen.getByRole('button');
			expect(button.style.backgroundColor).toBe('purple');
		});
	});

	describe('Class Name Construction', () => {
		it('includes font-medium class', () => {
			render(<Button>Button</Button>);
			expect(screen.getByRole('button').className).toContain('font-medium');
		});

		it('includes whitespace-nowrap class', () => {
			render(<Button>Button</Button>);
			expect(screen.getByRole('button').className).toContain('whitespace-nowrap');
		});

		it('includes focus ring classes', () => {
			render(<Button>Button</Button>);
			const className = screen.getByRole('button').className;
			expect(className).toContain('focus:ring-2');
			expect(className).toContain('focus:ring-offset-1');
		});

		it('includes transition-colors class', () => {
			render(<Button>Button</Button>);
			expect(screen.getByRole('button').className).toContain('transition-colors');
		});

		it('filters out empty class names', () => {
			render(<Button fullWidth={false}>Button</Button>);
			const className = screen.getByRole('button').className;
			// Should not have double spaces from empty class names
			expect(className).not.toContain('  ');
		});
	});

	describe('Accessibility', () => {
		it('is focusable', () => {
			render(<Button>Focusable</Button>);
			const button = screen.getByRole('button');
			button.focus();
			expect(document.activeElement).toBe(button);
		});

		it('supports aria-label', () => {
			render(<Button aria-label="Custom label">Button</Button>);
			expect(screen.getByLabelText('Custom label')).toBeInTheDocument();
		});

		it('supports aria-describedby', () => {
			render(
				<>
					<Button aria-describedby="description">Button</Button>
					<span id="description">Description text</span>
				</>
			);
			expect(screen.getByRole('button')).toHaveAttribute('aria-describedby', 'description');
		});
	});
});

describe('IconButton Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with icon content', () => {
			render(
				<IconButton aria-label="Close">
					<span>×</span>
				</IconButton>
			);
			expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
		});

		it('requires aria-label prop', () => {
			render(
				<IconButton aria-label="Action">
					<span>I</span>
				</IconButton>
			);
			expect(screen.getByLabelText('Action')).toBeInTheDocument();
		});

		it('forwards ref to button element', () => {
			const ref = React.createRef<HTMLButtonElement>();
			render(
				<IconButton ref={ref} aria-label="Ref Button">
					<span>I</span>
				</IconButton>
			);
			expect(ref.current).toBeInstanceOf(HTMLButtonElement);
		});
	});

	describe('Sizes', () => {
		it('applies sm size classes', () => {
			render(
				<IconButton size="sm" aria-label="Small">
					<span>S</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('!p-1');
			expect(button.className).toContain('min-w-[24px]');
			expect(button.className).toContain('min-h-[24px]');
		});

		it('applies md size classes', () => {
			render(
				<IconButton size="md" aria-label="Medium">
					<span>M</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('!p-1.5');
			expect(button.className).toContain('min-w-[32px]');
			expect(button.className).toContain('min-h-[32px]');
		});

		it('applies lg size classes', () => {
			render(
				<IconButton size="lg" aria-label="Large">
					<span>L</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('!p-2');
			expect(button.className).toContain('min-w-[40px]');
			expect(button.className).toContain('min-h-[40px]');
		});

		it('uses md size as default', () => {
			render(
				<IconButton aria-label="Default">
					<span>D</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('min-w-[32px]');
		});
	});

	describe('Variants', () => {
		it('supports all button variants', () => {
			const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'success'];
			variants.forEach((variant) => {
				cleanup();
				render(
					<IconButton variant={variant} aria-label={variant}>
						<span>V</span>
					</IconButton>
				);
				expect(screen.getByRole('button')).toBeInTheDocument();
			});
		});

		it('applies ghost variant for typical icon button use', () => {
			render(
				<IconButton variant="ghost" aria-label="Ghost">
					<span>G</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('bg-transparent');
		});
	});

	describe('Padding Override', () => {
		it('forces padding via the !p-* class so the parent Button px-*/py-* loses', () => {
			render(
				<IconButton aria-label="Icon">
					<span>I</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toMatch(/!p-1\.5\b/);
		});

		it('combines custom className with the size override classes', () => {
			render(
				<IconButton className="custom-class" aria-label="Icon">
					<span>I</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('!p-1.5');
			expect(button.className).toContain('custom-class');
		});
	});

	describe('Custom Styles', () => {
		it('allows custom style overrides via the style prop', () => {
			render(
				<IconButton style={{ backgroundColor: 'red' }} aria-label="Styled">
					<span>S</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.style.backgroundColor).toBe('red');
		});

		it('preserves size classes alongside custom styles', () => {
			render(
				<IconButton size="lg" style={{ margin: '10px' }} aria-label="Combined">
					<span>C</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('min-w-[40px]');
			expect(button).toHaveStyle({ margin: '10px' });
		});
	});

	describe('States', () => {
		it('supports disabled state', () => {
			render(
				<IconButton disabled aria-label="Disabled">
					<span>D</span>
				</IconButton>
			);
			expect(screen.getByRole('button')).toBeDisabled();
		});

		it('supports loading state', () => {
			render(
				<IconButton loading aria-label="Loading">
					<span>L</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button).toBeDisabled();
			expect(button).toHaveAttribute('aria-busy', 'true');
		});
	});

	describe('Event Handling', () => {
		it('calls onClick when clicked', () => {
			const handleClick = vi.fn();
			render(
				<IconButton onClick={handleClick} aria-label="Clickable">
					<span>C</span>
				</IconButton>
			);
			fireEvent.click(screen.getByRole('button'));
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it('does not call onClick when disabled', () => {
			const handleClick = vi.fn();
			render(
				<IconButton disabled onClick={handleClick} aria-label="Disabled">
					<span>D</span>
				</IconButton>
			);
			fireEvent.click(screen.getByRole('button'));
			expect(handleClick).not.toHaveBeenCalled();
		});
	});
});

describe('Type Exports', () => {
	it('exports ButtonVariant type', () => {
		const variant: ButtonVariant = 'primary';
		expect(variant).toBe('primary');
	});

	it('exports ButtonSize type', () => {
		const size: ButtonSize = 'md';
		expect(size).toBe('md');
	});

	it('exports ButtonProps interface', () => {
		const props: ButtonProps = {
			variant: 'secondary',
			size: 'lg',
			loading: false,
			fullWidth: true,
		};
		expect(props.variant).toBe('secondary');
	});

	it('exports IconButtonProps interface', () => {
		const props: IconButtonProps = {
			'aria-label': 'Icon',
			variant: 'ghost',
			size: 'sm',
		};
		expect(props['aria-label']).toBe('Icon');
	});
});

describe('Default Export', () => {
	it('exports Button as default', async () => {
		const module = await import('../../../web/components/Button');
		expect(module.default).toBe(module.Button);
	});
});

describe('Edge Cases', () => {
	afterEach(() => {
		cleanup();
	});

	it('handles empty className gracefully', () => {
		render(<Button className="">Empty Class</Button>);
		expect(screen.getByRole('button')).toBeInTheDocument();
	});

	it('handles undefined children', () => {
		render(<Button>{undefined}</Button>);
		expect(screen.getByRole('button')).toBeInTheDocument();
	});

	it('handles null children', () => {
		render(<Button>{null}</Button>);
		expect(screen.getByRole('button')).toBeInTheDocument();
	});

	it('handles complex children', () => {
		render(
			<Button>
				<span>Icon</span>
				<span>Text</span>
			</Button>
		);
		expect(screen.getByText('Icon')).toBeInTheDocument();
		expect(screen.getByText('Text')).toBeInTheDocument();
	});

	it('handles boolean false fullWidth', () => {
		render(<Button fullWidth={false}>Not Full</Button>);
		const button = screen.getByRole('button');
		expect(button.className).not.toContain('w-full');
	});

	it('handles multiple clicks rapidly', () => {
		const handleClick = vi.fn();
		render(<Button onClick={handleClick}>Rapid Click</Button>);
		const button = screen.getByRole('button');
		fireEvent.click(button);
		fireEvent.click(button);
		fireEvent.click(button);
		expect(handleClick).toHaveBeenCalledTimes(3);
	});

	it('maintains button type attribute', () => {
		render(<Button type="button">Type Button</Button>);
		expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
	});

	it('supports form submission type', () => {
		render(<Button type="submit">Submit</Button>);
		expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
	});

	it('supports reset type', () => {
		render(<Button type="reset">Reset</Button>);
		expect(screen.getByRole('button')).toHaveAttribute('type', 'reset');
	});
});
