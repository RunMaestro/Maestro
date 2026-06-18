/**
 * Tests for PullToRefresh.tsx
 *
 * Tests for the pull-to-refresh visual indicator component including:
 * - PullToRefreshIndicator component (main export)
 * - RefreshIcon internal component (via PullToRefreshIndicator)
 * - ArrowDownIcon internal component (via PullToRefreshIndicator)
 * - hexToRgb helper function (via component rendering)
 * - PullToRefreshIndicatorProps interface
 * - PullToRefreshWrapperProps interface (type export)
 * - Default export
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PullToRefreshIndicator, {
	PullToRefreshIndicator as NamedExport,
	PullToRefreshIndicatorProps,
	PullToRefreshWrapperProps,
} from '../../../web/components/PullToRefresh';
import * as themeProvider from '../../../web/components/ThemeProvider';

// Mock the ThemeProvider's useThemeColors hook
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: vi.fn(),
}));

const mockedUseThemeColors = vi.mocked(themeProvider.useThemeColors);

describe('PullToRefresh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedUseThemeColors.mockReturnValue({
			accent: '#ff5500',
			textDim: '#888888',
			background: '#1a1a1a',
			textMain: '#ffffff',
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('exports', () => {
		it('exports PullToRefreshIndicator as default', () => {
			expect(PullToRefreshIndicator).toBeDefined();
			expect(typeof PullToRefreshIndicator).toBe('function');
		});

		it('exports PullToRefreshIndicator as named export', () => {
			expect(NamedExport).toBeDefined();
			expect(typeof NamedExport).toBe('function');
		});

		it('default export equals named export', () => {
			expect(PullToRefreshIndicator).toBe(NamedExport);
		});

		it('exports PullToRefreshIndicatorProps interface (type check)', () => {
			const props: PullToRefreshIndicatorProps = {
				pullDistance: 50,
				progress: 0.5,
				isRefreshing: false,
				isThresholdReached: false,
			};
			expect(props).toBeDefined();
		});

		it('exports PullToRefreshWrapperProps interface (type check)', () => {
			const props: PullToRefreshWrapperProps = {
				onRefresh: async () => {},
				children: null,
			};
			expect(props).toBeDefined();
		});

		it('PullToRefreshWrapperProps accepts all optional properties', () => {
			const props: PullToRefreshWrapperProps = {
				onRefresh: () => Promise.resolve(),
				children: <div>Test</div>,
				enabled: true,
				style: { backgroundColor: 'red' },
				contentStyle: { padding: '10px' },
				className: 'test-class',
			};
			expect(props.enabled).toBe(true);
			expect(props.style).toEqual({ backgroundColor: 'red' });
			expect(props.contentStyle).toEqual({ padding: '10px' });
			expect(props.className).toBe('test-class');
		});

		it('PullToRefreshWrapperProps onRefresh can return void', () => {
			const syncProps: PullToRefreshWrapperProps = {
				onRefresh: () => {},
				children: null,
			};
			expect(typeof syncProps.onRefresh).toBe('function');
		});
	});

	describe('PullToRefreshIndicator component', () => {
		describe('rendering conditions', () => {
			it('returns null when pullDistance is 0 and not refreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={0}
						progress={0}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				expect(container.firstChild).toBeNull();
			});

			it('renders when pullDistance > 0', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				expect(container.firstChild).not.toBeNull();
			});

			it('renders when isRefreshing even if pullDistance is 0', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={0}
						progress={0}
						isRefreshing={true}
						isThresholdReached={false}
					/>
				);
				expect(container.firstChild).not.toBeNull();
			});

			it('renders when both pullDistance > 0 and isRefreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={true}
						isThresholdReached={true}
					/>
				);
				expect(container.firstChild).not.toBeNull();
			});
		});

		describe('text content', () => {
			it('shows "Pull to refresh" when not refreshing and threshold not reached', () => {
				render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				expect(screen.getByText('Pull to refresh')).toBeInTheDocument();
			});

			it('shows "Release to refresh" when threshold is reached', () => {
				render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				expect(screen.getByText('Release to refresh')).toBeInTheDocument();
			});

			it('shows "Refreshing..." when isRefreshing', () => {
				render(
					<PullToRefreshIndicator
						pullDistance={60}
						progress={1}
						isRefreshing={true}
						isThresholdReached={true}
					/>
				);
				expect(screen.getByText('Refreshing...')).toBeInTheDocument();
			});

			it('shows "Refreshing..." even if threshold not reached (isRefreshing takes priority)', () => {
				render(
					<PullToRefreshIndicator
						pullDistance={60}
						progress={0.5}
						isRefreshing={true}
						isThresholdReached={false}
					/>
				);
				expect(screen.getByText('Refreshing...')).toBeInTheDocument();
			});
		});

		describe('container styling', () => {
			it('applies absolute positioning', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.position).toBe('absolute');
				expect(outerDiv.style.top).toBe('0px');
				expect(outerDiv.style.left).toBe('0px');
				expect(outerDiv.style.right).toBe('0px');
			});

			it('sets height based on pullDistance', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={75}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.height).toBe('75px');
			});

			it('sets minimum height of 60px when refreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={0}
						progress={0}
						isRefreshing={true}
						isThresholdReached={false}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.height).toBe('60px');
			});

			it('uses pullDistance if greater than 60 when refreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={100}
						progress={1}
						isRefreshing={true}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.height).toBe('100px');
			});

			it('applies transition when refreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={60}
						progress={1}
						isRefreshing={true}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.transition).toBe('height 0.3s ease');
			});

			it('has no transition when not refreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={60}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.transition).toBe('none');
			});

			it('applies flexbox layout to container', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.display).toBe('flex');
				expect(outerDiv.style.alignItems).toBe('center');
				expect(outerDiv.style.justifyContent).toBe('center');
			});

			it('sets overflow to hidden', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.overflow).toBe('hidden');
			});
		});

		describe('accent color parsing', () => {
			it('handles 3-digit hex colors', () => {
				mockedUseThemeColors.mockReturnValue({
					accent: '#fff',
					textDim: '#888888',
					background: '#1a1a1a',
					textMain: '#ffffff',
				});
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.backgroundColor).toBe('rgba(255, 255, 255, 0.2)');
			});

			it('handles rgb colors', () => {
				mockedUseThemeColors.mockReturnValue({
					accent: 'rgb(10, 20, 30)',
					textDim: '#888888',
					background: '#1a1a1a',
					textMain: '#ffffff',
				});
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.backgroundColor).toBe('rgba(10, 20, 30, 0.2)');
			});

			it('handles rgba colors by ignoring alpha', () => {
				mockedUseThemeColors.mockReturnValue({
					accent: 'rgba(10, 20, 30, 0.5)',
					textDim: '#888888',
					background: '#1a1a1a',
					textMain: '#ffffff',
				});
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.backgroundColor).toBe('rgba(10, 20, 30, 0.2)');
			});

			it('falls back to black for invalid colors', () => {
				mockedUseThemeColors.mockReturnValue({
					accent: 'not-a-color',
					textDim: '#888888',
					background: '#1a1a1a',
					textMain: '#ffffff',
				});
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.backgroundColor).toBe('rgba(0, 0, 0, 0.2)');
			});
		});

		describe('custom styles', () => {
			it('merges custom style prop with default styles', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
						style={{ zIndex: 100, backgroundColor: 'blue' }}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.zIndex).toBe('100');
				// Custom style overrides default backgroundColor
				expect(outerDiv.style.backgroundColor).toBe('blue');
			});

			it('custom style can add new properties', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
						style={{ borderBottom: '1px solid red' }}
					/>
				);
				const outerDiv = container.firstChild as HTMLElement;
				expect(outerDiv.style.borderBottom).toBe('1px solid red');
			});
		});

		describe('opacity calculation', () => {
			it('opacity is 0 when progress is 0', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={1}
						progress={0}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				// progress * 1.5 = 0, capped at min 1 -> so opacity = 0
				expect(innerDiv?.style.opacity).toBe('0');
			});

			it('opacity increases with progress (0.5 progress = 0.75 opacity)', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				// 0.5 * 1.5 = 0.75
				expect(innerDiv?.style.opacity).toBe('0.75');
			});

			it('opacity is capped at 1 when progress reaches 0.67+', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				// 1 * 1.5 = 1.5, capped at 1
				expect(innerDiv?.style.opacity).toBe('1');
			});

			it('opacity is capped at 1 for progress > 1', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={100}
						progress={2}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				// 2 * 1.5 = 3, capped at 1
				expect(innerDiv?.style.opacity).toBe('1');
			});
		});

		describe('scale calculation', () => {
			it('scale starts at 0.8 when progress is 0', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={1}
						progress={0}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				// 0.8 + 0 * 0.2 = 0.8
				expect(innerDiv?.style.transform).toBe('scale(0.8)');
			});

			it('scale grows with progress (0.5 progress = 0.9 scale)', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				// 0.8 + 0.5 * 0.2 = 0.9
				expect(innerDiv?.style.transform).toBe('scale(0.9)');
			});

			it('scale is 1 when threshold is reached', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={80}
						progress={1}
						isRefreshing={false}
						isThresholdReached={true}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				expect(innerDiv?.style.transform).toBe('scale(1)');
			});

			it('scale is 1 when refreshing', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={60}
						progress={0.5}
						isRefreshing={true}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				expect(innerDiv?.style.transform).toBe('scale(1)');
			});
		});

		describe('inner container styling', () => {
			it('has flex column layout', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				expect(innerDiv?.style.display).toBe('flex');
				expect(innerDiv?.style.flexDirection).toBe('column');
				expect(innerDiv?.style.alignItems).toBe('center');
				expect(innerDiv?.style.justifyContent).toBe('center');
				expect(innerDiv?.style.gap).toBe('4px');
			});

			it('has scale transition', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
				expect(innerDiv?.style.transition).toBe('transform 0.15s ease');
			});
		});

		describe('text styling', () => {
			it('applies correct font styles to text', () => {
				const { container } = render(
					<PullToRefreshIndicator
						pullDistance={50}
						progress={0.5}
						isRefreshing={false}
						isThresholdReached={false}
					/>
				);
				const textSpan = container.querySelector('span');
				expect(textSpan?.style.fontSize).toBe('12px');
				expect(textSpan?.style.fontWeight).toBe('500');
				expect(textSpan?.style.color).toBe('rgb(136, 136, 136)'); // #888888
			});
		});
	});

	describe('RefreshIcon (internal component, tested via PullToRefreshIndicator)', () => {
		it('renders SVG with refresh icon when refreshing', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// Check for path with partial circle (refresh icon)
			expect(container.querySelector('path[d="M21 12a9 9 0 1 1-6.219-8.56"]')).toBeInTheDocument();
		});

		it('includes spin animation keyframes when spinning', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			// Look for the style element with keyframes
			const styleElement = container.querySelector('style');
			expect(styleElement).toBeInTheDocument();
			expect(styleElement?.textContent).toContain('@keyframes spin');
			expect(styleElement?.textContent).toContain('from { transform: rotate(0deg); }');
			expect(styleElement?.textContent).toContain('to { transform: rotate(360deg); }');
		});

		it('applies spin animation to SVG when spinning', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.style.animation).toBe('spin 1s linear infinite');
		});

		it('uses default size of 24 for refresh icon', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('width')).toBe('24');
			expect(svg?.getAttribute('height')).toBe('24');
		});

		it('applies theme accent color to refresh icon stroke', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('stroke')).toBe('#ff5500');
		});

		it('has viewBox 0 0 24 24', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
		});

		it('has strokeWidth 2 and round line caps/joins', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('stroke-width')).toBe('2');
			expect(svg?.getAttribute('stroke-linecap')).toBe('round');
			expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
		});

		it('has no fill', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('fill')).toBe('none');
		});

		it('includes polyline for arrow part of refresh icon', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			expect(container.querySelector('polyline[points="21 3 21 9 15 9"]')).toBeInTheDocument();
		});
	});

	describe('ArrowDownIcon (internal component, tested via PullToRefreshIndicator)', () => {
		it('renders SVG with arrow icon when not refreshing', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// Check for line element (arrow shaft)
			expect(container.querySelector('line[x1="12"]')).toBeInTheDocument();
		});

		it('arrow points down (rotation 0) when progress < 1', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.style.transform).toBe('rotate(0deg)');
		});

		it('arrow points up (rotation 180) when progress >= 1', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.style.transform).toBe('rotate(180deg)');
		});

		it('arrow points up when progress > 1', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={100}
					progress={1.5}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.style.transform).toBe('rotate(180deg)');
		});

		it('has rotate transition', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.style.transition).toBe('transform 0.2s ease');
		});

		it('uses default size of 24 for arrow icon', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('width')).toBe('24');
			expect(svg?.getAttribute('height')).toBe('24');
		});

		it('applies theme accent color to arrow icon stroke', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('stroke')).toBe('#ff5500');
		});

		it('has correct arrow polyline points', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			// Arrow head polyline
			expect(container.querySelector('polyline[points="19 12 12 19 5 12"]')).toBeInTheDocument();
		});

		it('has correct arrow line coordinates', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const line = container.querySelector('line');
			expect(line?.getAttribute('x1')).toBe('12');
			expect(line?.getAttribute('y1')).toBe('5');
			expect(line?.getAttribute('x2')).toBe('12');
			expect(line?.getAttribute('y2')).toBe('19');
		});
	});

	describe('hexToRgb helper (tested via background color)', () => {
		// hexToRgb is internal, we test it through the backgroundColor which uses it

		it('converts hex color to rgba for background', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const outerDiv = container.firstChild as HTMLElement;
			// bgOpacity = min(0.5 * 0.3, 0.2) = 0.15
			// accent is #ff5500 -> 255, 85, 0
			expect(outerDiv.style.backgroundColor).toContain('rgba(255, 85, 0');
		});

		it('background opacity increases with progress (capped at 0.2)', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			const outerDiv = container.firstChild as HTMLElement;
			// bgOpacity = min(1 * 0.3, 0.2) = 0.2
			expect(outerDiv.style.backgroundColor).toContain('rgba(255, 85, 0, 0.2)');
		});

		it('background opacity is 0 when progress is 0', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={1}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const outerDiv = container.firstChild as HTMLElement;
			// bgOpacity = min(0 * 0.3, 0.2) = 0
			expect(outerDiv.style.backgroundColor).toContain('rgba(255, 85, 0, 0)');
		});

		it('background opacity caps at 0.2 for high progress values', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={100}
					progress={2}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			const outerDiv = container.firstChild as HTMLElement;
			// bgOpacity = min(2 * 0.3, 0.2) = 0.2 (capped)
			expect(outerDiv.style.backgroundColor).toContain('rgba(255, 85, 0, 0.2)');
		});
	});

	describe('icon switching between ArrowDown and Refresh', () => {
		it('shows arrow icon when not refreshing', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			// Arrow has line element
			expect(container.querySelector('line')).toBeInTheDocument();
			// No style element with keyframes (only RefreshIcon has that)
			expect(container.querySelector('style')).not.toBeInTheDocument();
		});

		it('shows refresh icon when refreshing', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			// Refresh icon has path element with specific d value
			expect(container.querySelector('path[d="M21 12a9 9 0 1 1-6.219-8.56"]')).toBeInTheDocument();
			// Has style element with keyframes
			expect(container.querySelector('style')).toBeInTheDocument();
		});

		it('switches from arrow to refresh icon when isRefreshing changes', () => {
			const { container, rerender } = render(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			// Initially shows arrow
			expect(container.querySelector('line')).toBeInTheDocument();
			expect(container.querySelector('style')).not.toBeInTheDocument();

			// Rerender with isRefreshing=true
			rerender(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			// Now shows refresh icon
			expect(container.querySelector('line')).not.toBeInTheDocument();
			expect(container.querySelector('style')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles very small pullDistance (1px)', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={1}
					progress={0.01}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const outerDiv = container.firstChild as HTMLElement;
			expect(outerDiv.style.height).toBe('1px');
		});

		it('handles very large pullDistance', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={500}
					progress={5}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			const outerDiv = container.firstChild as HTMLElement;
			expect(outerDiv.style.height).toBe('500px');
		});

		it('handles negative pullDistance (renders with 0 height)', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={-10}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			// Component still renders since pullDistance !== 0 (it's -10)
			// but Math.max sets height to 0
			const outerDiv = container.firstChild as HTMLElement;
			expect(outerDiv).not.toBeNull();
			// Math.max(-10, 0) = 0
			expect(outerDiv.style.height).toBe('0px');
		});

		it('handles fractional progress values', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.333}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const innerDiv = (container.firstChild as HTMLElement).querySelector('div');
			// 0.333 * 1.5 = 0.4995
			expect(parseFloat(innerDiv?.style.opacity || '0')).toBeCloseTo(0.4995, 2);
		});

		it('handles progress exactly at threshold boundary (0.99999)', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={79}
					progress={0.99999}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			// Should still rotate 0 degrees since progress < 1
			expect(svg?.style.transform).toBe('rotate(0deg)');
		});

		it('handles progress exactly at 1', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			const svg = container.querySelector('svg');
			// Should rotate 180 degrees since progress >= 1
			expect(svg?.style.transform).toBe('rotate(180deg)');
		});
	});

	describe('state transitions', () => {
		it('transitions from initial pull to threshold reached', () => {
			const { container, rerender } = render(
				<PullToRefreshIndicator
					pullDistance={20}
					progress={0.25}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

			rerender(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Release to refresh')).toBeInTheDocument();
		});

		it('transitions from threshold reached to refreshing', () => {
			const { rerender } = render(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Release to refresh')).toBeInTheDocument();

			rerender(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Refreshing...')).toBeInTheDocument();
		});

		it('transitions from refreshing back to hidden', () => {
			const { container, rerender } = render(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			expect(container.firstChild).not.toBeNull();

			rerender(
				<PullToRefreshIndicator
					pullDistance={0}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('complete pull-refresh cycle', () => {
			const { container, rerender } = render(
				<PullToRefreshIndicator
					pullDistance={0}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			// Initial: hidden
			expect(container.firstChild).toBeNull();

			// Start pulling
			rerender(
				<PullToRefreshIndicator
					pullDistance={30}
					progress={0.4}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

			// Reach threshold
			rerender(
				<PullToRefreshIndicator
					pullDistance={80}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Release to refresh')).toBeInTheDocument();

			// Release - start refreshing
			rerender(
				<PullToRefreshIndicator
					pullDistance={60}
					progress={1}
					isRefreshing={true}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Refreshing...')).toBeInTheDocument();

			// Complete - back to hidden
			rerender(
				<PullToRefreshIndicator
					pullDistance={0}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('integration scenarios', () => {
		it('works with different theme colors', async () => {
			// The mock provides #ff5500 as accent
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('stroke')).toBe('#ff5500');
		});

		it('maintains correct structure across re-renders', () => {
			const { container, rerender } = render(
				<PullToRefreshIndicator
					pullDistance={50}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);

			for (let i = 0; i < 10; i++) {
				const progress = (i + 1) / 10;
				rerender(
					<PullToRefreshIndicator
						pullDistance={50 + i * 5}
						progress={progress}
						isRefreshing={false}
						isThresholdReached={progress >= 1}
					/>
				);
				expect(container.querySelector('svg')).toBeInTheDocument();
				expect(container.querySelector('span')).toBeInTheDocument();
			}
		});

		it('handles rapid state changes', () => {
			const { container, rerender } = render(
				<PullToRefreshIndicator
					pullDistance={0}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);

			// Simulate rapid changes
			for (let i = 0; i < 20; i++) {
				const isRefreshing = i % 3 === 0;
				const pullDistance = isRefreshing ? 60 : i % 2 === 0 ? 0 : 50;
				rerender(
					<PullToRefreshIndicator
						pullDistance={pullDistance}
						progress={pullDistance / 80}
						isRefreshing={isRefreshing}
						isThresholdReached={pullDistance >= 80}
					/>
				);
			}

			// Component should still render correctly
			expect(true).toBe(true); // No crash
		});
	});
});
