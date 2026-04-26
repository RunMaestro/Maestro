/**
 * Tests for Card, CardHeader, CardBody, CardFooter, and SessionCard components
 * @vitest-environment jsdom
 *
 * After the Tailwind migration, color/border/radius tokens are CSS classes
 * resolved via `--maestro-*` variables at runtime — jsdom does not load the
 * Tailwind stylesheet, so inline-style assertions don't work here. Instead we
 * assert on className containment + behaviour (events, aria-*, DOM shape).
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
	type SessionStatus,
	type InputMode,
} from '../../../web/components/Card';

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
			expect(card.className).toContain('p-3');
		});

		it('includes the shared base classes', () => {
			const { container } = render(<Card>Base</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('transition-all');
			expect(card.className).toContain('duration-150');
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

		it('applies default variant classes', () => {
			const { container } = render(<Card variant="default">Default</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('bg-bg-activity');
			expect(card.className).toContain('text-text-main');
		});

		it('applies elevated variant classes with card-elevated shadow', () => {
			const { container } = render(<Card variant="elevated">Elevated</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('bg-bg-activity');
			expect(card.className).toContain('text-text-main');
			expect(card.className).toContain('shadow-card-elevated');
		});

		it('applies outlined variant classes with border', () => {
			const { container } = render(<Card variant="outlined">Outlined</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('bg-transparent');
			expect(card.className).toContain('text-text-main');
			expect(card.className).toContain('border');
			expect(card.className).toContain('border-border');
		});

		it('applies filled variant classes with sidebar background', () => {
			const { container } = render(<Card variant="filled">Filled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('bg-bg-sidebar');
			expect(card.className).toContain('text-text-main');
		});

		it('applies ghost variant classes with transparent border', () => {
			const { container } = render(<Card variant="ghost">Ghost</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('bg-transparent');
			expect(card.className).toContain('text-text-main');
			expect(card.className).toContain('border-transparent');
		});

		it('uses default variant when variant is not specified', () => {
			const { container } = render(<Card>Default Variant</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('bg-bg-activity');
		});

		it('handles unknown variant gracefully (default case)', () => {
			const { container } = render(<Card variant={'unknown' as CardVariant}>Unknown</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toBeInTheDocument();
			// Unknown variant falls back to empty string — no variant classes, but
			// base classes still present.
			expect(card.className).toContain('transition-all');
		});
	});

	describe('Padding Options', () => {
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
		const radiusClassMap: Record<CardRadius, string> = {
			none: 'rounded-none',
			sm: 'rounded',
			md: 'rounded-lg',
			lg: 'rounded-xl',
			full: 'rounded-full',
		};

		(Object.keys(radiusClassMap) as CardRadius[]).forEach((radius) => {
			it(`applies ${radius} → ${radiusClassMap[radius]}`, () => {
				const { container } = render(<Card radius={radius}>{radius} Radius</Card>);
				const card = container.firstChild as HTMLElement;
				expect(card.className).toContain(radiusClassMap[radius]);
			});
		});

		it('uses medium radius (rounded-lg) as default', () => {
			const { container } = render(<Card>Default Radius</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('rounded-lg');
		});
	});

	describe('Interactive State', () => {
		it('applies cursor-pointer class when interactive', () => {
			const { container } = render(<Card interactive>Interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('cursor-pointer');
		});

		it('does not apply cursor-pointer when not interactive', () => {
			const { container } = render(<Card>Non-interactive Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).not.toContain('cursor-pointer');
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
		it('adds accent ring classes when selected', () => {
			const { container } = render(<Card selected>Selected Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('ring-1');
			expect(card.className).toContain('ring-accent');
		});

		it('does not add accent ring classes when not selected', () => {
			const { container } = render(<Card>Not Selected</Card>);
			const card = container.firstChild as HTMLElement;
			// `ring-1` is the selected-state width; the focus-visible ring uses
			// `focus-visible:ring-2 focus-visible:ring-accent`, so check for the
			// selected token specifically rather than a bare 'ring-accent'
			// substring (which the focus-visible class would also satisfy).
			expect(card.className).not.toContain('ring-1');
			expect(card.className).not.toMatch(/(^|\s)ring-accent(\s|$)/);
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

		it('uses accent-dim background and accent border for outlined + selected', () => {
			const { container } = render(
				<Card variant="outlined" selected>
					Outlined Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('!bg-accent-dim');
			expect(card.className).toContain('!border-accent');
			expect(card.className).toContain('ring-1');
			expect(card.className).toContain('ring-accent');
		});

		it('uses bg-activity and accent border for ghost + selected', () => {
			const { container } = render(
				<Card variant="ghost" selected>
					Ghost Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('!bg-bg-activity');
			expect(card.className).toContain('!border-accent');
			expect(card.className).toContain('ring-1');
			expect(card.className).toContain('ring-accent');
		});

		it('uses bg-activity (no border swap) for default + selected', () => {
			const { container } = render(
				<Card variant="default" selected>
					Default Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('!bg-bg-activity');
			expect(card.className).toContain('ring-1');
			expect(card.className).toContain('ring-accent');
			// Default variant has no border, so no border-accent override.
			expect(card.className).not.toContain('!border-accent');
		});

		it('uses bg-activity (no border swap) for elevated + selected', () => {
			const { container } = render(
				<Card variant="elevated" selected>
					Elevated Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('!bg-bg-activity');
			expect(card.className).toContain('ring-accent');
			expect(card.className).not.toContain('!border-accent');
		});

		it('uses bg-activity (no border swap) for filled + selected', () => {
			const { container } = render(
				<Card variant="filled" selected>
					Filled Selected
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('!bg-bg-activity');
			expect(card.className).toContain('ring-accent');
			expect(card.className).not.toContain('!border-accent');
		});
	});

	describe('Disabled State', () => {
		it('applies disabled classes when disabled', () => {
			const { container } = render(<Card disabled>Disabled Card</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('opacity-50');
			expect(card.className).toContain('cursor-not-allowed');
			expect(card.className).toContain('pointer-events-none');
		});

		it('does not apply disabled classes when not disabled', () => {
			const { container } = render(<Card>Not Disabled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).not.toContain('opacity-50');
			expect(card.className).not.toContain('pointer-events-none');
		});

		it('sets aria-disabled when disabled', () => {
			const { container } = render(<Card disabled>Disabled</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('aria-disabled', 'true');
		});

		it('disabled overrides interactive cursor (no cursor-pointer)', () => {
			const { container } = render(
				<Card interactive disabled>
					Interactive Disabled
				</Card>
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('cursor-not-allowed');
			expect(card.className).not.toContain('cursor-pointer');
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

		it('strips onClick from DOM when disabled', () => {
			const handleClick = vi.fn();
			const { container } = render(
				<Card disabled onClick={handleClick}>
					Disabled Click
				</Card>
			);
			const card = container.firstChild as HTMLElement;
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
		it('applies w-full when fullWidth is true', () => {
			const { container } = render(<Card fullWidth>Full Width</Card>);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('w-full');
		});

		it('does not apply w-full when fullWidth is false', () => {
			const { container } = render(<Card>Not Full Width</Card>);
			const card = container.firstChild as HTMLElement;
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

			expect(card.className).toContain('p-4');
			expect(card.className).toContain('extra-class');
			expect(card.className).toContain('w-full');
			expect(card.className).toContain('hover:brightness-110');
			expect(card.className).toContain('rounded-xl');
			expect(card.className).toContain('shadow-card-elevated');
			expect(card.className).toContain('ring-accent');
			expect(card).toHaveStyle({ marginBottom: '10px' });
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
		it('applies text-text-main color class to title', () => {
			render(<CardHeader title="Colored Title" />);
			const title = screen.getByText('Colored Title');
			expect(title.className).toContain('text-text-main');
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
		it('applies text-text-dim color class to subtitle', () => {
			render(<CardHeader subtitle="Colored Subtitle" />);
			const subtitle = screen.getByText('Colored Subtitle');
			expect(subtitle.className).toContain('text-text-dim');
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
		it('adds border-t + border-border classes when bordered is true', () => {
			const { container } = render(<CardFooter bordered>Bordered Footer</CardFooter>);
			const footer = container.firstChild as HTMLElement;
			expect(footer.className).toContain('border-t');
			expect(footer.className).toContain('border-border');
		});

		it('does not add border classes when bordered is false (default)', () => {
			const { container } = render(<CardFooter>No Border</CardFooter>);
			const footer = container.firstChild as HTMLElement;
			expect(footer.className).not.toContain('border-t');
			expect(footer.className).not.toContain('border-border');
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

		it('renders session name with correct classes', () => {
			render(<SessionCard name="test-session" status="idle" mode="ai" />);
			const name = screen.getByText('test-session');
			expect(name.className).toContain('text-text-main');
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
			expect(card.className).toContain('bg-transparent');
			expect(card.className).toContain('border-border');
		});

		it('is interactive by default', () => {
			const { container } = render(<SessionCard name="session" status="idle" mode="ai" />);
			const card = container.firstChild as HTMLElement;
			expect(card).toHaveAttribute('role', 'button');
		});
	});

	describe('Status Indicator', () => {
		it('renders default status indicator for idle (bg-success)', () => {
			render(<SessionCard name="session" status="idle" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator.className).toContain('bg-success');
			expect(indicator).toHaveAttribute('aria-label', 'idle');
		});

		it('renders default status indicator for busy (bg-warning)', () => {
			render(<SessionCard name="session" status="busy" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator.className).toContain('bg-warning');
			expect(indicator).toHaveAttribute('aria-label', 'busy');
		});

		it('renders default status indicator for error (bg-error)', () => {
			render(<SessionCard name="session" status="error" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator.className).toContain('bg-error');
			expect(indicator).toHaveAttribute('aria-label', 'error');
		});

		it('renders default status indicator for connecting (bg-connecting + animate-pulse)', () => {
			render(<SessionCard name="session" status="connecting" mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator.className).toContain('bg-connecting');
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

		it('handles unknown status with bg-success fallback', () => {
			render(<SessionCard name="session" status={'unknown' as SessionStatus} mode="ai" />);
			const indicator = screen.getByRole('status');
			expect(indicator.className).toContain('bg-success');
		});
	});

	describe('Input Mode Display', () => {
		it('displays AI mode badge with accent-dim background + accent text', () => {
			render(<SessionCard name="session" status="idle" mode="ai" />);
			const badge = screen.getByText('AI');
			expect(badge.className).toContain('bg-accent-dim');
			expect(badge.className).toContain('text-accent');
		});

		it('displays Terminal mode badge with dim tint background + dim text', () => {
			render(<SessionCard name="session" status="idle" mode="terminal" />);
			const badge = screen.getByText('Terminal');
			expect(badge.className).toContain('text-text-dim');
			// color-mix expression is emitted as an arbitrary utility
			expect(badge.className).toContain('color-mix');
			expect(badge.className).toContain('var(--maestro-text-dim)');
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
			const displayText = screen.getByText(/^\.\.\./);
			expect(displayText).toBeInTheDocument();
		});

		it('does not render cwd area when cwd is undefined', () => {
			const { container } = render(<SessionCard name="session" status="idle" mode="ai" />);
			// The description text line has `text-xs truncate text-text-dim`.
			// If no cwd + no info provided, that wrapper isn't rendered.
			const descElements = container.querySelectorAll('.text-xs.truncate.text-text-dim');
			expect(descElements.length).toBe(0);
		});

		it('handles exactly 29 character cwd without truncation', () => {
			const exactPath = '/home/user/project/folder/abc'; // 29 chars
			render(<SessionCard name="session" status="idle" mode="ai" cwd={exactPath} />);
			expect(screen.getByText(exactPath)).toBeInTheDocument();
		});

		it('handles 31 character cwd with truncation', () => {
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
			const card = screen.getByRole('button').parentElement?.parentElement;
			expect(card).toBeInTheDocument();
		});

		it('allows overriding variant', () => {
			const { container } = render(
				<SessionCard name="session" status="idle" mode="ai" variant="elevated" />
			);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('shadow-card-elevated');
		});
	});
});

describe('Type Exports', () => {
	it('exports CardVariant type with correct values', () => {
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
		expect(card.className).not.toContain('p-2');
		expect(card.className).not.toContain('p-3');
		expect(card.className).not.toContain('p-4');

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
		expect(screen.getByText("<script>alert('xss')</script>")).toBeInTheDocument();
	});

	it('handles unicode in session name', () => {
		render(<SessionCard name="🚀 Project ñ 中文" status="idle" mode="ai" />);
		expect(screen.getByText('🚀 Project ñ 中文')).toBeInTheDocument();
	});

	it('handles very long session name with truncation class', () => {
		const longName = 'a'.repeat(100);
		render(<SessionCard name={longName} status="idle" mode="ai" />);
		const nameElement = screen.getByText(longName);
		expect(nameElement.className).toContain('truncate');
	});

	it('handles empty cwd string', () => {
		const { container } = render(<SessionCard name="session" status="idle" mode="ai" cwd="" />);
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
