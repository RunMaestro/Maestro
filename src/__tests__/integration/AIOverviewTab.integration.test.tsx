import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
	AIOverviewTab,
	_resetCacheForTesting,
} from '../../renderer/components/DirectorNotes/AIOverviewTab';
import type { Theme } from '../../renderer/types';

// Mock useSettings hook
vi.mock('../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		directorNotesSettings: {
			provider: 'claude-code',
			defaultLookbackDays: 7,
		},
		bionifyReadingMode: false,
	}),
}));

// Mock MarkdownRenderer
vi.mock('../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({
		content,
		onCopy,
		enableBionifyReadingMode,
	}: {
		content: string;
		onCopy: (text: string) => void;
		enableBionifyReadingMode?: boolean;
	}) => (
		<div data-testid="markdown-renderer" data-bionify={enableBionifyReadingMode ? 'on' : 'off'}>
			{content}
			<button
				type="button"
				aria-label="Copy markdown block"
				data-testid="markdown-copy"
				onClick={() => onCopy('copied markdown')}
			>
				Copy markdown block
			</button>
		</div>
	),
}));

// Mock SaveMarkdownModal
vi.mock('../../renderer/components/SaveMarkdownModal', () => ({
	SaveMarkdownModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="save-markdown-modal">
			<button onClick={onClose} data-testid="save-modal-close">
				Close
			</button>
		</div>
	),
}));

// Mock markdownConfig
vi.mock('../../renderer/utils/markdownConfig', () => ({
	generateTerminalProseStyles: () => '.director-notes-content { color: inherit; }',
}));

// Mock navigator.clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
	value: { writeText: mockWriteText },
	writable: true,
});

// Mock theme
const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		scrollbar: '#44475a',
		scrollbarHover: '#6272a4',
	},
};

// Mock IPC APIs
const mockGenerateSynopsis = vi.fn();

beforeEach(() => {
	// Reset module-level synopsis cache so each test starts fresh
	_resetCacheForTesting();

	(window as any).maestro = {
		directorNotes: {
			generateSynopsis: mockGenerateSynopsis,
		},
	};

	mockGenerateSynopsis.mockResolvedValue({
		success: true,
		synopsis: '# Test Synopsis\n\n## Accomplishments\n\n- Test item',
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('AIOverviewTab', () => {
	it('renders loading state initially', async () => {
		// Make generation hang to observe loading
		mockGenerateSynopsis.mockReturnValue(new Promise(() => {}));

		render(<AIOverviewTab theme={mockTheme} />);

		// Should show generating state in both the toolbar action and empty-content spinner.
		await waitFor(() => {
			expect(screen.getByText(/Regenerating/)).toBeInTheDocument();
			expect(screen.getByText(/^Generating/)).toBeInTheDocument();
		});
	});

	it('shows empty message when no history files found', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: "# Director's Notes\n\nNo history files found.",
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/No history files found/)).toBeInTheDocument();
		});
	});

	it('generates and displays synopsis', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis\n\n## Accomplishments\n\n- Test work completed',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		expect(mockGenerateSynopsis).toHaveBeenCalledWith(
			expect.objectContaining({
				lookbackDays: 7,
				provider: 'claude-code',
			})
		);
		expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-bionify', 'off');
	});

	it('calls onSynopsisReady when synopsis is generated', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		const onSynopsisReady = vi.fn();
		render(<AIOverviewTab theme={mockTheme} onSynopsisReady={onSynopsisReady} />);

		await waitFor(() => {
			expect(onSynopsisReady).toHaveBeenCalled();
		});
	});

	it('displays error when generation fails', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: false,
			synopsis: '',
			error: 'Provider unavailable',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Provider unavailable')).toBeInTheDocument();
		});
	});

	it('displays default error when generation fails without a message', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: false,
			synopsis: '',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Failed to generate synopsis')).toBeInTheDocument();
		});
	});

	it('shows regeneration errors above existing synopsis content', async () => {
		mockGenerateSynopsis
			.mockResolvedValueOnce({
				success: true,
				synopsis: '# Existing Synopsis',
			})
			.mockResolvedValueOnce({
				success: false,
				synopsis: '',
				error: 'Regeneration failed',
			});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/# Existing Synopsis/)).toBeInTheDocument();
		});

		await act(async () => {
			fireEvent.click(screen.getByText('Regenerate'));
		});

		const errorBanner = await screen.findByText('Regeneration failed');
		expect(errorBanner).toHaveClass('mb-4');
		expect(screen.getByText(/# Existing Synopsis/)).toBeInTheDocument();
	});

	it('displays error on exception', async () => {
		mockGenerateSynopsis.mockRejectedValue(new Error('Network error'));

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Network error')).toBeInTheDocument();
		});
	});

	it('displays default error for non-Error rejections', async () => {
		mockGenerateSynopsis.mockRejectedValue('rejected without Error');

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Failed to generate synopsis')).toBeInTheDocument();
		});
	});

	it('renders lookback slider with default value', async () => {
		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/Lookback: 7 days/)).toBeInTheDocument();
		});

		const slider = screen.getByRole('slider');
		expect(slider).toHaveValue('7');
	});

	it('uses updated lookback days when regenerating', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
		expect(screen.getByText('Lookback: 30 days')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Regenerate'));

		await waitFor(() => {
			expect(mockGenerateSynopsis).toHaveBeenCalledTimes(2);
		});
		expect(mockGenerateSynopsis).toHaveBeenLastCalledWith(
			expect.objectContaining({ lookbackDays: 30 })
		);
	});

	it('renders Regenerate button', async () => {
		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Regenerate')).toBeInTheDocument();
		});
	});

	it('renders Save button', async () => {
		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Save')).toBeInTheDocument();
		});
	});

	it('refreshes synopsis when Regenerate button is clicked', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		// Wait for initial generation
		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		expect(mockGenerateSynopsis).toHaveBeenCalledTimes(1);

		// Click refresh
		await act(async () => {
			fireEvent.click(screen.getByText('Regenerate'));
		});

		await waitFor(() => {
			expect(mockGenerateSynopsis).toHaveBeenCalledTimes(2);
		});
	});

	it('opens save modal when Save button is clicked with synopsis', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		// Wait for synopsis to be ready
		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		// Click save
		fireEvent.click(screen.getByText('Save'));

		expect(screen.getByTestId('save-markdown-modal')).toBeInTheDocument();
	});

	it('copies synopsis markdown and resets the copied state', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		vi.useFakeTimers();
		fireEvent.click(screen.getByText('Copy'));
		await act(async () => {
			await Promise.resolve();
		});

		expect(mockWriteText).toHaveBeenCalledWith('# Synopsis');
		expect(screen.getByText('Copied!')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.getByText('Copy')).toBeInTheDocument();
	});

	it('keeps copy disabled while synopsis is unavailable', async () => {
		mockGenerateSynopsis.mockReturnValue(new Promise(() => {}));

		render(<AIOverviewTab theme={mockTheme} />);

		const copyButton = screen.getByRole('button', { name: 'Copy' });
		expect(copyButton).toBeDisabled();

		fireEvent.click(copyButton);
		expect(mockWriteText).not.toHaveBeenCalled();
	});

	it('leaves copy state unchanged when clipboard write fails', async () => {
		mockWriteText.mockRejectedValueOnce(new Error('clipboard denied'));
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Copy'));

		await waitFor(() => {
			expect(mockWriteText).toHaveBeenCalledWith('# Synopsis');
		});
		expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
	});

	it('passes markdown renderer copy requests through the safe clipboard helper', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId('markdown-copy'));

		await waitFor(() => {
			expect(mockWriteText).toHaveBeenCalledWith('copied markdown');
		});
	});

	it('displays stats bar when synopsis includes stats', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
			stats: { agentCount: 3, entryCount: 42, durationMs: 95000 },
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		// Verify stats are displayed
		expect(screen.getByText('42')).toBeInTheDocument();
		expect(screen.getByText('history entries')).toBeInTheDocument();
		expect(screen.getByText('3')).toBeInTheDocument();
		expect(screen.getByText(/agents/)).toBeInTheDocument();
		expect(screen.getByText('1m 35s')).toBeInTheDocument();
	});

	it('uses singular labels when counts are 1', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
			stats: { agentCount: 1, entryCount: 1, durationMs: 5000 },
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		expect(screen.getByText(/history entry\b/)).toBeInTheDocument();
		expect(screen.getByText(/\bagent\b/)).toBeInTheDocument();
	});

	it('does not update state after unmount but caches result', async () => {
		let resolveGeneration!: (value: any) => void;
		mockGenerateSynopsis.mockReturnValue(
			new Promise((resolve) => {
				resolveGeneration = resolve;
			})
		);

		const onSynopsisReady = vi.fn();
		const { unmount } = render(
			<AIOverviewTab theme={mockTheme} onSynopsisReady={onSynopsisReady} />
		);

		// Wait for generation to start
		await waitFor(() => {
			expect(mockGenerateSynopsis).toHaveBeenCalledTimes(1);
		});

		// Unmount (simulates closing the modal)
		unmount();

		// Resolve the generation after unmount - should not throw or update state
		await act(async () => {
			resolveGeneration({
				success: true,
				synopsis: '# Cached Result',
				generatedAt: 1234567890,
			});
		});

		// onSynopsisReady should NOT have been called (component unmounted)
		expect(onSynopsisReady).not.toHaveBeenCalled();

		// But the module-level cache should still be populated for next open
		const { hasCachedSynopsis } =
			await import('../../renderer/components/DirectorNotes/AIOverviewTab');
		expect(hasCachedSynopsis()).toBe(true);
	});

	it('uses cached synopsis on remount without regenerating', async () => {
		const generatedAt = new Date('2025-01-15T12:00:00Z').getTime();
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Cached Synopsis',
			generatedAt,
			stats: { agentCount: 1, entryCount: 1, durationMs: 0 },
		});

		const { unmount } = render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/# Cached Synopsis/)).toBeInTheDocument();
		});
		unmount();

		mockGenerateSynopsis.mockClear();
		const onSynopsisReady = vi.fn();
		render(<AIOverviewTab theme={mockTheme} onSynopsisReady={onSynopsisReady} />);

		expect(screen.getByText(/# Cached Synopsis/)).toBeInTheDocument();
		expect(screen.getByText(/history entry\b/)).toBeInTheDocument();
		expect(mockGenerateSynopsis).not.toHaveBeenCalled();
		expect(onSynopsisReady).toHaveBeenCalled();
	});

	it('uses cached synopsis without rendering stats when cached stats are absent', async () => {
		const generatedAt = new Date('2025-01-15T12:00:00Z').getTime();
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Cached Without Stats',
			generatedAt,
		});

		const { unmount } = render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/# Cached Without Stats/)).toBeInTheDocument();
		});
		unmount();

		mockGenerateSynopsis.mockClear();
		render(<AIOverviewTab theme={mockTheme} />);

		expect(screen.getByText(/# Cached Without Stats/)).toBeInTheDocument();
		expect(screen.queryByText(/history entr/)).not.toBeInTheDocument();
		expect(mockGenerateSynopsis).not.toHaveBeenCalled();
	});

	it('ignores generation errors that settle after unmount', async () => {
		let rejectGeneration!: (error: Error) => void;
		mockGenerateSynopsis.mockReturnValue(
			new Promise((_, reject) => {
				rejectGeneration = reject;
			})
		);

		const { unmount } = render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(mockGenerateSynopsis).toHaveBeenCalledTimes(1);
		});

		unmount();

		await act(async () => {
			rejectGeneration(new Error('late failure'));
			await Promise.resolve();
		});
	});

	it('closes save modal when close button is clicked', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		// Open save modal
		fireEvent.click(screen.getByText('Save'));
		expect(screen.getByTestId('save-markdown-modal')).toBeInTheDocument();

		// Close save modal
		fireEvent.click(screen.getByTestId('save-modal-close'));
		expect(screen.queryByTestId('save-markdown-modal')).not.toBeInTheDocument();
	});
});
