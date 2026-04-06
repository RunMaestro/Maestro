import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Spinner } from '../../../../renderer/components/ui/Spinner';

describe('Spinner', () => {
	describe('size variants', () => {
		it('should render xs size (w-3 h-3)', () => {
			const { container } = render(<Spinner size="xs" />);
			const svg = container.querySelector('svg')!;
			expect(svg.getAttribute('class')).toContain('w-3');
			expect(svg.getAttribute('class')).toContain('h-3');
		});

		it('should render sm size by default (w-4 h-4)', () => {
			const { container } = render(<Spinner />);
			const svg = container.querySelector('svg')!;
			expect(svg.getAttribute('class')).toContain('w-4');
			expect(svg.getAttribute('class')).toContain('h-4');
		});

		it('should render md size (w-5 h-5)', () => {
			const { container } = render(<Spinner size="md" />);
			const svg = container.querySelector('svg')!;
			expect(svg.getAttribute('class')).toContain('w-5');
			expect(svg.getAttribute('class')).toContain('h-5');
		});

		it('should render lg size (w-6 h-6)', () => {
			const { container } = render(<Spinner size="lg" />);
			const svg = container.querySelector('svg')!;
			expect(svg.getAttribute('class')).toContain('w-6');
			expect(svg.getAttribute('class')).toContain('h-6');
		});

		it('should render xl size (w-8 h-8)', () => {
			const { container } = render(<Spinner size="xl" />);
			const svg = container.querySelector('svg')!;
			expect(svg.getAttribute('class')).toContain('w-8');
			expect(svg.getAttribute('class')).toContain('h-8');
		});
	});

	describe('animate-spin', () => {
		it('should always include animate-spin class', () => {
			const { container } = render(<Spinner />);
			const svg = container.querySelector('svg')!;
			expect(svg.getAttribute('class')).toContain('animate-spin');
		});

		it('should include animate-spin for all sizes', () => {
			const sizes = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
			for (const size of sizes) {
				const { container, unmount } = render(<Spinner size={size} />);
				const svg = container.querySelector('svg')!;
				expect(svg.getAttribute('class')).toContain('animate-spin');
				unmount();
			}
		});
	});

	describe('className passthrough', () => {
		it('should apply additional className', () => {
			const { container } = render(<Spinner className="shrink-0 ml-2" />);
			const svg = container.querySelector('svg')!;
			const classes = svg.getAttribute('class')!;
			expect(classes).toContain('shrink-0');
			expect(classes).toContain('ml-2');
		});

		it('should merge className with size and animate-spin', () => {
			const { container } = render(<Spinner size="xs" className="mx-auto" />);
			const svg = container.querySelector('svg')!;
			const classes = svg.getAttribute('class')!;
			expect(classes).toContain('w-3');
			expect(classes).toContain('h-3');
			expect(classes).toContain('animate-spin');
			expect(classes).toContain('mx-auto');
		});
	});

	describe('style passthrough', () => {
		it('should pass through inline style', () => {
			const { container } = render(<Spinner style={{ color: 'red' }} />);
			const svg = container.querySelector('svg')!;
			expect(svg.style.color).toBe('red');
		});
	});

	describe('renders Loader2', () => {
		it('should render an SVG element (Loader2 icon)', () => {
			const { container } = render(<Spinner />);
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});
	});
});
