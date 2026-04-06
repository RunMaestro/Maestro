/**
 * Tests for ScrollArea component.
 *
 * ScrollArea is the unified themed scroll wrapper used app-wide. The actual
 * theming comes from CSS variables (set by useThemeStyles, consumed by global
 * rules in src/renderer/index.css), so these tests verify the structural
 * contract: correct classes, correct overflow CSS, and ref forwarding.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { ScrollArea } from '../../../renderer/components/ScrollArea';

describe('ScrollArea', () => {
	describe('variant', () => {
		it('renders without scrollbar class for default variant (uses global *::-webkit-scrollbar rules)', () => {
			render(
				<ScrollArea data-testid="sa">
					<span>content</span>
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.className).toBe('');
		});

		it('applies .scrollbar-thin for thin variant (opts into fade-on-idle animation)', () => {
			render(
				<ScrollArea variant="thin" data-testid="sa">
					<span>content</span>
				</ScrollArea>
			);
			expect(screen.getByTestId('sa').className).toContain('scrollbar-thin');
		});

		it('applies .no-scrollbar when hideScrollbar is true (overrides variant)', () => {
			render(
				<ScrollArea variant="thin" hideScrollbar data-testid="sa">
					<span>content</span>
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.className).toContain('no-scrollbar');
			expect(el.className).not.toContain('scrollbar-thin');
		});

		it('preserves caller-supplied className alongside variant class', () => {
			render(
				<ScrollArea variant="thin" className="my-custom-cls" data-testid="sa">
					<span>content</span>
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.className).toContain('scrollbar-thin');
			expect(el.className).toContain('my-custom-cls');
		});
	});

	describe('axis', () => {
		it('defaults to both axes scrollable', () => {
			render(<ScrollArea data-testid="sa">x</ScrollArea>);
			const el = screen.getByTestId('sa');
			expect(el.style.overflowX).toBe('auto');
			expect(el.style.overflowY).toBe('auto');
		});

		it('axis="y" allows only vertical scrolling', () => {
			render(
				<ScrollArea axis="y" data-testid="sa">
					x
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.style.overflowX).toBe('hidden');
			expect(el.style.overflowY).toBe('auto');
		});

		it('axis="x" allows only horizontal scrolling', () => {
			render(
				<ScrollArea axis="x" data-testid="sa">
					x
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.style.overflowX).toBe('auto');
			expect(el.style.overflowY).toBe('hidden');
		});

		it('axis="none" disables scrolling on both axes (useful for conditional containers)', () => {
			render(
				<ScrollArea axis="none" data-testid="sa">
					x
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.style.overflowX).toBe('hidden');
			expect(el.style.overflowY).toBe('hidden');
		});

		it('caller style overrides do not break axis defaults (style is applied AFTER overflow)', () => {
			// Caller can override overflow if they really want to.
			render(
				<ScrollArea axis="y" style={{ overflowY: 'scroll', padding: 8 }} data-testid="sa">
					x
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.style.overflowY).toBe('scroll');
			expect(el.style.overflowX).toBe('hidden'); // axis still wins for non-overridden
			expect(el.style.padding).toBe('8px');
		});
	});

	describe('ref forwarding', () => {
		it('forwards ref to the underlying div', () => {
			const ref = createRef<HTMLDivElement>();
			render(
				<ScrollArea ref={ref} data-testid="sa">
					content
				</ScrollArea>
			);
			expect(ref.current).toBe(screen.getByTestId('sa'));
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe('html attribute passthrough', () => {
		it('forwards arbitrary HTML attributes (id, role, aria-*) to the div', () => {
			render(
				<ScrollArea id="my-scroll" role="region" aria-label="Activity log" data-testid="sa">
					content
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			expect(el.id).toBe('my-scroll');
			expect(el.getAttribute('role')).toBe('region');
			expect(el.getAttribute('aria-label')).toBe('Activity log');
		});

		it('forwards onScroll handler', () => {
			const onScroll = vi.fn();
			render(
				<ScrollArea onScroll={onScroll} data-testid="sa">
					content
				</ScrollArea>
			);
			const el = screen.getByTestId('sa');
			el.dispatchEvent(new Event('scroll', { bubbles: true }));
			expect(onScroll).toHaveBeenCalled();
		});
	});

	describe('children', () => {
		it('renders children inside the scroll container', () => {
			render(
				<ScrollArea>
					<span data-testid="child">hello</span>
				</ScrollArea>
			);
			expect(screen.getByTestId('child')).toBeInTheDocument();
			expect(screen.getByTestId('child').textContent).toBe('hello');
		});
	});
});
