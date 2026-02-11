import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { VibesLiveMonitor } from '../../../../renderer/components/vibes/VibesLiveMonitor';
import type { Theme } from '../../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Radio: () => <span data-testid="icon-radio">Radio</span>,
	FileEdit: () => <span data-testid="icon-file-edit">FileEdit</span>,
	FilePlus: () => <span data-testid="icon-file-plus">FilePlus</span>,
	FileX: () => <span data-testid="icon-file-x">FileX</span>,
	Eye: () => <span data-testid="icon-eye">Eye</span>,
	Clock: () => <span data-testid="icon-clock">Clock</span>,
	AlertCircle: () => <span data-testid="icon-alert">AlertCircle</span>,
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

const mockAnnotations = [
	{
		id: 'ann-1',
		timestamp: new Date(Date.now() - 5000).toISOString(),
		file_path: 'src/components/App.tsx',
		action: 'create',
		tool_name: 'claude-code',
		model_name: 'claude-sonnet-4-5-20250929',
		session_id: 'sess-001',
	},
	{
		id: 'ann-2',
		timestamp: new Date(Date.now() - 2000).toISOString(),
		file_path: 'src/utils/helpers.ts',
		action: 'modify',
		tool_name: 'codex',
		model_name: 'gpt-4o',
		session_id: 'sess-002',
	},
	{
		id: 'ann-3',
		timestamp: new Date(Date.now() - 1000).toISOString(),
		file_path: 'src/main.ts',
		action: 'review',
		tool_name: 'claude-code',
		model_name: 'claude-sonnet-4-5-20250929',
		session_id: 'sess-001',
	},
];

const mockStatsData = {
	total_annotations: 42,
	files_covered: 8,
	total_tracked_files: 15,
	coverage_percent: 53.3,
	active_sessions: 2,
	contributing_models: 3,
};

// Setup mocks
const mockGetLog = vi.fn();
const mockGetStats = vi.fn();

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.clearAllMocks();

	mockGetLog.mockResolvedValue({
		success: true,
		data: JSON.stringify(mockAnnotations),
	});

	mockGetStats.mockResolvedValue({
		success: true,
		data: JSON.stringify(mockStatsData),
	});

	(window as any).maestro = {
		vibes: {
			getLog: mockGetLog,
			getStats: mockGetStats,
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
});

describe('VibesLiveMonitor', () => {
	it('renders the Live Monitor header', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		expect(screen.getByText('Live Monitor')).toBeTruthy();
	});

	it('shows waiting state before data loads', () => {
		// Make getLog hang
		mockGetLog.mockReturnValue(new Promise(() => {}));

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		expect(screen.getByText('Waiting for annotations...')).toBeTruthy();
	});

	it('displays annotation count after data loads', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('42 annotations')).toBeTruthy();
		});
	});

	it('renders annotation feed entries', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('.../components/App.tsx')).toBeTruthy();
		});

		expect(screen.getByText('.../utils/helpers.ts')).toBeTruthy();
		expect(screen.getByText('src/main.ts')).toBeTruthy();
	});

	it('shows action badges for each entry', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('create')).toBeTruthy();
		});

		expect(screen.getByText('modify')).toBeTruthy();
		expect(screen.getByText('review')).toBeTruthy();
	});

	it('shows agent types for each entry', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
		});

		expect(screen.getByText('Codex')).toBeTruthy();
	});

	it('polls for new data at regular intervals', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		// Initial fetch
		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalledTimes(1);
		});

		// Advance timer to trigger second poll
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});

		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalledTimes(2);
		});

		// Advance timer to trigger third poll
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});

		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalledTimes(3);
		});
	});

	it('calls getLog with correct parameters', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalledWith('/test/project', {
				limit: 5,
				json: true,
			});
		});
	});

	it('shows error state when fetch fails', async () => {
		mockGetLog.mockResolvedValue({
			success: false,
			error: 'Connection failed',
		});

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Connection failed')).toBeTruthy();
		});
	});

	it('does not show error for build-required scenarios', async () => {
		mockGetLog.mockResolvedValue({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		// Wait a tick to let the fetch resolve
		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalled();
		});

		// Should NOT show error — build-required is silenced
		expect(screen.queryByText(/audit\.db/)).toBeNull();
		expect(screen.getByText('Waiting for annotations...')).toBeTruthy();
	});

	it('does not fetch when projectPath is undefined', () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath={undefined}
			/>,
		);

		expect(mockGetLog).not.toHaveBeenCalled();
	});

	it('stops polling on unmount', async () => {
		const { unmount } = render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalledTimes(1);
		});

		unmount();

		// Advance timer — should not trigger more calls
		await act(async () => {
			vi.advanceTimersByTime(6000);
		});

		expect(mockGetLog).toHaveBeenCalledTimes(1);
	});

	it('shows singular "annotation" for count of 1', async () => {
		mockGetStats.mockResolvedValue({
			success: true,
			data: JSON.stringify({ total_annotations: 1 }),
		});

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('1 annotation')).toBeTruthy();
		});
	});

	it('shows pulse indicator when polling is active', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(mockGetLog).toHaveBeenCalled();
		});

		// Look for the pulse dot element (animated green dot)
		const container = screen.getByText('Live Monitor').parentElement;
		const pulseDot = container?.querySelector('.animate-pulse');
		expect(pulseDot).toBeTruthy();
	});

	it('handles annotations wrapped in {annotations: [...]} format', async () => {
		mockGetLog.mockResolvedValue({
			success: true,
			data: JSON.stringify({ annotations: mockAnnotations }),
		});

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('.../components/App.tsx')).toBeTruthy();
		});
	});

	it('shows "Updated" footer after first successful fetch', async () => {
		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/Updated/)).toBeTruthy();
		});
	});

	it('shortens file paths with more than 2 segments', async () => {
		mockGetLog.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{
					id: 'ann-deep',
					timestamp: new Date().toISOString(),
					file_path: 'src/renderer/components/deep/File.tsx',
					action: 'create',
					tool_name: 'claude-code',
				},
			]),
		});

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('.../deep/File.tsx')).toBeTruthy();
		});
	});

	it('shows dash for entries with no file path', async () => {
		mockGetLog.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{
					id: 'ann-nofile',
					timestamp: new Date().toISOString(),
					action: 'review',
					tool_name: 'claude-code',
				},
			]),
		});

		render(
			<VibesLiveMonitor
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			const dash = screen.getByText('—');
			expect(dash).toBeTruthy();
		});
	});
});
