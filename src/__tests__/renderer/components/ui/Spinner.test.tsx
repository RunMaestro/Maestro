/**
 * Tests for Spinner component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from '../../../../renderer/components/ui/Spinner';

describe('Spinner', () => {
	it('renders with default size', () => {
		render(<Spinner />);
		const icon = screen.getByRole('status');
		expect(icon).toBeInTheDocument();
		expect(icon).toHaveClass('animate-spin');
		expect(icon).toHaveStyle({ width: '16px', height: '16px' });
	});

	it('applies custom size', () => {
		render(<Spinner size={32} />);
		const icon = screen.getByRole('status');
		expect(icon).toHaveStyle({ width: '32px', height: '32px' });
	});

	it('applies custom color', () => {
		render(<Spinner color="rgb(255, 0, 0)" />);
		const icon = screen.getByRole('status');
		expect(icon).toHaveStyle({ color: 'rgb(255, 0, 0)' });
	});

	it('merges custom className', () => {
		render(<Spinner className="text-blue-500" />);
		const icon = screen.getByRole('status');
		expect(icon).toHaveClass('animate-spin');
		expect(icon).toHaveClass('text-blue-500');
	});

	// Chromium runs a transform animation on an <svg> on the main thread every
	// frame; on a wrapping element it runs on the compositor.
	it('spins a wrapper, never the svg itself', () => {
		render(<Spinner />);
		expect(screen.getByRole('status')).toHaveClass('animate-spin');
		expect(screen.getByTestId('loader2-icon')).not.toHaveClass('animate-spin');
	});
});
