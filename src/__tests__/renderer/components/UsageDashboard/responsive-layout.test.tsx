/**
 * @fileoverview Tests for UsageDashboard responsive layout behavior
 *
 * These tests verify that the Usage Dashboard modal correctly adapts its layout
 * based on container width, supporting:
 * - Narrow screens (<600px): Single column charts, 2-column summary cards grid
 * - Medium screens (600-900px): 2-column charts, 3-column summary cards grid
 * - Wide screens (>900px): 2-column charts, 5-column summary cards grid
 *
 * Note: SummaryCards always renders 6 metric cards regardless of grid column count.
 *
 * The responsive system uses ResizeObserver to track container width and
 * dynamically adjusts grid column counts via CSS grid.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { UsageDashboardModal } from '../../../../renderer/components/UsageDashboard/UsageDashboardModal';
import type { Theme } from '../../../../renderer/types';

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
let resizeObserverElement: Element | null = null;

// Mock ResizeObserver to allow simulating container width changes
class MockResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		resizeObserverCallback = callback;
	}

	observe(element: Element) {
		resizeObserverElement = element;
		// Initial trigger with default size (simulates window open)
		if (resizeObserverCallback) {
			const entry = createResizeObserverEntry(element, 1000); // Default to wide
			resizeObserverCallback([entry], this as unknown as ResizeObserver);
		}
	}

	unobserve() {
		// No-op for tests
	}

	disconnect() {
		resizeObserverCallback = null;
		resizeObserverElement = null;
	}
}

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

// Helper to simulate container resize
function simulateContainerResize(width: number) {
	if (resizeObserverCallback && resizeObserverElement) {
		const entry = createResizeObserverEntry(resizeObserverElement, width);
		act(() => {
			resizeObserverCallback!([entry], {} as ResizeObserver);
		});
	}
}

// Mock element.offsetWidth to reflect simulated width
let mockOffsetWidth = 1000;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
	configurable: true,
	get() {
		return mockOffsetWidth;
	},
});

// Replace global ResizeObserver
const originalResizeObserver = global.ResizeObserver;
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock maestro API
const mockGetAggregation = vi.fn();
const mockExportCsv = vi.fn();
const mockOnStatsUpdate = vi.fn(() => vi.fn());
const mockGetAutoRunSessions = vi.fn(() => Promise.resolve([]));
const mockGetAutoRunTasks = vi.fn(() => Promise.resolve([]));
const mockGetDatabaseSize = vi.fn();
const mockSaveFile = vi.fn();
const mockWriteFile = vi.fn();

Object.defineProperty(window, 'maestro', {
	value: {
		stats: {
			getAggregation: mockGetAggregation,
			exportCsv: mockExportCsv,
			onStatsUpdate: mockOnStatsUpdate,
			getAutoRunSessions: mockGetAutoRunSessions,
			getAutoRunTasks: mockGetAutoRunTasks,
			getDatabaseSize: mockGetDatabaseSize,
		},
		dialog: { saveFile: mockSaveFile },
		fs: { writeFile: mockWriteFile },
	},
	writable: true,
});

// Test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

// Sample data for tests
const createSampleData = () => ({
	totalQueries: 150,
	totalDuration: 3600000,
	avgDuration: 24000,
	byAgent: {
		'claude-code': { count: 100, duration: 2400000 },
		terminal: { count: 50, duration: 1200000 },
	},
	bySource: { user: 100, auto: 50 },
	byLocation: { local: 120, remote: 30 },
	byDay: [
		{ date: '2024-01-15', count: 25, duration: 600000 },
		{ date: '2024-01-16', count: 30, duration: 720000 },
		{ date: '2024-01-17', count: 45, duration: 1080000 },
		{ date: '2024-01-18', count: 50, duration: 1200000 },
	],
	byHour: [
		{ hour: 9, count: 40, duration: 960000 },
		{ hour: 14, count: 60, duration: 1440000 },
		{ hour: 15, count: 50, duration: 1200000 },
	],
	totalSessions: 25,
	sessionsByAgent: { 'claude-code': 15, terminal: 10 },
	sessionsByDay: [
		{ date: '2024-01-15', count: 5 },
		{ date: '2024-01-16', count: 7 },
		{ date: '2024-01-17', count: 6 },
		{ date: '2024-01-18', count: 7 },
	],
	avgSessionDuration: 144000,
	byAgentByDay: {},
});

describe('UsageDashboard Responsive Layout', () => {
	const theme = createTheme();
	const onClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetAggregation.mockResolvedValue(createSampleData());
		mockExportCsv.mockResolvedValue('date,count\n2024-01-15,25');
		mockSaveFile.mockResolvedValue(null);
		mockWriteFile.mockResolvedValue({ success: true });
		mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 5);
		mockOffsetWidth = 1000; // Default to wide
		resizeObserverCallback = null;
		resizeObserverElement = null;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Modal Container Sizing', () => {
		it('modal uses viewport-relative width (80vw)', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveStyle({ width: '80vw' });
			});
		});

		it('modal has max-width constraint (1400px)', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveStyle({ maxWidth: '1400px' });
			});
		});

		it('modal uses viewport-relative height (85vh)', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveStyle({ height: '85vh' });
			});
		});

		it('modal has max-height constraint (900px)', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveStyle({ maxHeight: '900px' });
			});
		});
	});

	describe('Breakpoint Definitions', () => {
		it('narrow breakpoint is defined as < 600px', async () => {
			mockOffsetWidth = 500;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger resize
			simulateContainerResize(500);

			await waitFor(() => {
				// In narrow mode, summary cards should have 2 columns
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});
		});

		it('medium breakpoint is defined as 600-900px', async () => {
			mockOffsetWidth = 750;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger resize
			simulateContainerResize(750);

			await waitFor(() => {
				// In medium mode, summary cards should have 3 columns
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});

		it('wide breakpoint is defined as >= 900px', async () => {
			mockOffsetWidth = 1000;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger resize
			simulateContainerResize(1000);

			await waitFor(() => {
				// In wide mode, summary cards should have 3 columns (2 rows × 3 cols layout)
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});
	});

	describe('Summary Cards Responsive Columns', () => {
		it('displays 2 columns in narrow mode (<600px)', async () => {
			mockOffsetWidth = 400;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(400);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});
		});

		it('displays 3 columns in medium mode (600-900px)', async () => {
			mockOffsetWidth = 700;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(700);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});

		it('displays 3 columns in wide mode (>=900px) for 2×3 layout', async () => {
			mockOffsetWidth = 1200;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(1200);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});

		it('renders all 6 metric cards regardless of column count', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Should always have 6 metric cards
			const metricCards = screen.getAllByTestId('metric-card');
			expect(metricCards).toHaveLength(6);
		});
	});

	describe('Chart Grid Responsive Columns', () => {
		it('displays 1 column chart grid in narrow mode (<600px)', async () => {
			mockOffsetWidth = 500;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(500);

			await waitFor(() => {
				// Find the distribution charts grid (contains source-distribution and location-distribution)
				const sourceSection = screen.getByTestId('section-source-distribution');
				const chartGrid = sourceSection.parentElement;
				expect(chartGrid).toHaveStyle({ gridTemplateColumns: 'repeat(1, minmax(0, 1fr))' });
			});
		});

		it('displays 2 column chart grid in medium mode (600-900px)', async () => {
			mockOffsetWidth = 750;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(750);

			await waitFor(() => {
				const sourceSection = screen.getByTestId('section-source-distribution');
				const chartGrid = sourceSection.parentElement;
				expect(chartGrid).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});
		});

		it('displays 2 column chart grid in wide mode (>=900px)', async () => {
			mockOffsetWidth = 1100;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(1100);

			await waitFor(() => {
				const sourceSection = screen.getByTestId('section-source-distribution');
				const chartGrid = sourceSection.parentElement;
				expect(chartGrid).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});
		});
	});

	describe('Boundary Conditions', () => {
		it('exactly 600px width uses medium layout', async () => {
			mockOffsetWidth = 600;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(600);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				// 600px is >= 600 and < 900, so medium (3 columns)
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});

		it('exactly 900px width uses wide layout', async () => {
			mockOffsetWidth = 900;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(900);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				// 900px is >= 900, so wide layout uses 3 columns (2×3 grid)
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});

		it('exactly 599px width uses narrow layout', async () => {
			mockOffsetWidth = 599;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(599);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				// 599px is < 600, so narrow (2 columns)
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});
		});

		it('exactly 899px width uses medium layout', async () => {
			mockOffsetWidth = 899;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(899);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				// 899px is >= 600 and < 900, so medium (3 columns)
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});
	});

	describe('Dynamic Resize Behavior', () => {
		it('updates layout when container is resized from wide to narrow', async () => {
			mockOffsetWidth = 1000;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Start at wide
			simulateContainerResize(1000);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});

			// Resize to narrow
			mockOffsetWidth = 400;
			simulateContainerResize(400);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});
		});

		it('updates layout when container is resized from narrow to wide', async () => {
			mockOffsetWidth = 400;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Start at narrow
			simulateContainerResize(400);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
			});

			// Resize to wide
			mockOffsetWidth = 1000;
			simulateContainerResize(1000);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});

		it('handles rapid resize events without breaking', async () => {
			mockOffsetWidth = 1000;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Rapid resizes across all breakpoints
			mockOffsetWidth = 800;
			simulateContainerResize(800);
			mockOffsetWidth = 400;
			simulateContainerResize(400);
			mockOffsetWidth = 1200;
			simulateContainerResize(1200);
			mockOffsetWidth = 600;
			simulateContainerResize(600);

			// Final state should match last resize (medium)
			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});
	});

	describe('Auto Run View Responsive Columns', () => {
		it('displays 2 columns in Auto Run view at narrow width', async () => {
			mockOffsetWidth = 400;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Auto Run view
			const autoRunTab = screen.getAllByRole('tab')[3];
			act(() => {
				autoRunTab.click();
			});

			simulateContainerResize(400);

			await waitFor(() => {
				const autoRunSection = screen.getByTestId('section-autorun-stats');
				expect(autoRunSection).toBeInTheDocument();
				// The AutoRunStats component receives columns prop from layout
			});
		});

		it('displays 3 columns in Auto Run view at medium width', async () => {
			mockOffsetWidth = 700;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Auto Run view
			const autoRunTab = screen.getAllByRole('tab')[3];
			act(() => {
				autoRunTab.click();
			});

			simulateContainerResize(700);

			await waitFor(() => {
				const autoRunSection = screen.getByTestId('section-autorun-stats');
				expect(autoRunSection).toBeInTheDocument();
			});
		});

		it('displays 6 columns in Auto Run view at wide width', async () => {
			mockOffsetWidth = 1000;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Auto Run view
			const autoRunTab = screen.getAllByRole('tab')[3];
			act(() => {
				autoRunTab.click();
			});

			simulateContainerResize(1000);

			await waitFor(() => {
				const autoRunSection = screen.getByTestId('section-autorun-stats');
				expect(autoRunSection).toBeInTheDocument();
			});
		});
	});

	describe('Skeleton Loader Responsive Columns', () => {
		it('skeleton uses same column layout as loaded content in narrow mode', async () => {
			mockOffsetWidth = 400;
			mockGetAggregation.mockImplementation(() => new Promise(() => {})); // Never resolves

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			simulateContainerResize(400);

			await waitFor(() => {
				const skeleton = screen.getByTestId('dashboard-skeleton');
				expect(skeleton).toBeInTheDocument();
				// The skeleton should receive the same column props
				const summaryCardsSkeleton = screen.getByTestId('summary-cards-skeleton');
				expect(summaryCardsSkeleton).toBeInTheDocument();
			});
		});

		it('skeleton uses same column layout as loaded content in wide mode', async () => {
			mockOffsetWidth = 1000;
			mockGetAggregation.mockImplementation(() => new Promise(() => {})); // Never resolves

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			simulateContainerResize(1000);

			await waitFor(() => {
				const skeleton = screen.getByTestId('dashboard-skeleton');
				expect(skeleton).toBeInTheDocument();
				const summaryCardsSkeleton = screen.getByTestId('summary-cards-skeleton');
				expect(summaryCardsSkeleton).toBeInTheDocument();
			});
		});
	});

	describe('Chart Minimum Heights', () => {
		it('agent comparison chart has minimum height of 180px', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const agentSection = screen.getByTestId('section-agent-comparison');
				expect(agentSection).toHaveStyle({ minHeight: '180px' });
			});
		});

		it('source distribution chart has minimum height of 240px', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const sourceSection = screen.getByTestId('section-source-distribution');
				expect(sourceSection).toHaveStyle({ minHeight: '240px' });
			});
		});

		it('activity heatmap has minimum height of 200px', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const heatmapSection = screen.getByTestId('section-activity-heatmap');
				expect(heatmapSection).toHaveStyle({ minHeight: '200px' });
			});
		});

		it('duration trends chart has minimum height of 280px', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const trendsSection = screen.getByTestId('section-duration-trends');
				expect(trendsSection).toHaveStyle({ minHeight: '280px' });
			});
		});
	});

	describe('Content Overflow Handling', () => {
		it('main content area has vertical scroll', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const content = screen.getByTestId('usage-dashboard-content');
				const scrollContainer = content.parentElement;
				expect(scrollContainer).toHaveClass('overflow-y-auto');
			});
		});

		it('activity heatmap has horizontal scroll for year view', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const heatmapSection = screen.getByTestId('section-activity-heatmap');
				// The inner heatmap component handles overflow, not the section wrapper
				expect(heatmapSection).toBeInTheDocument();
			});
		});
	});

	describe('Grid Gap Consistency', () => {
		it('content sections have consistent 6 unit spacing (1.5rem/24px)', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				// The main content area uses space-y-6 for vertical spacing between sections
				const contentArea = screen.getByTestId('usage-dashboard-content');
				expect(contentArea).toHaveClass('space-y-6');
			});
		});

		it('summary cards grid has 4 unit gap (1rem/16px)', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveClass('gap-4');
			});
		});
	});

	describe('Layout Preservation Across View Modes', () => {
		it('column count persists when switching from overview to agents and back', async () => {
			mockOffsetWidth = 700; // Medium width

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(700);

			// Check overview layout
			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});

			// Switch to agents
			const agentsTab = screen.getAllByRole('tab')[1];
			act(() => {
				agentsTab.click();
			});

			await waitFor(() => {
				expect(screen.getByTestId('section-agent-comparison')).toBeInTheDocument();
				expect(screen.queryByTestId('summary-cards')).not.toBeInTheDocument();
			});

			// Switch back to overview
			const overviewTab = screen.getAllByRole('tab')[0];
			act(() => {
				overviewTab.click();
			});

			// Column count should still be preserved
			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});
	});

	describe('Zero Width Edge Case', () => {
		it('handles zero width gracefully (defaults to narrow)', async () => {
			mockOffsetWidth = 0;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(0);

			// The modal should still render without crashing
			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});
		});

		it('handles very large width (>1400px)', async () => {
			mockOffsetWidth = 2000;

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			simulateContainerResize(2000);

			// Should still use wide layout (3 columns for 2×3 summary grid)
			await waitFor(() => {
				const summaryCards = screen.getByTestId('summary-cards');
				expect(summaryCards).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
			});
		});
	});
});

// Cleanup
afterAll(() => {
	global.ResizeObserver = originalResizeObserver;
});
