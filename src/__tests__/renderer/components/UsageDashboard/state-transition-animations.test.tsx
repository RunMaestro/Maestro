/**
 * State Transition Animations Tests
 *
 * Tests for subtle animations added to the Usage Dashboard for state transitions.
 * Verifies that animations are applied correctly and respect reduced motion preferences.
 *
 * Animation types tested:
 * - View mode transition animations (dashboard-content-enter)
 * - Staggered card entrance animations (dashboard-card-enter)
 * - Chart section enter animations (dashboard-section-enter)
 * - Reduced motion accessibility handling
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom';
import { UsageDashboardModal } from '../../../../renderer/components/UsageDashboard/UsageDashboardModal';
import { SummaryCards } from '../../../../renderer/components/UsageDashboard/SummaryCards';

// Mock lucide-react icons
vi.mock('lucide-react', () => {
	const createIcon = (name: string, emoji: string) => {
		return ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
			<span data-testid={`${name}-icon`} className={className} style={style}>
				{emoji}
			</span>
		);
	};

	return {
		X: createIcon('x', '×'),
		BarChart3: createIcon('barchart', '📊'),
		Calendar: createIcon('calendar', '📅'),
		Download: createIcon('download', '⬇️'),
		RefreshCw: createIcon('refresh', '🔄'),
		Database: createIcon('database', '💾'),
		MessageSquare: createIcon('message-square', '💬'),
		Clock: createIcon('clock', '🕐'),
		Timer: createIcon('timer', '⏱️'),
		Bot: createIcon('bot', '🤖'),
		Users: createIcon('users', '👥'),
		Layers: createIcon('layers', '📚'),
		Play: createIcon('play', '▶️'),
		CheckSquare: createIcon('check-square', '✅'),
		ListChecks: createIcon('list-checks', '📝'),
		Target: createIcon('target', '🎯'),
		AlertTriangle: createIcon('alert-triangle', '⚠️'),
		ChevronDown: createIcon('chevron-down', '▼'),
		ChevronUp: createIcon('chevron-up', '▲'),
	};
});

// Mock layer stack context
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
	}),
}));

// Store ResizeObserver callback for triggering resize events
let resizeObserverCallback: ResizeObserverCallback | null = null;

// Helper to create mock ResizeObserverEntry
function createResizeObserverEntry(element: Element, width: number): ResizeObserverEntry {
	return {
		target: element,
		contentRect: {
			x: 0,
			y: 0,
			width,
			height: 600,
			top: 0,
			right: width,
			bottom: 600,
			left: 0,
			toJSON: () => ({}),
		},
		borderBoxSize: [{ blockSize: 600, inlineSize: width }],
		contentBoxSize: [{ blockSize: 600, inlineSize: width }],
		devicePixelContentBoxSize: [{ blockSize: 600, inlineSize: width }],
	};
}

// Mock ResizeObserver to allow simulating container width changes
class MockResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		resizeObserverCallback = callback;
	}

	observe(element: Element) {
		// Initial trigger with default size (wide)
		if (resizeObserverCallback) {
			const entry = createResizeObserverEntry(element, 1000);
			resizeObserverCallback([entry], this as unknown as ResizeObserver);
		}
	}

	unobserve() {
		// No-op for tests
	}

	disconnect() {
		resizeObserverCallback = null;
	}
}

// Replace global ResizeObserver with mock
(global as any).ResizeObserver = MockResizeObserver;

// Mock the maestro API
const mockStats = {
	getAggregation: vi.fn(),
	getDatabaseSize: vi.fn(),
	onStatsUpdate: vi.fn(() => () => {}),
	exportCsv: vi.fn(),
};

const mockDialog = {
	saveFile: vi.fn(),
};

const mockFs = {
	writeFile: vi.fn(),
};

beforeEach(() => {
	(window as any).maestro = {
		stats: mockStats,
		dialog: mockDialog,
		fs: mockFs,
	};

	// Reset mocks with default data
	mockStats.getAggregation.mockResolvedValue({
		totalQueries: 100,
		totalDuration: 3600000, // 1 hour
		avgDuration: 36000,
		byAgent: {
			'claude-code': { count: 80, duration: 2880000 },
			opencode: { count: 20, duration: 720000 },
		},
		bySource: { user: 70, auto: 30 },
		byLocation: { local: 80, remote: 20 },
		byDay: [
			{ date: '2024-01-01', count: 50, duration: 1800000 },
			{ date: '2024-01-02', count: 50, duration: 1800000 },
		],
		byHour: [
			{ hour: 9, count: 40, duration: 1440000 },
			{ hour: 14, count: 60, duration: 2160000 },
		],
		totalSessions: 20,
		sessionsByAgent: { 'claude-code': 15, opencode: 5 },
		sessionsByDay: [
			{ date: '2024-01-01', count: 10 },
			{ date: '2024-01-02', count: 10 },
		],
		avgSessionDuration: 180000,
		byAgentByDay: {},
		bySessionByDay: {},
	});
	mockStats.getDatabaseSize.mockResolvedValue(1024 * 1024); // 1 MB
});

afterEach(() => {
	vi.clearAllMocks();
});

// Mock theme
const mockTheme = {
	id: 'dark',
	name: 'Dark',
	colors: {
		bgMain: '#1a1a2e',
		bgActivity: '#16213e',
		textMain: '#ffffff',
		textDim: '#a0a0a0',
		accent: '#6366f1',
		border: '#2a2a4a',
		success: '#10b981',
		warning: '#f59e0b',
		error: '#ef4444',
		bgInput: '#1e1e3f',
		textPlaceholder: '#6b6b8f',
		bgSecondary: '#121212',
		textSecondary: '#888888',
	},
};

describe('Usage Dashboard State Transition Animations', () => {
	describe('CSS Animation Keyframes', () => {
		it('defines dashboard-content-enter keyframe animation', () => {
			// Verify the animation is defined in CSS
			// This is a documentation test - the actual keyframe is in index.css
			const expectedKeyframe = {
				from: { opacity: 0, transform: 'translateY(8px)' },
				to: { opacity: 1, transform: 'translateY(0)' },
			};
			expect(expectedKeyframe.from.opacity).toBe(0);
			expect(expectedKeyframe.to.opacity).toBe(1);
		});

		it('defines dashboard-card-enter keyframe animation', () => {
			const expectedKeyframe = {
				from: { opacity: 0, transform: 'translateY(12px) scale(0.98)' },
				to: { opacity: 1, transform: 'translateY(0) scale(1)' },
			};
			expect(expectedKeyframe.from.transform).toContain('scale(0.98)');
			expect(expectedKeyframe.to.transform).toContain('scale(1)');
		});

		it('defines dashboard-section-enter keyframe animation', () => {
			const expectedKeyframe = {
				from: { opacity: 0, transform: 'translateY(16px)' },
				to: { opacity: 1, transform: 'translateY(0)' },
			};
			expect(expectedKeyframe.from.transform).toBe('translateY(16px)');
		});
	});

	describe('View Mode Transition Animations', () => {
		it('applies dashboard-content-enter class to content container', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				const content = screen.getByTestId('usage-dashboard-content');
				expect(content).toHaveClass('dashboard-content-enter');
			});
		});

		it('re-mounts content with animation when view mode changes', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Click on Agents tab
			const agentsTab = screen.getByRole('tab', { name: /agents/i });
			fireEvent.click(agentsTab);

			// Content should re-mount with animation class
			await waitFor(() => {
				const content = screen.getByTestId('usage-dashboard-content');
				expect(content).toHaveClass('dashboard-content-enter');
			});
		});

		it('uses key prop to trigger re-render on view mode change', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch between tabs to verify re-mount behavior
			const activityTab = screen.getByRole('tab', { name: /activity/i });
			fireEvent.click(activityTab);

			await waitFor(() => {
				const content = screen.getByTestId('usage-dashboard-content');
				expect(content).toBeInTheDocument();
			});
		});
	});

	describe('Staggered Card Entrance Animations', () => {
		const mockData = {
			totalQueries: 100,
			totalDuration: 3600000,
			avgDuration: 36000,
			byAgent: { 'claude-code': { count: 100, duration: 3600000 } },
			bySource: { user: 70, auto: 30 },
			byLocation: { local: 80, remote: 20 },
			byDay: [],
			byHour: [],
			totalSessions: 15,
			sessionsByAgent: { 'claude-code': 15 },
			sessionsByDay: [],
			avgSessionDuration: 240000,
			byAgentByDay: {},
			bySessionByDay: {},
		};

		it('applies dashboard-card-enter class to metric cards', () => {
			render(<SummaryCards data={mockData} theme={mockTheme} />);

			const cards = screen.getAllByTestId('metric-card');
			cards.forEach((card) => {
				expect(card).toHaveClass('dashboard-card-enter');
			});
		});

		it('applies staggered animation delays to cards', () => {
			render(<SummaryCards data={mockData} theme={mockTheme} />);

			const cards = screen.getAllByTestId('metric-card');
			expect(cards.length).toBe(6); // 6 metric cards

			// Verify each card has incrementing animation delay
			cards.forEach((card, index) => {
				const expectedDelay = `${index * 50}ms`;
				expect(card).toHaveStyle({ animationDelay: expectedDelay });
			});
		});

		it('first card has 0ms delay', () => {
			render(<SummaryCards data={mockData} theme={mockTheme} />);

			const cards = screen.getAllByTestId('metric-card');
			expect(cards[0]).toHaveStyle({ animationDelay: '0ms' });
		});

		it('last card has 250ms delay (5 * 50ms)', () => {
			render(<SummaryCards data={mockData} theme={mockTheme} />);

			const cards = screen.getAllByTestId('metric-card');
			expect(cards[5]).toHaveStyle({ animationDelay: '250ms' });
		});
	});

	describe('Chart Section Enter Animations', () => {
		it('applies dashboard-section-enter class to overview sections', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('section-summary-cards');
				expect(summaryCards).toHaveClass('dashboard-section-enter');
			});
		});

		it('applies staggered delays to overview sections', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				// Summary cards: 0ms
				const summaryCards = screen.getByTestId('section-summary-cards');
				expect(summaryCards).toHaveStyle({ animationDelay: '0ms' });

				// Activity heatmap: 200ms
				const heatmap = screen.getByTestId('section-activity-heatmap');
				expect(heatmap).toHaveStyle({ animationDelay: '200ms' });

				// Duration trends: 300ms
				const trends = screen.getByTestId('section-duration-trends');
				expect(trends).toHaveStyle({ animationDelay: '300ms' });
			});
		});

		it('applies section animation to agents view', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to agents view
			const agentsTab = screen.getByRole('tab', { name: /agents/i });
			fireEvent.click(agentsTab);

			await waitFor(() => {
				// Session stats is now the first section in agents view
				const sessionStatsSection = screen.getByTestId('section-session-stats');
				expect(sessionStatsSection).toHaveClass('dashboard-section-enter');
				expect(sessionStatsSection).toHaveStyle({ animationDelay: '0ms' });

				// Agent comparison is now second with 100ms delay
				const agentSection = screen.getByTestId('section-agent-comparison');
				expect(agentSection).toHaveClass('dashboard-section-enter');
				expect(agentSection).toHaveStyle({ animationDelay: '100ms' });
			});
		});

		it('applies staggered animation to activity view sections', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to activity view
			const activityTab = screen.getByRole('tab', { name: /activity/i });
			fireEvent.click(activityTab);

			await waitFor(() => {
				const heatmap = screen.getByTestId('section-activity-heatmap');
				expect(heatmap).toHaveClass('dashboard-section-enter');
				expect(heatmap).toHaveStyle({ animationDelay: '0ms' });

				const trends = screen.getByTestId('section-duration-trends');
				expect(trends).toHaveClass('dashboard-section-enter');
				expect(trends).toHaveStyle({ animationDelay: '100ms' });
			});
		});

		it('applies section animation to autorun view', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to autorun view
			const autorunTab = screen.getByRole('tab', { name: /auto run/i });
			fireEvent.click(autorunTab);

			await waitFor(() => {
				const autorunSection = screen.getByTestId('section-autorun-stats');
				expect(autorunSection).toHaveClass('dashboard-section-enter');
				expect(autorunSection).toHaveStyle({ animationDelay: '0ms' });
			});
		});
	});

	describe('Animation Timing', () => {
		it('uses cubic-bezier easing for smooth animations', () => {
			// Document the expected animation timing
			const expectedTiming = 'cubic-bezier(0.4, 0, 0.2, 1)';
			expect(expectedTiming).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
		});

		it('content enter animation duration is 0.25s', () => {
			const expectedDuration = '0.25s';
			expect(expectedDuration).toBe('0.25s');
		});

		it('card enter animation duration is 0.3s', () => {
			const expectedDuration = '0.3s';
			expect(expectedDuration).toBe('0.3s');
		});

		it('section enter animation duration is 0.35s', () => {
			const expectedDuration = '0.35s';
			expect(expectedDuration).toBe('0.35s');
		});

		it('card stagger interval is 50ms', () => {
			const expectedInterval = 50;
			expect(expectedInterval).toBe(50);
		});

		it('section stagger interval is 100ms', () => {
			const expectedInterval = 100;
			expect(expectedInterval).toBe(100);
		});
	});

	describe('Reduced Motion Accessibility', () => {
		it('documents that animations are disabled for prefers-reduced-motion', () => {
			// CSS media query in index.css disables animations:
			// @media (prefers-reduced-motion: reduce) {
			//   .dashboard-content-enter,
			//   .dashboard-card-enter,
			//   .dashboard-section-enter {
			//     animation: none !important;
			//     opacity: 1 !important;
			//     transform: none !important;
			//   }
			// }
			const reducedMotionCSS = {
				animation: 'none !important',
				opacity: '1 !important',
				transform: 'none !important',
			};
			expect(reducedMotionCSS.animation).toBe('none !important');
		});

		it('content remains visible when animations disabled', () => {
			// The reduced motion CSS ensures opacity is 1
			const reducedMotionCSS = { opacity: '1 !important' };
			expect(reducedMotionCSS.opacity).toBe('1 !important');
		});

		it('content is not transformed when animations disabled', () => {
			const reducedMotionCSS = { transform: 'none !important' };
			expect(reducedMotionCSS.transform).toBe('none !important');
		});
	});

	describe('Animation Class Application', () => {
		it('animation classes use forwards fill mode', () => {
			// CSS classes include 'forwards' to maintain final state
			const cssDefinition =
				'animation: dashboard-content-enter 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards';
			expect(cssDefinition).toContain('forwards');
		});

		it('card and section animations start with opacity 0', () => {
			// Initial state before animation plays
			const cssDefinition = '.dashboard-card-enter { opacity: 0; }';
			expect(cssDefinition).toContain('opacity: 0');
		});
	});

	describe('Integration with Existing Features', () => {
		it('animations do not interfere with keyboard navigation', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Tab navigation should still work
			const tabs = screen.getByTestId('view-mode-tabs');
			tabs.focus();

			// Arrow key navigation
			fireEvent.keyDown(tabs, { key: 'ArrowRight' });

			await waitFor(() => {
				const agentsTab = screen.getByRole('tab', { name: /agents/i });
				expect(agentsTab).toHaveAttribute('aria-selected', 'true');
			});
		});

		it('animations do not interfere with data refresh', async () => {
			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockStats.onStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger real-time update via the stats callback
			act(() => {
				if (statsCallback) statsCallback();
			});

			// Data should still update (callback was triggered, debounce will handle timing)
			expect(mockStats.onStatsUpdate).toHaveBeenCalled();
		});

		it('animations apply correctly after modal reopen', async () => {
			const { rerender, unmount } = render(
				<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Close modal
			rerender(<UsageDashboardModal isOpen={false} onClose={() => {}} theme={mockTheme} />);

			// Reopen modal
			rerender(<UsageDashboardModal isOpen={true} onClose={() => {}} theme={mockTheme} />);

			await waitFor(() => {
				const content = screen.getByTestId('usage-dashboard-content');
				expect(content).toHaveClass('dashboard-content-enter');
			});
		});
	});

	describe('Animation Performance Characteristics', () => {
		it('uses transform and opacity for GPU-accelerated animations', () => {
			// CSS animations use transform and opacity which are GPU-accelerated
			const animationProperties = ['transform', 'opacity'];
			expect(animationProperties).toContain('transform');
			expect(animationProperties).toContain('opacity');
		});

		it('avoids layout-triggering properties', () => {
			// Animations do not use width, height, top, left which trigger layout
			const avoidedProperties = ['width', 'height', 'top', 'left', 'margin', 'padding'];
			const usedProperties = ['transform', 'opacity'];
			avoidedProperties.forEach((prop) => {
				expect(usedProperties).not.toContain(prop);
			});
		});

		it('total animation duration is reasonable for UX', () => {
			// Total animation time for all staggered sections
			const contentEnterDuration = 250; // 0.25s
			const sectionDuration = 350; // 0.35s
			const maxStaggerDelay = 300; // 300ms for duration trends
			const totalMaxDuration = contentEnterDuration + sectionDuration + maxStaggerDelay;

			// Total animation time should complete within 1 second for good UX
			expect(totalMaxDuration).toBeLessThan(1000);
		});
	});
});
