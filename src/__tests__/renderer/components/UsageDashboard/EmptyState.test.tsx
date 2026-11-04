/**
 * Tests for EmptyState component
 *
 * Verifies:
 * - Renders empty state container with correct test ID
 * - Displays chart icon illustration
 * - Shows default title and message
 * - Supports custom title and message
 * - Applies theme colors properly
 * - Theme-aware styling for all elements
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { EmptyState } from '../../../../renderer/components/UsageDashboard/EmptyState';
import { THEMES } from '../../../../shared/themes';

// Test themes
const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['solarized-light'];

describe('EmptyState', () => {
	describe('Rendering', () => {
		it('renders the empty state container with correct test ID', () => {
			render(<EmptyState theme={darkTheme} />);

			expect(screen.getByTestId('usage-dashboard-empty')).toBeInTheDocument();
		});

		it('renders the chart icon illustration', () => {
			render(<EmptyState theme={darkTheme} />);

			// The container should have the icon (BarChart3 renders as svg)
			const container = screen.getByTestId('usage-dashboard-empty');
			const svgs = container.querySelectorAll('svg');

			// Should have at least 2 svgs: main icon and decorative bars
			expect(svgs.length).toBeGreaterThanOrEqual(2);
		});

		it('displays the default title', () => {
			render(<EmptyState theme={darkTheme} />);

			expect(screen.getByText('No usage data yet')).toBeInTheDocument();
		});

		it('displays the default message', () => {
			render(<EmptyState theme={darkTheme} />);

			expect(screen.getByText('Start using Maestro to see your stats!')).toBeInTheDocument();
		});
	});

	describe('Custom Content', () => {
		it('supports custom title', () => {
			render(<EmptyState theme={darkTheme} title="No data for this period" />);

			expect(screen.getByText('No data for this period')).toBeInTheDocument();
			expect(screen.queryByText('No usage data yet')).not.toBeInTheDocument();
		});

		it('supports custom message', () => {
			render(<EmptyState theme={darkTheme} message="Try selecting a different time range." />);

			expect(screen.getByText('Try selecting a different time range.')).toBeInTheDocument();
			expect(screen.queryByText('Start using Maestro to see your stats!')).not.toBeInTheDocument();
		});

		it('supports both custom title and message', () => {
			render(
				<EmptyState theme={darkTheme} title="Custom Title" message="Custom message for testing." />
			);

			expect(screen.getByText('Custom Title')).toBeInTheDocument();
			expect(screen.getByText('Custom message for testing.')).toBeInTheDocument();
		});
	});

	describe('Theme Styling', () => {
		it('applies theme textDim color to container', () => {
			render(<EmptyState theme={darkTheme} />);

			const container = screen.getByTestId('usage-dashboard-empty');
			expect(container).toHaveStyle({ color: darkTheme.colors.textDim });
		});

		it('applies theme textMain color to title', () => {
			render(<EmptyState theme={darkTheme} />);

			const title = screen.getByText('No usage data yet');
			expect(title).toHaveStyle({ color: darkTheme.colors.textMain });
		});

		it('works with light theme', () => {
			render(<EmptyState theme={lightTheme} />);

			const container = screen.getByTestId('usage-dashboard-empty');
			expect(container).toHaveStyle({ color: lightTheme.colors.textDim });

			const title = screen.getByText('No usage data yet');
			expect(title).toHaveStyle({ color: lightTheme.colors.textMain });
		});
	});

	describe('Layout', () => {
		it('uses flexbox centering layout', () => {
			render(<EmptyState theme={darkTheme} />);

			const container = screen.getByTestId('usage-dashboard-empty');
			expect(container).toHaveClass('flex');
			expect(container).toHaveClass('flex-col');
			expect(container).toHaveClass('items-center');
			expect(container).toHaveClass('justify-center');
		});

		it('has gap between icon and text', () => {
			render(<EmptyState theme={darkTheme} />);

			const container = screen.getByTestId('usage-dashboard-empty');
			expect(container).toHaveClass('gap-4');
		});

		it('has full height container', () => {
			render(<EmptyState theme={darkTheme} />);

			const container = screen.getByTestId('usage-dashboard-empty');
			expect(container).toHaveClass('h-full');
		});
	});

	describe('Icon Styling', () => {
		it('renders decorative svg with theme-aware fills', () => {
			render(<EmptyState theme={darkTheme} />);

			const container = screen.getByTestId('usage-dashboard-empty');
			const rects = container.querySelectorAll('rect');

			// The decorative bars should have rect elements
			expect(rects.length).toBeGreaterThan(0);

			// Check that rects use the theme color
			rects.forEach((rect) => {
				expect(rect.getAttribute('fill')).toBe(darkTheme.colors.textDim);
			});
		});
	});

	describe('Accessibility', () => {
		it('has a data-testid for testing', () => {
			render(<EmptyState theme={darkTheme} />);

			expect(screen.getByTestId('usage-dashboard-empty')).toBeInTheDocument();
		});

		it('text is visible and readable', () => {
			render(<EmptyState theme={darkTheme} />);

			const title = screen.getByText('No usage data yet');
			const message = screen.getByText('Start using Maestro to see your stats!');

			// Text should be in the document and visible
			expect(title).toBeVisible();
			expect(message).toBeVisible();
		});
	});
});
