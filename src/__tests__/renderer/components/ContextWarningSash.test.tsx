/**
 * Tests for ContextWarningSash component
 *
 * This component displays a warning banner when context window usage
 * reaches configurable thresholds (yellow at 60%, red at 80% by default).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextWarningSash } from '../../../renderer/components/ContextWarningSash';
import {
	AA_CONTRAST,
	contrastRatio,
	hexToRgb,
	readableTextOn,
	transparentize,
} from '../../../shared/colorContrast';
import type { Theme } from '../../../renderer/types';

describe('ContextWarningSash', () => {
	// Test fixtures
	const theme: Theme = {
		id: 'test-theme',
		name: 'Test Theme',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a24',
			bgSidebar: '#141420',
			bgActivity: '#24243a',
			border: '#3a3a5a',
			textMain: '#fff8e8',
			textDim: '#a8a0a0',
			accent: '#f4c430',
			accentDim: 'rgba(244, 196, 48, 0.25)',
			accentText: '#ffd54f',
			accentForeground: '#1a1a24',
			success: '#66d9a0',
			warning: '#f4c430',
			error: '#e05070',
		},
	};

	let mockOnSummarizeClick: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnSummarizeClick = vi.fn();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('visibility rules', () => {
		it('should not render when disabled', () => {
			const { container } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={false}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('should not render when context usage is below yellow threshold', () => {
			const { container } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={50}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('should render when context usage is at yellow threshold', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={60}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('should render when context usage is above yellow threshold', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('should render when context usage is at red threshold', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={80}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('should render when context usage is above red threshold', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={90}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
	});

	describe('warning level display', () => {
		it('should show yellow warning message between thresholds', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={65}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText(/Context window reaching/)).toBeInTheDocument();
			expect(screen.getByText('65%')).toBeInTheDocument();
			expect(screen.getByText(/capacity/)).toBeInTheDocument();
		});

		it('should show red warning message at red threshold', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={85}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText(/Context window at/)).toBeInTheDocument();
			expect(screen.getByText('85%')).toBeInTheDocument();
			expect(screen.getByText(/consider compacting to continue/)).toBeInTheDocument();
		});

		it('should display correct percentage value', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={73}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText('73%')).toBeInTheDocument();
		});
	});

	describe('button interactions', () => {
		it('should call onSummarizeClick when Compact button is clicked', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			const button = screen.getByText('Compact & Continue');
			fireEvent.click(button);
			expect(mockOnSummarizeClick).toHaveBeenCalledTimes(1);
		});

		it('should dismiss warning when dismiss button is clicked', () => {
			const { container, rerender } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();

			// Click dismiss button
			const dismissButton = screen.getByTitle('Dismiss');
			fireEvent.click(dismissButton);

			// Re-render with same props to verify dismissal
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('should reappear after dismissal when usage increases by 10%', () => {
			const { container, rerender } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);

			// Dismiss the warning
			const dismissButton = screen.getByTitle('Dismiss');
			fireEvent.click(dismissButton);

			// Re-render with same usage - should be hidden
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();

			// Re-render with 10% increase - should reappear
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={80}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('should reappear after dismissal when crossing to red threshold', () => {
			const { container, rerender } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={65}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);

			// Dismiss at yellow level
			const dismissButton = screen.getByTitle('Dismiss');
			fireEvent.click(dismissButton);

			// Verify dismissed
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={65}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();

			// Cross to red - should reappear even though it's less than 10% increase
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={80}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
			expect(screen.getByText(/consider compacting to continue/)).toBeInTheDocument();
		});
	});

	describe('tab-based dismissal', () => {
		it('should reset dismissal state when tab changes', () => {
			const { container, rerender } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
					tabId="tab-1"
				/>
			);

			// Dismiss warning for tab-1
			const dismissButton = screen.getByTitle('Dismiss');
			fireEvent.click(dismissButton);
			expect(container.firstChild).toBeNull();

			// Change to different tab - should show warning again
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
					tabId="tab-2"
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('should have role="alert" for screen readers', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('should have aria-live="polite"', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			const alert = screen.getByRole('alert');
			expect(alert).toHaveAttribute('aria-live', 'polite');
		});

		it('should have descriptive aria-label', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			const alert = screen.getByRole('alert');
			expect(alert).toHaveAttribute('aria-label', 'Context window at 70% capacity');
		});

		it('should have accessible dismiss button', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			const dismissButton = screen.getByTitle('Dismiss');
			expect(dismissButton).toHaveAttribute('aria-label', 'Dismiss warning');
		});

		it('should have tabIndex for summarize button', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			const button = screen.getByText('Compact & Continue');
			expect(button).toHaveAttribute('tabIndex', '0');
		});

		it('should support keyboard activation of compact button', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={70}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			const button = screen.getByText('Compact & Continue');
			fireEvent.keyDown(button, { key: 'Enter' });
			expect(mockOnSummarizeClick).toHaveBeenCalledTimes(1);
		});
	});

	describe('custom thresholds', () => {
		it('should respect custom yellow threshold', () => {
			const { container } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={45}
					yellowThreshold={40}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
			expect(screen.getByText(/Context window reaching/)).toBeInTheDocument();
		});

		it('should respect custom red threshold', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={75}
					yellowThreshold={60}
					redThreshold={70}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText(/consider compacting to continue/)).toBeInTheDocument();
		});

		it('should handle threshold edge cases correctly', () => {
			// At exactly yellow threshold
			const { rerender } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={60}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText(/Context window reaching/)).toBeInTheDocument();

			// At exactly red threshold
			rerender(
				<ContextWarningSash
					theme={theme}
					contextUsage={80}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText(/consider compacting to continue/)).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('should handle 0% usage', () => {
			const { container } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={0}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('should handle 100% usage', () => {
			render(
				<ContextWarningSash
					theme={theme}
					contextUsage={100}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(screen.getByText('100%')).toBeInTheDocument();
			expect(screen.getByText(/consider compacting to continue/)).toBeInTheDocument();
		});

		it('should handle usage at 1% below threshold', () => {
			const { container } = render(
				<ContextWarningSash
					theme={theme}
					contextUsage={59}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('theme-derived severity colors', () => {
		// A real light theme, not the dark fixture with mode flipped: the sash
		// derives its wash from bgMain, so a light theme has to carry a light one.
		const githubLight: Theme = {
			...theme,
			id: 'github-light-test',
			name: 'GitHub Light Test',
			mode: 'light',
			colors: {
				...theme.colors,
				bgMain: '#ffffff',
				textMain: '#24292f',
				accentForeground: '#ffffff',
				warning: '#9a6700',
				error: '#cf222e',
			},
		};

		/** jsdom normalizes inline colors to `rgb(...)`, so expectations do too. */
		const asRgb = (hex: string) => {
			const rgb = hexToRgb(hex);
			if (!rgb) throw new Error(`unparseable color: ${hex}`);
			return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
		};

		/** The wash the sash paints for a severity, mirroring the component. */
		const severityBackground = (t: Theme, severity: 'warning' | 'error') =>
			transparentize(t.colors[severity], t.colors.bgMain, t.mode === 'light' ? 0.12 : 0.15);

		const renderAt = (t: Theme, usage: number) =>
			render(
				<ContextWarningSash
					theme={t}
					contextUsage={usage}
					yellowThreshold={60}
					redThreshold={80}
					enabled={true}
					onSummarizeClick={mockOnSummarizeClick}
				/>
			);

		it.each([
			['dark', theme],
			['light', githubLight],
		] as const)('keeps yellow warning text readable on a %s theme', (_mode, t) => {
			renderAt(t, 65);
			const background = severityBackground(t, 'warning');
			const expectedText = readableTextOn(t.colors.warning, [background]);

			expect(screen.getByText(/reaching/)).toHaveStyle({ color: expectedText });
			expect(contrastRatio(expectedText, background)).toBeGreaterThanOrEqual(AA_CONTRAST);
		});

		it.each([
			['dark', theme],
			['light', githubLight],
		] as const)('keeps red warning text readable on a %s theme', (_mode, t) => {
			renderAt(t, 85);
			const background = severityBackground(t, 'error');
			const expectedText = readableTextOn(t.colors.error, [background]);

			expect(screen.getByText(/consider compacting/)).toHaveStyle({ color: expectedText });
			expect(contrastRatio(expectedText, background)).toBeGreaterThanOrEqual(AA_CONTRAST);
		});

		it('washes the sash with the theme error color rather than a fixed red', () => {
			const teal: Theme = {
				...theme,
				id: 'teal-error',
				colors: { ...theme.colors, error: '#00b3a4' },
			};
			const { container } = renderAt(teal, 85);
			const sash = container.querySelector('.context-warning-sash') as HTMLElement;

			expect(sash).toHaveStyle({ backgroundColor: severityBackground(teal, 'error') });
			// jsdom does not reflect the `border` shorthand into computed style, so
			// the border is asserted off the inline style the component wrote.
			expect(sash.style.border).toBe(
				`1px solid ${asRgb(transparentize('#00b3a4', teal.colors.bgMain, 0.5))}`
			);
		});

		it('paints the compact button with readable text on the severity fill', () => {
			renderAt(theme, 85);
			const button = screen.getByText('Compact & Continue');
			const expectedText = readableTextOn(theme.colors.accentForeground, [theme.colors.error]);

			expect(button).toHaveStyle({ backgroundColor: theme.colors.error, color: expectedText });
			expect(contrastRatio(expectedText, theme.colors.error)).toBeGreaterThanOrEqual(AA_CONTRAST);
		});
	});
});
