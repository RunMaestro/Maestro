/**
 * Tests for Spinner component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from '../../../../renderer/components/ui/Spinner';

describe('Spinner', () => {
	it('renders with default size', () => {
		render(<Spinner />);
		const icon = screen.getByTestId('loader2-icon');
		expect(icon).toBeInTheDocument();
		expect(icon).toHaveClass('animate-spin');
		expect(icon).toHaveStyle({ width: '16px', height: '16px' });
	});

	it('applies custom size', () => {
		render(<Spinner size={32} />);
		const icon = screen.getByTestId('loader2-icon');
		expect(icon).toHaveStyle({ width: '32px', height: '32px' });
	});

	it('applies custom color', () => {
		render(<Spinner color="rgb(255, 0, 0)" />);
		const icon = screen.getByTestId('loader2-icon');
		expect(icon).toHaveStyle({ color: 'rgb(255, 0, 0)' });
	});

	it('merges custom className', () => {
		render(<Spinner className="text-blue-500" />);
		const icon = screen.getByTestId('loader2-icon');
		expect(icon).toHaveClass('animate-spin');
		expect(icon).toHaveClass('text-blue-500');
	});
});
