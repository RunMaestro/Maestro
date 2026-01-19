/**
 * Tests for Button and IconButton components
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

		it('applies primary variant styles with accent color', () => {
			render(<Button variant="primary">Primary</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ backgroundColor: '#6366f1' });
			expect(button).toHaveStyle({ color: '#ffffff' });
		});

		it('applies secondary variant styles with activity background', () => {
			render(<Button variant="secondary">Secondary</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ backgroundColor: '#1c1c1f' });
			expect(button).toHaveStyle({ color: '#e4e4e7' });
		});

		it('applies ghost variant styles with transparent background', () => {
			render(<Button variant="ghost">Ghost</Button>);
			const button = screen.getByRole('button');
			// Check the style object has transparent background set
			expect(button.style.backgroundColor).toBe('transparent');
		});

		it('applies danger variant styles with error color', () => {
			render(<Button variant="danger">Danger</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ backgroundColor: '#ef4444' });
			expect(button).toHaveStyle({ color: '#ffffff' });
		});

		it('applies success variant styles with success color', () => {
			render(<Button variant="success">Success</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ backgroundColor: '#22c55e' });
			expect(button).toHaveStyle({ color: '#ffffff' });
		});

		it('uses primary variant as default', () => {
			render(<Button>Default Variant</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ backgroundColor: '#6366f1' });
		});

		it('handles unknown variant gracefully (default case)', () => {
			// Cast to any to test the default fallback case in the switch statement
			render(<Button variant={'unknown' as any}>Unknown</Button>);
			const button = screen.getByRole('button');
			// Should still render without error
			expect(button).toBeInTheDocument();
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

		it('applies sm size border radius', () => {
			render(<Button size="sm">Small</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ borderRadius: '4px' });
		});

		it('applies md size border radius', () => {
			render(<Button size="md">Medium</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ borderRadius: '6px' });
		});

		it('applies lg size border radius', () => {
			render(<Button size="lg">Large</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ borderRadius: '8px' });
		});

		it('uses md size as default', () => {
			render(<Button>Default Size</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ borderRadius: '6px' });
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

		it('applies disabled styles', () => {
			render(<Button disabled>Disabled</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ opacity: '0.5' });
			expect(button).toHaveStyle({ cursor: 'not-allowed' });
		});

		it('does not apply disabled styles when enabled', () => {
			render(<Button>Enabled</Button>);
			const button = screen.getByRole('button');
			expect(button).not.toHaveStyle({ opacity: '0.5' });
			expect(button).toHaveStyle({ cursor: 'pointer' });
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

		it('applies disabled styles when loading', () => {
			render(<Button loading>Loading</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ opacity: '0.5' });
			expect(button).toHaveStyle({ cursor: 'not-allowed' });
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
		it('applies full width when fullWidth is true', () => {
			render(<Button fullWidth>Full Width</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ width: '100%' });
			expect(button.className).toContain('w-full');
		});

		it('does not apply full width by default', () => {
			render(<Button>Normal Width</Button>);
			const button = screen.getByRole('button');
			expect(button).not.toHaveStyle({ width: '100%' });
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
		it('combines variant and size styles', () => {
			render(
				<Button variant="danger" size="lg">
					Danger Large
				</Button>
			);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ backgroundColor: '#ef4444' });
			expect(button).toHaveStyle({ borderRadius: '8px' });
		});

		it('applies inline flex display', () => {
			render(<Button>Flex Button</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ display: 'inline-flex' });
		});

		it('applies center alignment', () => {
			render(<Button>Centered Button</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ alignItems: 'center' });
			expect(button).toHaveStyle({ justifyContent: 'center' });
		});

		it('applies font weight', () => {
			render(<Button>Bold Button</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ fontWeight: '500' });
		});

		it('applies outline none', () => {
			render(<Button>No Outline</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ outline: 'none' });
		});

		it('applies user-select none', () => {
			render(<Button>Not Selectable</Button>);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ userSelect: 'none' });
		});

		it('custom style overrides default styles', () => {
			render(<Button style={{ backgroundColor: 'purple' }}>Custom</Button>);
			const button = screen.getByRole('button');
			// Check the style object directly
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
		it('applies sm size with correct dimensions', () => {
			render(
				<IconButton size="sm" aria-label="Small">
					<span>S</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ padding: '4px' });
			expect(button).toHaveStyle({ minWidth: '24px' });
			expect(button).toHaveStyle({ minHeight: '24px' });
		});

		it('applies md size with correct dimensions', () => {
			render(
				<IconButton size="md" aria-label="Medium">
					<span>M</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ padding: '6px' });
			expect(button).toHaveStyle({ minWidth: '32px' });
			expect(button).toHaveStyle({ minHeight: '32px' });
		});

		it('applies lg size with correct dimensions', () => {
			render(
				<IconButton size="lg" aria-label="Large">
					<span>L</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ padding: '8px' });
			expect(button).toHaveStyle({ minWidth: '40px' });
			expect(button).toHaveStyle({ minHeight: '40px' });
		});

		it('uses md size as default', () => {
			render(
				<IconButton aria-label="Default">
					<span>D</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ minWidth: '32px' });
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
			// Check the style object directly
			expect(button.style.backgroundColor).toBe('transparent');
		});
	});

	describe('Padding Override', () => {
		it('includes !p-0 class to override base padding', () => {
			render(
				<IconButton aria-label="Icon">
					<span>I</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('!p-0');
		});

		it('combines custom className with !p-0', () => {
			render(
				<IconButton className="custom-class" aria-label="Icon">
					<span>I</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button.className).toContain('!p-0');
			expect(button.className).toContain('custom-class');
		});
	});

	describe('Custom Styles', () => {
		it('allows custom style overrides', () => {
			render(
				<IconButton style={{ backgroundColor: 'red' }} aria-label="Styled">
					<span>S</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			// Check the style object directly
			expect(button.style.backgroundColor).toBe('red');
		});

		it('preserves size styles with custom styles', () => {
			render(
				<IconButton size="lg" style={{ margin: '10px' }} aria-label="Combined">
					<span>C</span>
				</IconButton>
			);
			const button = screen.getByRole('button');
			expect(button).toHaveStyle({ minWidth: '40px' });
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
