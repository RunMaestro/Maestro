/**
 * Tests for MaestroSilhouette component
 *
 * MaestroSilhouette is a conductor silhouette image component that:
 * - Displays a PNG image of a conductor
 * - Supports dark/light variants for different backgrounds
 * - Has configurable size
 * - Also exports AnimatedMaestro with conducting motion animation
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MaestroSilhouette, {
	MaestroSilhouette as NamedMaestroSilhouette,
	AnimatedMaestro,
} from '../../../renderer/components/MaestroSilhouette';

// Mock image imports
vi.mock('../../../renderer/assets/conductor-light.png', () => ({
	default: '/assets/conductor-light.png',
}));
vi.mock('../../../renderer/assets/conductor-dark.png', () => ({
	default: '/assets/conductor-dark.png',
}));

describe('MaestroSilhouette', () => {
	describe('default export', () => {
		it('matches named export', () => {
			expect(MaestroSilhouette).toBe(NamedMaestroSilhouette);
		});

		it('renders with default props', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByRole('img');
			expect(img).toBeInTheDocument();
			expect(img).toHaveAttribute('alt', 'Maestro conductor silhouette');
		});
	});

	describe('rendering', () => {
		it('renders an img element', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByRole('img');
			expect(img.tagName).toBe('IMG');
		});

		it('uses dark variant by default', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', '/assets/conductor-dark.png');
		});

		it('uses light variant when specified', () => {
			render(<MaestroSilhouette variant="light" />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', '/assets/conductor-light.png');
		});

		it('uses dark variant when explicitly specified', () => {
			render(<MaestroSilhouette variant="dark" />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', '/assets/conductor-dark.png');
		});
	});

	describe('size', () => {
		it('uses default size of 200', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ width: '200px', height: '200px' });
		});

		it('accepts custom size', () => {
			render(<MaestroSilhouette size={300} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ width: '300px', height: '300px' });
		});

		it('handles small sizes', () => {
			render(<MaestroSilhouette size={50} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ width: '50px', height: '50px' });
		});

		it('handles large sizes', () => {
			render(<MaestroSilhouette size={1000} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ width: '1000px', height: '1000px' });
		});
	});

	describe('className', () => {
		it('uses empty className by default', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('class', '');
		});

		it('accepts custom className', () => {
			render(<MaestroSilhouette className="my-custom-class" />);

			const img = screen.getByRole('img');
			expect(img).toHaveClass('my-custom-class');
		});

		it('accepts multiple classes', () => {
			render(<MaestroSilhouette className="class1 class2 class3" />);

			const img = screen.getByRole('img');
			expect(img).toHaveClass('class1');
			expect(img).toHaveClass('class2');
			expect(img).toHaveClass('class3');
		});
	});

	describe('style', () => {
		it('uses empty style object by default', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByRole('img');
			// Default styles are: width, height, objectFit
			expect(img).toHaveStyle({ objectFit: 'contain' });
		});

		it('accepts custom style', () => {
			render(<MaestroSilhouette style={{ opacity: 0.5 }} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ opacity: '0.5' });
		});

		it('merges custom styles with defaults', () => {
			render(<MaestroSilhouette style={{ border: '1px solid red' }} />);

			const img = screen.getByRole('img');
			// Check objectFit and border separately since toHaveStyle can be finicky with multiple props
			expect(img).toHaveStyle({ objectFit: 'contain' });
			expect(img.style.border).toBe('1px solid red');
		});

		it('custom styles can override size', () => {
			render(<MaestroSilhouette size={200} style={{ width: '100%' }} />);

			const img = screen.getByRole('img');
			// Custom style should override the size-based width
			expect(img).toHaveStyle({ width: '100%' });
		});
	});

	describe('accessibility', () => {
		it('has alt text', () => {
			render(<MaestroSilhouette />);

			const img = screen.getByAltText('Maestro conductor silhouette');
			expect(img).toBeInTheDocument();
		});
	});
});

describe('AnimatedMaestro', () => {
	describe('rendering', () => {
		it('renders an img element', () => {
			render(<AnimatedMaestro />);

			const img = screen.getByRole('img');
			expect(img.tagName).toBe('IMG');
		});

		it('has correct alt text', () => {
			render(<AnimatedMaestro />);

			const img = screen.getByAltText('Animated maestro conductor');
			expect(img).toBeInTheDocument();
		});

		it('uses dark variant by default', () => {
			render(<AnimatedMaestro />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', '/assets/conductor-dark.png');
		});

		it('uses light variant when specified', () => {
			render(<AnimatedMaestro variant="light" />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', '/assets/conductor-light.png');
		});
	});

	describe('animation', () => {
		it('has conducting motion animation', () => {
			render(<AnimatedMaestro />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({
				animation: 'conductingMotion 2s ease-in-out infinite',
			});
		});

		it('animation is applied with custom styles', () => {
			render(<AnimatedMaestro style={{ opacity: 0.8 }} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({
				animation: 'conductingMotion 2s ease-in-out infinite',
				opacity: '0.8',
			});
		});
	});

	describe('size', () => {
		it('uses default size of 200', () => {
			render(<AnimatedMaestro />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ width: '200px', height: '200px' });
		});

		it('accepts custom size', () => {
			render(<AnimatedMaestro size={150} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ width: '150px', height: '150px' });
		});
	});

	describe('className', () => {
		it('accepts custom className', () => {
			render(<AnimatedMaestro className="animated-class" />);

			const img = screen.getByRole('img');
			expect(img).toHaveClass('animated-class');
		});
	});

	describe('style', () => {
		it('applies objectFit contain', () => {
			render(<AnimatedMaestro />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({ objectFit: 'contain' });
		});

		it('merges custom styles', () => {
			render(<AnimatedMaestro style={{ transform: 'scale(1.1)' }} />);

			const img = screen.getByRole('img');
			expect(img).toHaveStyle({
				transform: 'scale(1.1)',
				objectFit: 'contain',
			});
		});
	});
});

describe('CSS animation injection', () => {
	it('adds animation stylesheet to document head', () => {
		// The module import already injected the styles
		const styleEl = document.getElementById('maestro-animation-styles');
		expect(styleEl).toBeInTheDocument();
	});

	it('stylesheet contains conductingMotion keyframes', () => {
		const styleEl = document.getElementById('maestro-animation-styles');
		expect(styleEl?.textContent).toContain('@keyframes conductingMotion');
		expect(styleEl?.textContent).toContain('transform: rotate(0deg)');
		expect(styleEl?.textContent).toContain('transform: rotate(-3deg)');
		expect(styleEl?.textContent).toContain('transform: rotate(3deg)');
	});

	it('only injects styles once', () => {
		// Import the module again - it should not duplicate the style element
		const styleElements = document.querySelectorAll('#maestro-animation-styles');
		expect(styleElements.length).toBe(1);
	});
});

describe('edge cases', () => {
	it('handles zero size', () => {
		render(<MaestroSilhouette size={0} />);

		const img = screen.getByRole('img');
		expect(img).toHaveStyle({ width: '0px', height: '0px' });
	});

	it('handles negative size', () => {
		render(<MaestroSilhouette size={-50} />);

		const img = screen.getByRole('img');
		expect(img).toHaveStyle({ width: '-50px', height: '-50px' });
	});

	it('handles fractional size', () => {
		render(<MaestroSilhouette size={150.5} />);

		const img = screen.getByRole('img');
		expect(img).toHaveStyle({ width: '150.5px', height: '150.5px' });
	});

	it('handles empty className', () => {
		render(<MaestroSilhouette className="" />);

		const img = screen.getByRole('img');
		expect(img).toHaveAttribute('class', '');
	});

	it('handles empty style object', () => {
		render(<MaestroSilhouette style={{}} />);

		const img = screen.getByRole('img');
		expect(img).toHaveStyle({ objectFit: 'contain' });
	});

	it('renders both components simultaneously', () => {
		render(
			<>
				<MaestroSilhouette />
				<AnimatedMaestro />
			</>
		);

		const images = screen.getAllByRole('img');
		expect(images).toHaveLength(2);

		expect(images[0]).toHaveAttribute('alt', 'Maestro conductor silhouette');
		expect(images[1]).toHaveAttribute('alt', 'Animated maestro conductor');
	});

	it('renders multiple instances with different props', () => {
		render(
			<>
				<MaestroSilhouette variant="dark" size={100} />
				<MaestroSilhouette variant="light" size={200} />
				<AnimatedMaestro variant="dark" size={300} />
			</>
		);

		const images = screen.getAllByRole('img');
		expect(images).toHaveLength(3);

		expect(images[0]).toHaveAttribute('src', '/assets/conductor-dark.png');
		expect(images[0]).toHaveStyle({ width: '100px' });

		expect(images[1]).toHaveAttribute('src', '/assets/conductor-light.png');
		expect(images[1]).toHaveStyle({ width: '200px' });

		expect(images[2]).toHaveAttribute('src', '/assets/conductor-dark.png');
		expect(images[2]).toHaveStyle({ width: '300px' });
	});
});
