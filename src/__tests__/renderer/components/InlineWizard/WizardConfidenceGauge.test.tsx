/**
 * Tests for WizardConfidenceGauge.tsx
 *
 * Tests the compact horizontal confidence gauge component:
 * - Percentage display with correct color
 * - Progress bar width based on confidence
 * - Glow effect when confidence >= 80
 * - Color transitions: red (0-39) -> orange (40) -> yellow (79) -> green (80+)
 * - Green only appears at/above the ready threshold (80)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WizardConfidenceGauge } from '../../../../renderer/components/InlineWizard/WizardConfidenceGauge';
import type { Theme } from '../../../../renderer/types';

// Mock theme for testing
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		background: '#1a1a1a',
		backgroundDim: '#0d0d0d',
		backgroundBright: '#2a2a2a',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		textMuted: '#666666',
		textBright: '#ffffff',
		border: '#333333',
		borderBright: '#444444',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
		accent: '#007bff',
		accentForeground: '#ffffff',
	},
};

describe('WizardConfidenceGauge', () => {
	describe('percentage display', () => {
		it('displays the confidence percentage', () => {
			render(<WizardConfidenceGauge confidence={75} theme={mockTheme} />);
			expect(screen.getByText('75%')).toBeInTheDocument();
		});

		it('rounds confidence to nearest integer', () => {
			render(<WizardConfidenceGauge confidence={75.7} theme={mockTheme} />);
			expect(screen.getByText('76%')).toBeInTheDocument();
		});

		it('displays 0% for zero confidence', () => {
			render(<WizardConfidenceGauge confidence={0} theme={mockTheme} />);
			expect(screen.getByText('0%')).toBeInTheDocument();
		});

		it('displays 100% for full confidence', () => {
			render(<WizardConfidenceGauge confidence={100} theme={mockTheme} />);
			expect(screen.getByText('100%')).toBeInTheDocument();
		});
	});

	describe('confidence clamping', () => {
		it('clamps negative values to 0%', () => {
			render(<WizardConfidenceGauge confidence={-10} theme={mockTheme} />);
			expect(screen.getByText('0%')).toBeInTheDocument();
		});

		it('clamps values above 100 to 100%', () => {
			render(<WizardConfidenceGauge confidence={150} theme={mockTheme} />);
			expect(screen.getByText('100%')).toBeInTheDocument();
		});
	});

	describe('title attribute', () => {
		it('shows basic confidence tooltip when under threshold', () => {
			const { container } = render(<WizardConfidenceGauge confidence={50} theme={mockTheme} />);
			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveAttribute('title', 'Project Understanding Confidence: 50%');
		});

		it('shows ready message in tooltip when at threshold', () => {
			const { container } = render(<WizardConfidenceGauge confidence={80} theme={mockTheme} />);
			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveAttribute(
				'title',
				'Project Understanding Confidence: 80% - Ready to proceed'
			);
		});

		it('shows ready message in tooltip when above threshold', () => {
			const { container } = render(<WizardConfidenceGauge confidence={95} theme={mockTheme} />);
			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveAttribute(
				'title',
				'Project Understanding Confidence: 95% - Ready to proceed'
			);
		});
	});

	describe('label display', () => {
		it('displays the Project Understanding Confidence label', () => {
			render(<WizardConfidenceGauge confidence={50} theme={mockTheme} />);
			expect(screen.getByText('Project Understanding Confidence')).toBeInTheDocument();
		});

		it('styles the label with dim text color', () => {
			render(<WizardConfidenceGauge confidence={50} theme={mockTheme} />);
			const label = screen.getByText('Project Understanding Confidence');
			expect(label).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('progress bar', () => {
		it('uses bgActivity color for progress bar background', () => {
			const { container } = render(<WizardConfidenceGauge confidence={50} theme={mockTheme} />);
			// The progress bar container should have the bgActivity background
			const progressContainer = container.querySelector('.overflow-hidden');
			expect(progressContainer).toHaveStyle({
				backgroundColor: mockTheme.colors.bgActivity,
			});
		});

		it('sets progress bar width based on confidence', () => {
			const { container } = render(<WizardConfidenceGauge confidence={75} theme={mockTheme} />);
			// Find the progress fill element (absolute positioned inside the overflow-hidden container)
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).toHaveStyle({ width: '75%' });
		});

		it('sets 0% width for zero confidence', () => {
			const { container } = render(<WizardConfidenceGauge confidence={0} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).toHaveStyle({ width: '0%' });
		});

		it('sets 100% width for full confidence', () => {
			const { container } = render(<WizardConfidenceGauge confidence={100} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).toHaveStyle({ width: '100%' });
		});
	});

	describe('glow effect for ready state', () => {
		it('does not apply glow animation when confidence is below 80', () => {
			const { container } = render(<WizardConfidenceGauge confidence={79} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).not.toHaveClass('animate-confidence-glow');
		});

		it('applies glow animation when confidence is exactly 80', () => {
			const { container } = render(<WizardConfidenceGauge confidence={80} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).toHaveClass('animate-confidence-glow');
		});

		it('applies glow animation when confidence is above 80', () => {
			const { container } = render(<WizardConfidenceGauge confidence={95} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).toHaveClass('animate-confidence-glow');
		});

		it('applies box-shadow when confidence is at ready threshold', () => {
			const { container } = render(<WizardConfidenceGauge confidence={85} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			// Box shadow should be applied when ready
			const styles = progressFill?.getAttribute('style') || '';
			expect(styles).toContain('box-shadow');
		});

		it('does not apply box-shadow when confidence is below threshold', () => {
			const { container } = render(<WizardConfidenceGauge confidence={50} theme={mockTheme} />);
			const progressFill = container.querySelector('.absolute');
			expect(progressFill).toHaveStyle({ boxShadow: 'none' });
		});
	});

	describe('color transitions', () => {
		// Note: Colors are converted from HSL to RGB by the browser/jsdom
		// We test that different confidence levels produce different colors

		it('uses red-ish color for low confidence (0-25)', () => {
			render(<WizardConfidenceGauge confidence={10} theme={mockTheme} />);
			const percentageText = screen.getByText('10%');
			// Browser converts HSL to RGB - check that color is applied
			const color = percentageText.style.color;
			expect(color).toBeTruthy();
			// Red channel should be high for low confidence (red/orange range)
			const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
			expect(rgbMatch).not.toBeNull();
			if (rgbMatch) {
				const red = parseInt(rgbMatch[1], 10);
				expect(red).toBeGreaterThan(150); // Strong red component
			}
		});

		it('uses yellow-ish color for medium confidence (around 50)', () => {
			render(<WizardConfidenceGauge confidence={50} theme={mockTheme} />);
			const percentageText = screen.getByText('50%');
			const color = percentageText.style.color;
			expect(color).toBeTruthy();
			// Yellow has high red AND high green
			const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
			expect(rgbMatch).not.toBeNull();
			if (rgbMatch) {
				const red = parseInt(rgbMatch[1], 10);
				const green = parseInt(rgbMatch[2], 10);
				// Both red and green should be relatively high for yellow
				expect(red).toBeGreaterThan(150);
				expect(green).toBeGreaterThan(100);
			}
		});

		it('uses green-ish color for high confidence (80-100)', () => {
			render(<WizardConfidenceGauge confidence={100} theme={mockTheme} />);
			const percentageText = screen.getByText('100%');
			const color = percentageText.style.color;
			expect(color).toBeTruthy();
			// Green should be high, red should be relatively lower for pure green
			const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
			expect(rgbMatch).not.toBeNull();
			if (rgbMatch) {
				const green = parseInt(rgbMatch[2], 10);
				// Green should be reasonably high
				expect(green).toBeGreaterThan(100);
			}
		});

		it('produces different colors for different confidence levels', () => {
			const { unmount: unmount1 } = render(
				<WizardConfidenceGauge confidence={10} theme={mockTheme} />
			);
			const lowColor = screen.getByText('10%').style.color;
			unmount1();

			const { unmount: unmount2 } = render(
				<WizardConfidenceGauge confidence={50} theme={mockTheme} />
			);
			const midColor = screen.getByText('50%').style.color;
			unmount2();

			const { unmount: unmount3 } = render(
				<WizardConfidenceGauge confidence={100} theme={mockTheme} />
			);
			const highColor = screen.getByText('100%').style.color;
			unmount3();

			// Each confidence level should produce a different color
			expect(lowColor).not.toBe(midColor);
			expect(midColor).not.toBe(highColor);
			expect(lowColor).not.toBe(highColor);
		});
	});
});
