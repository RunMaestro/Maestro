import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VibeCoverageView } from '../../../../renderer/components/vibes/VibeCoverageView';
import type { Theme } from '../../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	BarChart3: () => <span data-testid="icon-barchart">BarChart3</span>,
	FileCheck: () => <span data-testid="icon-filecheck">FileCheck</span>,
	FileX: () => <span data-testid="icon-filex">FileX</span>,
	FileMinus: () => <span data-testid="icon-fileminus">FileMinus</span>,
	Filter: () => <span data-testid="icon-filter">Filter</span>,
	ArrowUpDown: () => <span data-testid="icon-arrowupdown">ArrowUpDown</span>,
	AlertTriangle: () => <span data-testid="icon-alert">AlertTriangle</span>,
	Database: () => <span data-testid="icon-database">Database</span>,
	Loader2: () => <span data-testid="icon-loader">Loader2</span>,
	Settings: () => <span data-testid="icon-settings">Settings</span>,
	FolderOpen: () => <span data-testid="icon-folderopen">FolderOpen</span>,
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#1e1f29',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.2)',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const mockCoverageData = [
	{
		file_path: 'src/main.ts',
		coverage_status: 'full',
		annotation_count: 12,
	},
	{
		file_path: 'src/utils/helpers.ts',
		coverage_status: 'partial',
		annotation_count: 5,
	},
	{
		file_path: 'src/config.ts',
		coverage_status: 'uncovered',
		annotation_count: 0,
	},
	{
		file_path: 'src/index.ts',
		coverage_status: 'full',
		annotation_count: 8,
	},
];

// Setup window.maestro mock
const mockGetCoverage = vi.fn();
const mockBuild = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	mockGetCoverage.mockResolvedValue({
		success: true,
		data: JSON.stringify(mockCoverageData),
	});

	mockBuild.mockResolvedValue({ success: true });

	(window as any).maestro = {
		vibes: {
			getCoverage: mockGetCoverage,
			build: mockBuild,
		},
	};
});

describe('VibeCoverageView', () => {
	// ========================================================================
	// Initial rendering and data loading
	// ========================================================================

	it('renders loading state while fetching coverage data', () => {
		mockGetCoverage.mockReturnValue(new Promise(() => {}));

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		expect(screen.getByText('Loading coverage data...')).toBeTruthy();
	});

	it('fetches coverage data on mount', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(mockGetCoverage).toHaveBeenCalledWith('/test/project');
		});
	});

	it('renders file list after loading', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		expect(screen.getByText('src/utils/helpers.ts')).toBeTruthy();
		expect(screen.getByText('src/config.ts')).toBeTruthy();
		expect(screen.getByText('src/index.ts')).toBeTruthy();
	});

	// ========================================================================
	// Coverage summary
	// ========================================================================

	it('displays coverage percentage', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			// 2 full + 0.5 * 1 partial = 2.5 / 4 = 62.5% → 63%
			expect(screen.getByText('63%')).toBeTruthy();
		});
	});

	it('displays file count stats', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('4 files')).toBeTruthy();
		});

		expect(screen.getByText('2 covered')).toBeTruthy();
		expect(screen.getByText('1 partial')).toBeTruthy();
		expect(screen.getByText('1 uncovered')).toBeTruthy();
	});

	it('displays total annotation count', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('25 annotations')).toBeTruthy();
		});
	});

	// ========================================================================
	// Coverage status badges
	// ========================================================================

	it('shows correct status badges for each file', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// "Covered" appears as: filter button + 2 status badges = 3 total
		const coveredElements = screen.getAllByText('Covered');
		expect(coveredElements.length).toBe(3);

		// "Partial" appears once as status badge (filter has different text)
		expect(screen.getByText('Partial')).toBeTruthy();

		// "Uncovered" appears as: filter button + 1 status badge = 2 total
		const uncoveredElements = screen.getAllByText('Uncovered');
		expect(uncoveredElements.length).toBe(2);
	});

	// ========================================================================
	// Filter options
	// ========================================================================

	it('renders filter buttons', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('All')).toBeTruthy();
		});

		// "Covered" and "Uncovered" appear in both filter buttons and status badges
		expect(screen.getAllByText('Covered').length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText('Uncovered').length).toBeGreaterThanOrEqual(1);
	});

	it('filters to show only covered files', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Click "Covered" filter — the filter button, not the status badge
		const filterButtons = screen.getAllByText('Covered');
		// The filter button is in the header area
		fireEvent.click(filterButtons[0]);

		// Covered files should remain
		expect(screen.getByText('src/main.ts')).toBeTruthy();
		expect(screen.getByText('src/utils/helpers.ts')).toBeTruthy();
		expect(screen.getByText('src/index.ts')).toBeTruthy();

		// Uncovered file should be hidden
		expect(screen.queryByText('src/config.ts')).toBeNull();
	});

	it('filters to show only uncovered files', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Click "Uncovered" filter
		const uncoveredButtons = screen.getAllByText('Uncovered');
		fireEvent.click(uncoveredButtons[0]);

		// Uncovered file should show
		expect(screen.getByText('src/config.ts')).toBeTruthy();

		// Covered files should be hidden
		expect(screen.queryByText('src/main.ts')).toBeNull();
		expect(screen.queryByText('src/index.ts')).toBeNull();
	});

	it('shows message when filter returns no results', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{ file_path: 'src/main.ts', coverage_status: 'full', annotation_count: 10 },
			]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Click "Uncovered" filter — no uncovered files exist
		fireEvent.click(screen.getByText('Uncovered'));

		expect(screen.getByText('No files match the current filter.')).toBeTruthy();
	});

	// ========================================================================
	// Sort options
	// ========================================================================

	it('renders sort buttons', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Status')).toBeTruthy();
		});

		expect(screen.getByText('Path')).toBeTruthy();
		expect(screen.getByText('Annotations')).toBeTruthy();
	});

	// ========================================================================
	// Empty state
	// ========================================================================

	it('shows empty state when no coverage data exists', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('No tracked files')).toBeTruthy();
		});

		expect(screen.getByText(/no AI annotation coverage data/)).toBeTruthy();
		expect(screen.getByText(/tracked_extensions/)).toBeTruthy();
	});

	// ========================================================================
	// Build Required state
	// ========================================================================

	it('shows Build Required when database is missing', async () => {
		mockGetCoverage.mockResolvedValue({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Build Required')).toBeTruthy();
		});

		expect(screen.getByText('Build Now')).toBeTruthy();
	});

	it('calls build when Build Now button is clicked', async () => {
		mockGetCoverage.mockResolvedValueOnce({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Build Now')).toBeTruthy();
		});

		// After build succeeds, coverage will be re-fetched
		mockGetCoverage.mockResolvedValueOnce({
			success: true,
			data: JSON.stringify(mockCoverageData),
		});

		fireEvent.click(screen.getByText('Build Now'));

		await waitFor(() => {
			expect(mockBuild).toHaveBeenCalledWith('/test/project');
		});
	});

	// ========================================================================
	// Error state
	// ========================================================================

	it('shows error state on fetch failure', async () => {
		mockGetCoverage.mockResolvedValue({
			success: false,
			error: 'Something went wrong',
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Something went wrong')).toBeTruthy();
		});
	});

	it('shows error state on exception', async () => {
		mockGetCoverage.mockRejectedValue(new Error('Network error'));

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Network error')).toBeTruthy();
		});
	});

	// ========================================================================
	// Footer
	// ========================================================================

	it('displays footer with file count and annotation total', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('4 of 4 files')).toBeTruthy();
		});

		expect(screen.getByText('25 total annotations')).toBeTruthy();
	});

	// ========================================================================
	// Alternative data formats
	// ========================================================================

	it('handles nested files array in coverage response', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify({
				files: [
					{ file_path: 'src/nested.ts', coverage_status: 'full', annotation_count: 3 },
				],
			}),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/nested.ts')).toBeTruthy();
		});
	});

	it('does not fetch when projectPath is undefined', () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath={undefined}
			/>,
		);

		expect(mockGetCoverage).not.toHaveBeenCalled();
	});
});
