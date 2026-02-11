import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VibesAnnotationLog } from '../../../../renderer/components/vibes/VibesAnnotationLog';
import type { Theme } from '../../../../renderer/types';
import type { VibesAnnotation } from '../../../../shared/vibes-types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Filter: () => <span data-testid="icon-filter">Filter</span>,
	Search: () => <span data-testid="icon-search">Search</span>,
	ChevronDown: () => <span data-testid="icon-chevron-down">v</span>,
	ChevronRight: () => <span data-testid="icon-chevron-right">&gt;</span>,
	FileCode: () => <span data-testid="icon-file-code">FileCode</span>,
	Clock: () => <span data-testid="icon-clock">Clock</span>,
	Terminal: () => <span data-testid="icon-terminal">Terminal</span>,
	MessageSquare: () => <span data-testid="icon-message">Message</span>,
	Brain: () => <span data-testid="icon-brain">Brain</span>,
	Play: () => <span data-testid="icon-play">Play</span>,
	Square: () => <span data-testid="icon-square">Square</span>,
	AlertTriangle: () => <span data-testid="icon-alert-triangle">AlertTriangle</span>,
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

const mockLineAnnotation: VibesAnnotation = {
	type: 'line',
	file_path: 'src/utils/helpers.ts',
	line_start: 10,
	line_end: 25,
	environment_hash: 'env-abc123',
	command_hash: 'cmd-def456',
	prompt_hash: 'prm-ghi789',
	action: 'create',
	timestamp: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
	session_id: 'session-001',
	assurance_level: 'medium',
};

const mockFunctionAnnotation: VibesAnnotation = {
	type: 'function',
	file_path: 'src/core/engine.ts',
	function_name: 'processData',
	function_signature: '(data: unknown) => Promise<Result>',
	environment_hash: 'env-xyz789',
	action: 'modify',
	timestamp: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
	assurance_level: 'high',
	reasoning_hash: 'rsn-aaa111',
};

const mockSessionStart: VibesAnnotation = {
	type: 'session',
	event: 'start',
	session_id: 'session-001',
	timestamp: new Date(Date.now() - 7_200_000).toISOString(), // 2h ago
	description: 'Auto Run started',
	assurance_level: 'medium',
};

const mockSessionEnd: VibesAnnotation = {
	type: 'session',
	event: 'end',
	session_id: 'session-001',
	timestamp: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
};

const mockDeleteAnnotation: VibesAnnotation = {
	type: 'line',
	file_path: 'src/legacy/old-module.ts',
	line_start: 1,
	line_end: 50,
	environment_hash: 'env-del000',
	action: 'delete',
	timestamp: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
	assurance_level: 'low',
};

const allAnnotations: VibesAnnotation[] = [
	mockSessionStart,
	mockLineAnnotation,
	mockFunctionAnnotation,
	mockDeleteAnnotation,
	mockSessionEnd,
];

describe('VibesAnnotationLog', () => {
	it('renders loading state', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[]}
				isLoading={true}
			/>,
		);
		expect(screen.getByText('Loading annotations...')).toBeTruthy();
	});

	it('renders empty state when no annotations', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[]}
				isLoading={false}
			/>,
		);
		expect(screen.getByText('No annotations recorded yet')).toBeTruthy();
	});

	it('renders annotation list with all types', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		// Session annotations
		expect(screen.getByText('Session Started')).toBeTruthy();
		expect(screen.getByText('Session Ended')).toBeTruthy();

		// File paths
		expect(screen.getByText(/src\/utils\/helpers\.ts/)).toBeTruthy();
		expect(screen.getByText(/src\/core\/engine\.ts/)).toBeTruthy();
		expect(screen.getByText(/src\/legacy\/old-module\.ts/)).toBeTruthy();

		// Action badges
		expect(screen.getByText('create')).toBeTruthy();
		expect(screen.getByText('modify')).toBeTruthy();
		expect(screen.getByText('delete')).toBeTruthy();

		// Footer count
		expect(screen.getByText('5 of 5 annotations')).toBeTruthy();
	});

	it('shows line range for line annotations', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation]}
				isLoading={false}
			/>,
		);
		expect(screen.getByText(':10-25')).toBeTruthy();
	});

	it('shows function name for function annotations', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockFunctionAnnotation]}
				isLoading={false}
			/>,
		);
		expect(screen.getByText(':processData')).toBeTruthy();
	});

	it('shows session description when available', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockSessionStart]}
				isLoading={false}
			/>,
		);
		expect(screen.getByText(/Auto Run started/)).toBeTruthy();
	});

	it('filters by action type', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		// Find the action dropdown and change it to 'delete'
		const selects = screen.getAllByRole('combobox');
		const actionSelect = selects[1]; // Second dropdown is action filter
		fireEvent.change(actionSelect, { target: { value: 'delete' } });

		// Only delete annotation should remain (sessions are filtered out by action filter)
		expect(screen.getByText('delete')).toBeTruthy();
		expect(screen.queryByText('create')).toBeNull();
		expect(screen.queryByText('modify')).toBeNull();
	});

	it('filters by file path search', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		const searchInput = screen.getByPlaceholderText('Filter by file path...');
		fireEvent.change(searchInput, { target: { value: 'engine' } });

		// Only the function annotation should match
		expect(screen.getByText(/src\/core\/engine\.ts/)).toBeTruthy();
		expect(screen.queryByText(/src\/utils\/helpers\.ts/)).toBeNull();
	});

	it('clears filters when clear button is clicked', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		// Apply a filter
		const searchInput = screen.getByPlaceholderText('Filter by file path...');
		fireEvent.change(searchInput, { target: { value: 'engine' } });

		// Verify clear button appears and click it
		const clearBtn = screen.getByText(/Clear/);
		fireEvent.click(clearBtn);

		// All annotations should be visible again
		expect(screen.getByText('5 of 5 annotations')).toBeTruthy();
	});

	it('expands annotation detail on click', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation]}
				isLoading={false}
			/>,
		);

		// Click the annotation row to expand
		const row = screen.getByText(/src\/utils\/helpers\.ts/).closest('button');
		expect(row).toBeTruthy();
		fireEvent.click(row!);

		// Detail section should appear with environment hash
		expect(screen.getByText('env-abc123')).toBeTruthy();
		expect(screen.getByText('session-001')).toBeTruthy();
	});

	it('shows command hash in expanded detail', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation]}
				isLoading={false}
			/>,
		);

		const row = screen.getByText(/src\/utils\/helpers\.ts/).closest('button');
		fireEvent.click(row!);

		expect(screen.getByText('cmd-def456')).toBeTruthy();
	});

	it('shows reasoning section for high assurance annotations', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockFunctionAnnotation]}
				isLoading={false}
			/>,
		);

		const row = screen.getByText(/src\/core\/engine\.ts/).closest('button');
		fireEvent.click(row!);

		expect(screen.getByText('rsn-aaa111')).toBeTruthy();
		expect(screen.getByText('Show more...')).toBeTruthy();
	});

	it('shows function signature in expanded detail', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockFunctionAnnotation]}
				isLoading={false}
			/>,
		);

		const row = screen.getByText(/src\/core\/engine\.ts/).closest('button');
		fireEvent.click(row!);

		expect(screen.getByText('(data: unknown) => Promise<Result>')).toBeTruthy();
	});

	it('collapses expanded annotation on second click', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation]}
				isLoading={false}
			/>,
		);

		const row = screen.getByText(/src\/utils\/helpers\.ts/).closest('button');

		// Expand
		fireEvent.click(row!);
		expect(screen.getByText('env-abc123')).toBeTruthy();

		// Collapse
		fireEvent.click(row!);
		expect(screen.queryByText('env-abc123')).toBeNull();
	});

	it('shows "no match" empty state when filters exclude all annotations', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		const searchInput = screen.getByPlaceholderText('Filter by file path...');
		fireEvent.change(searchInput, { target: { value: 'nonexistent-file' } });

		expect(screen.getByText('No annotations match the current filters')).toBeTruthy();
	});

	it('shows filter count in footer when filters active', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		const searchInput = screen.getByPlaceholderText('Filter by file path...');
		fireEvent.change(searchInput, { target: { value: 'helpers' } });

		expect(screen.getByText('1 filter active')).toBeTruthy();
	});

	it('renders session start with play icon and session end with square icon', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockSessionStart, mockSessionEnd]}
				isLoading={false}
			/>,
		);

		expect(screen.getByTestId('icon-play')).toBeTruthy();
		expect(screen.getByTestId('icon-square')).toBeTruthy();
	});

	it('displays truncated session id for session annotations', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockSessionStart]}
				isLoading={false}
			/>,
		);

		// session_id 'session-001' sliced to first 8 chars = 'session-'
		expect(screen.getByText('session-')).toBeTruthy();
	});

	// ========================================================================
	// Parse error handling
	// ========================================================================

	it('shows parse error warning for malformed annotations', () => {
		const malformed = { garbage: 'data' } as unknown as VibesAnnotation;

		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation, malformed]}
				isLoading={false}
			/>,
		);

		expect(screen.getByText(/1 annotation skipped due to malformed data/)).toBeTruthy();
	});

	it('shows correct count for multiple malformed annotations', () => {
		const malformed1 = { garbage: true } as unknown as VibesAnnotation;
		const malformed2 = { type: 'line' } as unknown as VibesAnnotation;

		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation, malformed1, malformed2]}
				isLoading={false}
			/>,
		);

		expect(screen.getByText(/2 annotations skipped due to malformed data/)).toBeTruthy();
	});

	it('does not show parse error warning when all annotations are valid', () => {
		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={allAnnotations}
				isLoading={false}
			/>,
		);

		expect(screen.queryByText(/skipped due to malformed data/)).toBeNull();
	});

	it('shows footer with skipped count when parse errors exist', () => {
		const malformed = { bad: 'data' } as unknown as VibesAnnotation;

		render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[mockLineAnnotation, mockSessionStart, malformed]}
				isLoading={false}
			/>,
		);

		expect(screen.getByText(/2 of 2 annotations/)).toBeTruthy();
		expect(screen.getByText(/1 skipped/)).toBeTruthy();
	});

	// ========================================================================
	// Skeleton loading state
	// ========================================================================

	it('renders skeleton rows in loading state', () => {
		const { container } = render(
			<VibesAnnotationLog
				theme={mockTheme}
				annotations={[]}
				isLoading={true}
			/>,
		);

		// Should have multiple skeleton placeholder rows with animate-pulse
		const pulseElements = container.querySelectorAll('.animate-pulse');
		expect(pulseElements.length).toBeGreaterThanOrEqual(1);
	});
});
