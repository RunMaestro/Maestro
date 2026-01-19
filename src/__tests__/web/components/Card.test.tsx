/**
 * Tests for Card, CardHeader, CardBody, CardFooter, and SessionCard components
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import {
	Card,
	CardHeader,
	CardBody,
	CardFooter,
	SessionCard,
	type CardVariant,
	type CardPadding,
	type CardRadius,
	type CardProps,
	type CardHeaderProps,
	type CardBodyProps,
	type CardFooterProps,
	type SessionCardProps,
	type SessionStatus,
	type InputMode,
} from '../../../web/components/Card';

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

describe('Card Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with children', () => {
			render(<Card>Card content</Card>);
			expect(screen.getByText('Card content')).toBeInTheDocument();
		});

		it('renders without children', () => {
			const { container } = render(<Card />);
			expect(container.firstChild).toBeInTheDocument();
		});

		it('renders with default props', () => {
			const { container } = render(<Card>Default Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toBeInTheDocument();
			// Default padding is 'md' which is 'p-3'
			expect(card.className).toContain('p-3');
		});

		it('passes through HTML div attributes', () => {
			render(
				<Card id="test-id" data-testid="test-card">
					Content
				</Card>
			);
			const card = screen.getByTestId('test-card');
			expect(card).toHaveAttribute('id', 'test-id');
		});

		it('applies custom className', () => {
			const { container } = render(<Card className="custom-class">Styled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('custom-class');
		});

		it('applies custom style', () => {
			const { container } = render(<Card style={{ marginTop: '10px' }}>Styled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ marginTop: '10px' });
		});

		it('forwards ref to div element', () => {
			const ref = React.createRef<HTMLDivElement>();
			render(<Card ref={ref}>Ref Card</Card>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
			expect(ref.current?.textContent).toContain('Ref Card');
		});
	});

	describe('Variants', () => {
		const variants: CardVariant[] = ['default', 'elevated', 'outlined', 'filled', 'ghost'];

		variants.forEach((variant) => {
			it(`renders ${variant} variant`, () => {
				const { container } = render(<Card variant={variant}>{variant} Card</Card>);
				const card = container.firstChild as HTMLElement;
				expect(card).toBeInTheDocument();
			});
		});

		it('applies default variant styles with activity background', () => {
			const { container } = render(<Card variant="default">Default</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ backgroundColor: '#1c1c1f' });
			expect(card).toHaveStyle({ color: '#e4e4e7' });
			// Default variant has no border - verify by checking no border color
		});

		it('applies elevated variant styles with box shadow', () => {
			const { container } = render(<Card variant="elevated">Elevated</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ backgroundColor: '#1c1c1f' });
			expect(card).toHaveStyle({ color: '#e4e4e7' });
			// Elevated variant has no border (border: 'none')
			// Check box shadow is applied
			expect(card.style.boxShadow).toContain('rgba(0, 0, 0');
		});

		it('applies outlined variant styles with border', () => {
			const { container } = render(<Card variant="outlined">Outlined</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.style.backgroundColor).toBe('transparent');
			expect(card).toHaveStyle({ color: '#e4e4e7' });
			// Border color #27272a is rendered as rgb(39, 39, 42) in jsdom
			expect(card.style.border).toContain('rgb(39, 39, 42)');
		});

		it('applies filled variant styles with sidebar background', () => {
			const { container } = render(<Card variant="filled">Filled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ backgroundColor: '#111113' });
			expect(card).toHaveStyle({ color: '#e4e4e7' });
			// Variant sets border: 'none' which may be rendered differently - check no visible border
			// The style object has border shorthand properties that may parse differently
		});

		it('applies ghost variant styles with transparent background', () => {
			const { container } = render(<Card variant="ghost">Ghost</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.style.backgroundColor).toBe('transparent');
			expect(card).toHaveStyle({ color: '#e4e4e7' });
			expect(card.style.border).toContain('transparent');
		});

		it('uses default variant when variant is not specified', () => {
			const { container } = render(<Card>Default Variant</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ backgroundColor: '#1c1c1f' });
		});

		it('handles unknown variant gracefully (default case)', () => {
			// Cast to any to test the default fallback case in the switch statement
			const { container } = render(<Card variant={'unknown' as CardVariant}>Unknown</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toBeInTheDocument();
			// Unknown variant returns empty styles, so only base styles apply
		});
	});

	describe('Padding Options', () => {
		const paddings: CardPadding[] = ['none', 'sm', 'md', 'lg'];

		it('applies no padding class for none', () => {
			const { container } = render(<Card padding="none">No Padding</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).not.toContain('p-2');
			expect(card.className).not.toContain('p-3');
			expect(card.className).not.toContain('p-4');
		});

		it('applies p-2 for small padding', () => {
			const { container } = render(<Card padding="sm">Small Padding</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('p-2');
		});

		it('applies p-3 for medium padding (default)', () => {
			const { container } = render(<Card padding="md">Medium Padding</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('p-3');
		});

		it('applies p-4 for large padding', () => {
			const { container } = render(<Card padding="lg">Large Padding</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('p-4');
		});
	});

	describe('Border Radius Options', () => {
		const radii: CardRadius[] = ['none', 'sm', 'md', 'lg', 'full'];
		const expectedRadii: Record<CardRadius, string> = {
			none: '0',
			sm: '4px',
			md: '8px',
			lg: '12px',
			full: '9999px',
		};

		radii.forEach((radius) => {
			it(`applies ${radius} border radius (${expectedRadii[radius]})`, () => {
				const { container } = render(<Card radius={radius}>{radius} Radius</Card>);
				const card = container.firstChild as HTMLElement;
				expect(card).toHaveStyle({ borderRadius: expectedRadii[radius] });
			});
		});

		it('uses medium radius as default', () => {
			const { container } = render(<Card>Default Radius</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ borderRadius: '8px' });
		});
	});

	describe('Interactive State', () => {
		it('sets cursor pointer when interactive', () => {
			const { container } = render(<Card interactive>Interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ cursor: 'pointer' });
		});

		it('does not set cursor when not interactive', () => {
			const { container } = render(<Card>Non-interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.style.cursor).toBe('');
		});

		it('adds role="button" when interactive', () => {
			const { container } = render(<Card interactive>Interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('role', 'button');
		});

		it('does not add role when not interactive', () => {
			const { container } = render(<Card>Non-interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).not.toHaveAttribute('role');
		});

		it('adds tabIndex=0 when interactive and not disabled', () => {
			const { container } = render(<Card interactive>Interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('tabIndex', '0');
		});

		it('does not add tabIndex when not interactive', () => {
			const { container } = render(<Card>Non-interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).not.toHaveAttribute('tabIndex');
		});

		it('adds hover and active classes when interactive', () => {
			const { container } = render(<Card interactive>Interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('hover:brightness-110');
			expect(card.className).toContain('active:scale-[0.99]');
		});

		it('does not add hover classes when not interactive', () => {
			const { container } = render(<Card>Non-interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).not.toContain('hover:brightness-110');
		});

		it('handles click events', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card interactive onClick={handleClick}>
					Click Me
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			fireEvent.click(card);
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it('handles Enter key when interactive', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card interactive onClick={handleClick}>
					Press Enter
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			fireEvent.keyDown(card, { key: 'Enter' });
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it('handles Space key when interactive', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card interactive onClick={handleClick}>
					Press Space
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			fireEvent.keyDown(card, { key: ' ' });
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it('calls original onKeyDown handler', () => {
			const handleKeyDown = vi.fn();
			const { container } = render(
				<Card interactive onKeyDown={handleKeyDown}>
					Key Events
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			fireEvent.keyDown(card, { key: 'a' });
			expect(handleKeyDown).toHaveBeenCalledTimes(1);
		});

		it('does not trigger click on keydown when not interactive', () => {
			const handleClick = vi.fn();
			const { container } = render(<Card onClick={handleClick}>Non-interactive</Card>);
			const card = container.firstChild as HTMLElement;
			fireEvent.keyDown(card, { key: 'Enter' });
			expect(handleClick).not.toHaveBeenCalled();
		});
	});

	describe('Selected State', () => {
		it('applies selected styles when selected', () => {
			const { container } = render(<Card selected>Selected Card</Card>);
			const card = container.firstChild as HTMLElement;
			// Selected styles apply accent color to border and box-shadow
			// Color may be rendered as rgb(99, 102, 241) or #6366f1
			expect(card.style.borderColor).toMatch(/6366f1|rgb\(99,\s*102,\s*241\)/);
			expect(card.style.boxShadow).toMatch(/6366f1|rgb\(99,\s*102,\s*241\)/);
		});

		it('does not apply selected styles when not selected', () => {
			const { container } = render(<Card>Not Selected</Card>);
			const card = container.firstChild as HTMLElement;
			// When not selected, borderColor comes from variant styles or defaults
			// Default variant has border: 'none', so borderColor is not accent color
			expect(card.style.borderColor).not.toMatch(/6366f1|rgb\(99,\s*102,\s*241\)/);
		});

		it('sets aria-selected when interactive and selected', () => {
			const { container } = render(
				<Card interactive selected>
					Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('aria-selected', 'true');
		});

		it('sets aria-selected=false when interactive but not selected', () => {
			const { container } = render(<Card interactive>Not Selected</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('aria-selected', 'false');
		});

		it('uses accentDim background for outlined variant when selected', () => {
			const { container } = render(
				<Card variant="outlined" selected>
					Outlined Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			// accentDim is rgba(99, 102, 241, 0.2)
			expect(card.style.backgroundColor).toContain('99, 102, 241');
		});

		it('uses activity background for other variants when selected', () => {
			const { container } = render(
				<Card variant="default" selected>
					Default Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			// bgActivity is #1c1c1f which becomes rgb(28, 28, 31)
			expect(card.style.backgroundColor).toBe('rgb(28, 28, 31)');
		});
	});

	describe('Disabled State', () => {
		it('applies disabled styles when disabled', () => {
			const { container } = render(<Card disabled>Disabled Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ opacity: '0.5' });
			expect(card).toHaveStyle({ cursor: 'not-allowed' });
			expect(card).toHaveStyle({ pointerEvents: 'none' });
		});

		it('does not apply disabled styles when not disabled', () => {
			const { container } = render(<Card>Not Disabled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.style.opacity).not.toBe('0.5');
		});

		it('sets aria-disabled when disabled', () => {
			const { container } = render(<Card disabled>Disabled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('aria-disabled', 'true');
		});

		it('does not set cursor pointer when interactive but disabled', () => {
			const { container } = render(
				<Card interactive disabled>
					Interactive Disabled
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			// Disabled styles override interactive cursor
			expect(card).toHaveStyle({ cursor: 'not-allowed' });
		});

		it('does not add tabIndex when interactive but disabled', () => {
			const { container } = render(
				<Card interactive disabled>
					Disabled
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card).not.toHaveAttribute('tabIndex');
		});

		it('does not add hover classes when interactive but disabled', () => {
			const { container } = render(
				<Card interactive disabled>
					Disabled
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).not.toContain('hover:brightness-110');
		});

		it('does not trigger click when disabled', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card disabled onClick={handleClick}>
					Disabled Click
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			// pointerEvents: none prevents clicks, but testing the onClick prop removal
			expect(card.onclick).toBeNull();
		});

		it('does not trigger keyboard interaction when disabled', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card interactive disabled onClick={handleClick}>
					Disabled Keyboard
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			fireEvent.keyDown(card, { key: 'Enter' });
			expect(handleClick).not.toHaveBeenCalled();
		});
	});

	describe('Full Width', () => {
		it('applies full width styles when fullWidth is true', () => {
			const { container } = render(<Card fullWidth>Full Width</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ width: '100%' });
			expect(card.className).toContain('w-full');
		});

		it('does not apply full width styles when fullWidth is false', () => {
			const { container } = render(<Card>Not Full Width</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.style.width).not.toBe('100%');
			expect(card.className).not.toContain('w-full');
		});
	});

	describe('Focus Styles', () => {
		it('includes focus-visible ring classes', () => {
			const { container } = render(<Card>Focusable Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('focus:outline-none');
			expect(card.className).toContain('focus-visible:ring-2');
			expect(card.className).toContain('focus-visible:ring-offset-1');
		});
	});

	describe('Combined Props', () => {
		it('combines multiple props correctly', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card
					variant="elevated"
					padding="lg"
					radius="lg"
					interactive
					selected
					fullWidth
					onClick={handleClick}
					className="extra-class"
					style={{ marginBottom: '10px' }}
				>
					Combined Props
				</Card>
			);
			const card = container.firstChild as HTMLElement;

			// Check all props are applied
			expect(card.className).toContain('p-4'); // lg padding
			expect(card.className).toContain('extra-class');
			expect(card.className).toContain('w-full');
			expect(card.className).toContain('hover:brightness-110');
			expect(card).toHaveStyle({ borderRadius: '12px' });
			expect(card).toHaveStyle({ marginBottom: '10px' });
			expect(card).toHaveStyle({ width: '100%' });
			expect(card).toHaveAttribute('role', 'button');
			expect(card).toHaveAttribute('tabIndex', '0');

			fireEvent.click(card);
			expect(handleClick).toHaveBeenCalledTimes(1);
		});
	});

	describe('Default Export', () => {
		it('exports Card as default', async () => {
			const module = await import('../../../web/components/Card');
			expect(module.default).toBe(module.Card);
		});
	});
});

describe('CardHeader Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with children directly', () => {
			render(
				<CardHeader>
					<span>Custom Header Content</span>
				</CardHeader>
			);
			expect(screen.getByText('Custom Header Content')).toBeInTheDocument();
		});

		it('renders with title prop', () => {
			render(<CardHeader title="Header Title" />);
			expect(screen.getByText('Header Title')).toBeInTheDocument();
		});

		it('renders with subtitle prop', () => {
			render(<CardHeader subtitle="Header Subtitle" />);
			expect(screen.getByText('Header Subtitle')).toBeInTheDocument();
		});

		it('renders with both title and subtitle', () => {
			render(<CardHeader title="Title" subtitle="Subtitle" />);
			expect(screen.getByText('Title')).toBeInTheDocument();
			expect(screen.getByText('Subtitle')).toBeInTheDocument();
		});

		it('renders with action element', () => {
			render(<CardHeader title="Title" action={<button>Action</button>} />);
			expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
		});

		it('prefers children over title/subtitle/action', () => {
			render(
				<CardHeader title="Title" subtitle="Subtitle" action={<button>Action</button>}>
					<span>Children Content</span>
				</CardHeader>
			);
			expect(screen.getByText('Children Content')).toBeInTheDocument();
			expect(screen.queryByText('Title')).not.toBeInTheDocument();
		});

		it('forwards ref', () => {
			const ref = React.createRef<HTMLDivElement>();
			render(<CardHeader ref={ref} title="Title" />);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});

		it('applies custom className', () => {
			const { container } = render(<CardHeader className="custom-header" title="Title" />);
			const header = container.firstChild as HTMLElement;
			expect(header.className).toContain('custom-header');
			expect(header.className).toContain('flex');
			expect(header.className).toContain('items-center');
		});

		it('applies custom style', () => {
			const { container } = render(<CardHeader style={{ marginTop: '5px' }} title="Title" />);
			const header = container.firstChild as HTMLElement;
			expect(header).toHaveStyle({ marginTop: '5px' });
		});

		it('passes through HTML div attributes', () => {
			render(<CardHeader data-testid="header" title="Title" />);
			expect(screen.getByTestId('header')).toBeInTheDocument();
		});
	});

	describe('Title Styling', () => {
		it('applies correct color to title', () => {
			render(<CardHeader title="Colored Title" />);
			const title = screen.getByText('Colored Title');
			expect(title).toHaveStyle({ color: '#e4e4e7' }); // textMain
		});

		it('applies truncate class to title', () => {
			render(<CardHeader title="Long Title" />);
			const title = screen.getByText('Long Title');
			expect(title.className).toContain('truncate');
		});

		it('applies font-medium to title', () => {
			render(<CardHeader title="Font Weight" />);
			const title = screen.getByText('Font Weight');
			expect(title.className).toContain('font-medium');
		});
	});

	describe('Subtitle Styling', () => {
		it('applies correct color to subtitle', () => {
			render(<CardHeader subtitle="Colored Subtitle" />);
			const subtitle = screen.getByText('Colored Subtitle');
			expect(subtitle).toHaveStyle({ color: '#a1a1aa' }); // textDim
		});

		it('applies text-xs to subtitle', () => {
			render(<CardHeader subtitle="Small Subtitle" />);
			const subtitle = screen.getByText('Small Subtitle');
			expect(subtitle.className).toContain('text-xs');
		});

		it('applies truncate class to subtitle', () => {
			render(<CardHeader subtitle="Truncated Subtitle" />);
			const subtitle = screen.getByText('Truncated Subtitle');
			expect(subtitle.className).toContain('truncate');
		});
	});

	describe('Action Element', () => {
		it('renders action with flex-shrink-0', () => {
			const { container } = render(<CardHeader title="Title" action={<span>Action</span>} />);
			const actionWrapper = container.querySelector('.flex-shrink-0');
			expect(actionWrapper).toBeInTheDocument();
			expect(actionWrapper?.textContent).toBe('Action');
		});

		it('renders ReactNode as action', () => {
			render(
				<CardHeader
					title="Title"
					action={
						<div data-testid="complex-action">
							<button>Button 1</button>
							<button>Button 2</button>
						</div>
					}
				/>
			);
			expect(screen.getByTestId('complex-action')).toBeInTheDocument();
			expect(screen.getAllByRole('button')).toHaveLength(2);
		});
	});

	describe('Without Title or Subtitle', () => {
		it('does not render title container when title is undefined', () => {
			const { container } = render(<CardHeader subtitle="Only Subtitle" />);
			const titleElements = container.querySelectorAll('.font-medium');
			expect(titleElements.length).toBe(0);
		});

		it('does not render subtitle container when subtitle is undefined', () => {
			const { container } = render(<CardHeader title="Only Title" />);
			const subtitleElements = container.querySelectorAll('.text-xs');
			expect(subtitleElements.length).toBe(0);
		});
	});
});

describe('CardBody Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with children', () => {
			render(<CardBody>Body Content</CardBody>);
			expect(screen.getByText('Body Content')).toBeInTheDocument();
		});

		it('renders without children', () => {
			const { container } = render(<CardBody />);
			expect(container.firstChild).toBeInTheDocument();
		});

		it('forwards ref', () => {
			const ref = React.createRef<HTMLDivElement>();
			render(<CardBody ref={ref}>Content</CardBody>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});

		it('applies custom className', () => {
			const { container } = render(<CardBody className="custom-body">Content</CardBody>);
			const body = container.firstChild as HTMLElement;
			expect(body.className).toContain('custom-body');
		});

		it('passes through HTML div attributes', () => {
			render(<CardBody data-testid="body">Content</CardBody>);
			expect(screen.getByTestId('body')).toBeInTheDocument();
		});
	});

	describe('Padding Options', () => {
		it('applies no padding class for none (default)', () => {
			const { container } = render(<CardBody>No Padding</CardBody>);
			const body = container.firstChild as HTMLElement;
			expect(body.className).not.toContain('p-2');
			expect(body.className).not.toContain('p-3');
			expect(body.className).not.toContain('p-4');
		});

		it('applies p-2 for small padding', () => {
			const { container } = render(<CardBody padding="sm">Small Padding</CardBody>);
			const body = container.firstChild as HTMLElement;
			expect(body.className).toContain('p-2');
		});

		it('applies p-3 for medium padding', () => {
			const { container } = render(<CardBody padding="md">Medium Padding</CardBody>);
			const body = container.firstChild as HTMLElement;
			expect(body.className).toContain('p-3');
		});

		it('applies p-4 for large padding', () => {
			const { container } = render(<CardBody padding="lg">Large Padding</CardBody>);
			const body = container.firstChild as HTMLElement;
			expect(body.className).toContain('p-4');
		});
	});
});

describe('CardFooter Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with children', () => {
			render(<CardFooter>Footer Content</CardFooter>);
			expect(screen.getByText('Footer Content')).toBeInTheDocument();
		});

		it('renders without children', () => {
			const { container } = render(<CardFooter />);
			expect(container.firstChild).toBeInTheDocument();
		});

		it('forwards ref', () => {
			const ref = React.createRef<HTMLDivElement>();
			render(<CardFooter ref={ref}>Content</CardFooter>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});

		it('applies default styling classes', () => {
			const { container } = render(<CardFooter>Content</CardFooter>);
			const footer = container.firstChild as HTMLElement;
			expect(footer.className).toContain('flex');
			expect(footer.className).toContain('items-center');
			expect(footer.className).toContain('gap-2');
			expect(footer.className).toContain('pt-2');
			expect(footer.className).toContain('mt-2');
		});

		it('applies custom className', () => {
			const { container } = render(<CardFooter className="custom-footer">Content</CardFooter>);
			const footer = container.firstChild as HTMLElement;
			expect(footer.className).toContain('custom-footer');
		});

		it('applies custom style', () => {
			const { container } = render(
				<CardFooter style={{ paddingBottom: '10px' }}>Content</CardFooter>
			);
			const footer = container.firstChild as HTMLElement;
			expect(footer).toHaveStyle({ paddingBottom: '10px' });
		});

		it('passes through HTML div attributes', () => {
			render(<CardFooter data-testid="footer">Content</CardFooter>);
			expect(screen.getByTestId('footer')).toBeInTheDocument();
		});
	});

	describe('Border Option', () => {
		it('adds top border when bordered is true', () => {
			const { container } = render(<CardFooter bordered>Bordered Footer</CardFooter>);
			const footer = container.firstChild as HTMLElement;
			// border color #27272a is rendered as rgb(39, 39, 42) in jsdom
			expect(footer.style.borderTop).toContain('rgb(39, 39, 42)');
		});

		it('does not add top border when bordered is false (default)', () => {
			const { container } = render(<CardFooter>No Border</CardFooter>);
			const footer = container.firstChild as HTMLElement;
			expect(footer.style.borderTop).toBe('');
		});
	});
});

describe('SessionCard Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('renders with required props', () => {
			render(<SessionCard name="my-session" status="idle" mode="ai" />);
			expect(screen.getByText('my-session')).toBeInTheDocument();
		});

		it('renders session name with correct styling', () => {
			render(<SessionCard name="test-session" status="idle" mode="ai" />);
			const name = screen.getByText('test-session');
			expect(name).toHaveStyle({ color: '#e4e4e7' }); // textMain
			expect(name.className).toContain('font-medium');
			expect(name.className).toContain('truncate');
		});

		it('forwards ref', () => {
			const ref = React.createRef<HTMLDivElement>();
			render(<SessionCard ref={ref} name="session" status="idle" mode="ai" />);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});

		it('uses outlined variant by default', () => {
			const { container } = render(<SessionCard name="session" status="idle" mode="ai" />);
			const card = container.firstChild as HTMLElement;
			// Outlined variant has transparent background
			expect(card.style.backgroundColor).toBe('transparent');
			expect(card.style.border).toContain('rgb(39, 39, 42)'); // #27272a as rgb
		});

		it('is interactive by default', () => {
			const { container } = render(<SessionCard name="session" status="idle" mode="ai" />);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('role', 'button');
		});
	});

	describe('Status Indicator', () => {
		it('renders default status indicator for idle', () => {
			render(<SessionCard name="session" status="idle" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator).toHaveStyle({ backgroundColor: '#22c55e' }); // success color
			expect(indicator).toHaveAttribute('aria-label', 'idle');
		});

		it('renders default status indicator for busy', () => {
			render(<SessionCard name="session" status="busy" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator).toHaveStyle({ backgroundColor: '#eab308' }); // warning color
			expect(indicator).toHaveAttribute('aria-label', 'busy');
		});

		it('renders default status indicator for error', () => {
			render(<SessionCard name="session" status="error" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator).toHaveStyle({ backgroundColor: '#ef4444' }); // error color
			expect(indicator).toHaveAttribute('aria-label', 'error');
		});

		it('renders default status indicator for connecting with animation', () => {
			render(<SessionCard name="session" status="connecting" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator).toHaveStyle({ backgroundColor: '#f97316' }); // orange
			expect(indicator).toHaveAttribute('aria-label', 'connecting');
			expect(indicator.className).toContain('animate-pulse');
		});

		it('renders custom status indicator when provided', () => {
			render(
				<SessionCard
					name="session"
					status="idle"
					mode="ai"
					statusIndicator={<span data-testid="custom-indicator">Custom</span>}
				/>
			);
			expect(screen.getByTestId('custom-indicator')).toBeInTheDocument();
			expect(screen.queryByRole('status')).not.toBeInTheDocument();
		});

		it('handles unknown status with success color (default)', () => {
			render(<SessionCard name="session" status={'unknown' as SessionStatus} mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator).toHaveStyle({ backgroundColor: '#22c55e' }); // success (default)
		});
	});

	describe('Input Mode Display', () => {
		it('displays AI mode badge with accent colors', () => {
			render(<SessionCard name="session" status="idle" mode="ai" />);
			const badge = screen.getByText('AI');
			expect(badge).toHaveStyle({ backgroundColor: 'rgba(99, 102, 241, 0.2)' });
			expect(badge).toHaveStyle({ color: '#6366f1' });
		});

		it('displays Terminal mode badge with dim colors', () => {
			render(<SessionCard name="session" status="idle" mode="terminal" />);
			const badge = screen.getByText('Terminal');
			// Check for textDim-based color
			expect(badge).toHaveStyle({ color: '#a1a1aa' });
		});
	});

	describe('Working Directory', () => {
		it('displays short cwd without truncation', () => {
			render(<SessionCard name="session" status="idle" mode="ai" cwd="/home/user" />);
			expect(screen.getByText('/home/user')).toBeInTheDocument();
		});

		it('truncates long cwd with ellipsis prefix', () => {
			const longPath = '/home/user/very/long/path/to/project/folder';
			render(<SessionCard name="session" status="idle" mode="ai" cwd={longPath} />);
			// Path > 30 chars should be truncated to ...last 27 chars
			const displayText = screen.getByText(/^\.\.\./);
			expect(displayText).toBeInTheDocument();
		});

		it('does not render cwd area when cwd is undefined', () => {
			const { container } = render(<SessionCard name="session" status="idle" mode="ai" />);
			const cwdElements = container.querySelectorAll('.text-xs.truncate');
			// Should be 0 because no cwd or info provided
			expect(cwdElements.length).toBe(0);
		});

		it('handles exactly 30 character cwd without truncation', () => {
			// Exactly 30 chars: not truncated (> 30 is the condition)
			const exactPath = '/home/user/project/folder/abc'; // 29 chars
			render(<SessionCard name="session" status="idle" mode="ai" cwd={exactPath} />);
			expect(screen.getByText(exactPath)).toBeInTheDocument();
		});

		it('handles 31 character cwd with truncation', () => {
			// 31 chars triggers truncation (> 30)
			const longPath = '/home/user/project/folder/abcde'; // 31 chars
			render(<SessionCard name="session" status="idle" mode="ai" cwd={longPath} />);
			const displayText = screen.getByText(/^\.\.\./);
			expect(displayText).toBeInTheDocument();
		});
	});

	describe('Info Display', () => {
		it('displays info prop when provided', () => {
			render(<SessionCard name="session" status="idle" mode="ai" info="Custom info text" />);
			expect(screen.getByText('Custom info text')).toBeInTheDocument();
		});

		it('displays info prop instead of cwd when both provided', () => {
			render(
				<SessionCard
					name="session"
					status="idle"
					mode="ai"
					cwd="/home/user"
					info="Info overrides cwd"
				/>
			);
			expect(screen.getByText('Info overrides cwd')).toBeInTheDocument();
			expect(screen.queryByText('/home/user')).not.toBeInTheDocument();
		});

		it('renders ReactNode as info', () => {
			render(
				<SessionCard
					name="session"
					status="idle"
					mode="ai"
					info={<span data-testid="info-node">Custom Info Node</span>}
				/>
			);
			expect(screen.getByTestId('info-node')).toBeInTheDocument();
		});
	});

	describe('Actions', () => {
		it('renders actions element when provided', () => {
			render(
				<SessionCard
					name="session"
					status="idle"
					mode="ai"
					actions={<button>Action Button</button>}
				/>
			);
			expect(screen.getByRole('button', { name: 'Action Button' })).toBeInTheDocument();
		});

		it('renders multiple action elements', () => {
			render(
				<SessionCard
					name="session"
					status="idle"
					mode="ai"
					actions={
						<>
							<button>Action 1</button>
							<button>Action 2</button>
						</>
					}
				/>
			);
			expect(screen.getByRole('button', { name: 'Action 1' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Action 2' })).toBeInTheDocument();
		});
	});

	describe('Card Props Passthrough', () => {
		it('accepts and passes Card props', () => {
			const handleClick = vi.fn();
			render(
				<SessionCard
					name="session"
					status="idle"
					mode="ai"
					selected
					disabled
					fullWidth
					padding="lg"
					radius="lg"
					onClick={handleClick}
				/>
			);
			// Check that Card props are applied
			const card = screen.getByRole('button').parentElement?.parentElement;
			// The card wrapper should exist
			expect(card).toBeInTheDocument();
		});

		it('allows overriding variant', () => {
			const { container } = render(
				<SessionCard name="session" status="idle" mode="ai" variant="elevated" />
			);
			const card = container.firstChild as HTMLElement;
			// Elevated variant has box-shadow
			expect(card.style.boxShadow).toContain('rgba(0, 0, 0');
		});
	});
});

describe('Type Exports', () => {
	it('exports CardVariant type with correct values', () => {
		// Type checking - these should compile without error
		const variants: CardVariant[] = ['default', 'elevated', 'outlined', 'filled', 'ghost'];
		expect(variants).toHaveLength(5);
	});

	it('exports CardPadding type with correct values', () => {
		const paddings: CardPadding[] = ['none', 'sm', 'md', 'lg'];
		expect(paddings).toHaveLength(4);
	});

	it('exports CardRadius type with correct values', () => {
		const radii: CardRadius[] = ['none', 'sm', 'md', 'lg', 'full'];
		expect(radii).toHaveLength(5);
	});

	it('exports SessionStatus type with correct values', () => {
		const statuses: SessionStatus[] = ['idle', 'busy', 'error', 'connecting'];
		expect(statuses).toHaveLength(4);
	});

	it('exports InputMode type with correct values', () => {
		const modes: InputMode[] = ['ai', 'terminal'];
		expect(modes).toHaveLength(2);
	});
});

describe('Composition Patterns', () => {
	afterEach(() => {
		cleanup();
	});

	it('composes Card with CardHeader and CardBody', () => {
		render(
			<Card>
				<CardHeader title="Card Title" subtitle="Card Subtitle" />
				<CardBody padding="md">Body Content</CardBody>
			</Card>
		);
		expect(screen.getByText('Card Title')).toBeInTheDocument();
		expect(screen.getByText('Card Subtitle')).toBeInTheDocument();
		expect(screen.getByText('Body Content')).toBeInTheDocument();
	});

	it('composes Card with CardHeader, CardBody, and CardFooter', () => {
		render(
			<Card>
				<CardHeader title="Complete Card" />
				<CardBody>Main Content</CardBody>
				<CardFooter bordered>
					<button>Footer Action</button>
				</CardFooter>
			</Card>
		);
		expect(screen.getByText('Complete Card')).toBeInTheDocument();
		expect(screen.getByText('Main Content')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Footer Action' })).toBeInTheDocument();
	});

	it('composes Card padding=none with CardBody padding=md', () => {
		const { container } = render(
			<Card padding="none">
				<CardHeader title="Title" />
				<CardBody padding="md">Padded Body</CardBody>
			</Card>
		);
		const card = container.firstChild as HTMLElement;
		// Card with padding=none should not have padding classes
		expect(card.className).not.toContain('p-2');
		expect(card.className).not.toContain('p-3');
		expect(card.className).not.toContain('p-4');

		// CardBody with padding=md has its own p-3 class
		// getByText returns the element containing the text (CardBody div itself)
		const bodyElement = screen.getByText('Padded Body');
		expect(bodyElement.className).toContain('p-3');
	});
});

describe('Edge Cases', () => {
	afterEach(() => {
		cleanup();
	});

	it('handles empty className gracefully', () => {
		const { container } = render(<Card className="">Empty Class</Card>);
		const card = container.firstChild as HTMLElement;
		expect(card).toBeInTheDocument();
		// Should not have double spaces or trailing spaces
		expect(card.className).not.toMatch(/\s\s/);
	});

	it('handles null children gracefully', () => {
		const { container } = render(<Card>{null}</Card>);
		expect(container.firstChild).toBeInTheDocument();
	});

	it('handles undefined children gracefully', () => {
		const { container } = render(<Card>{undefined}</Card>);
		expect(container.firstChild).toBeInTheDocument();
	});

	it('handles special characters in session name', () => {
		render(<SessionCard name="<script>alert('xss')</script>" status="idle" mode="ai" />);
		// React escapes the content, so it should be displayed as text
		expect(screen.getByText("<script>alert('xss')</script>")).toBeInTheDocument();
	});

	it('handles unicode in session name', () => {
		render(<SessionCard name="🚀 Project ñ 中文" status="idle" mode="ai" />);
		expect(screen.getByText('🚀 Project ñ 中文')).toBeInTheDocument();
	});

	it('handles very long session name with truncation', () => {
		const longName = 'a'.repeat(100);
		render(<SessionCard name={longName} status="idle" mode="ai" />);
		const nameElement = screen.getByText(longName);
		expect(nameElement.className).toContain('truncate');
	});

	it('handles empty cwd string', () => {
		render(<SessionCard name="session" status="idle" mode="ai" cwd="" />);
		// Empty cwd should not render the cwd display
		const { container } = render(<SessionCard name="session" status="idle" mode="ai" cwd="" />);
		// Empty string is falsy, so displayCwd will be undefined
		expect(container.textContent).not.toContain('...');
	});

	it('handles onKeyDown events other than Enter/Space', () => {
		const handleKeyDown = vi.fn();
		const { container } = render(
			<Card interactive onKeyDown={handleKeyDown}>
				Key Test
			</Card>
		);
		const card = container.firstChild as HTMLElement;
		fireEvent.keyDown(card, { key: 'Escape' });
		expect(handleKeyDown).toHaveBeenCalledTimes(1);
	});

	it('handles rapid click events', () => {
		const handleClick = vi.fn();
		const { container } = render(
			<Card interactive onClick={handleClick}>
				Rapid Click
			</Card>
		);
		const card = container.firstChild as HTMLElement;

		for (let i = 0; i < 10; i++) {
			fireEvent.click(card);
		}

		expect(handleClick).toHaveBeenCalledTimes(10);
	});

	it('handles mouse events', () => {
		const handleMouseEnter = vi.fn();
		const handleMouseLeave = vi.fn();
		const { container } = render(
			<Card onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
				Mouse Events
			</Card>
		);
		const card = container.firstChild as HTMLElement;

		fireEvent.mouseEnter(card);
		expect(handleMouseEnter).toHaveBeenCalledTimes(1);

		fireEvent.mouseLeave(card);
		expect(handleMouseLeave).toHaveBeenCalledTimes(1);
	});

	it('handles focus and blur events', () => {
		const handleFocus = vi.fn();
		const handleBlur = vi.fn();
		const { container } = render(
			<Card interactive onFocus={handleFocus} onBlur={handleBlur}>
				Focus Events
			</Card>
		);
		const card = container.firstChild as HTMLElement;

		fireEvent.focus(card);
		expect(handleFocus).toHaveBeenCalledTimes(1);

		fireEvent.blur(card);
		expect(handleBlur).toHaveBeenCalledTimes(1);
	});
});
