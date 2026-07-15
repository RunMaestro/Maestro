import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
	AIOverviewTab,
	_resetCacheForTesting,
} from '../../../../renderer/components/DirectorNotes/AIOverviewTab';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock useSettings hook. Mutable (via vi.hoisted) so tests can flip the
// persisted Director's Notes defaultMode and assert the initial view mode.
const settingsMock = vi.hoisted(() => ({
	value: {
		directorNotesSettings: {
			provider: 'claude-code',
			defaultLookbackDays: 7,
			defaultMode: undefined as 'rich' | 'plain' | undefined,
		},
		bionifyReadingMode: false,
	},
}));
vi.mock('../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => settingsMock.value,
}));

// Mock MarkdownRenderer
vi.mock('../../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({
		content,
		enableBionifyReadingMode,
	}: {
		content: string;
		enableBionifyReadingMode?: boolean;
	}) => (
		<div data-testid="markdown-renderer" data-bionify={enableBionifyReadingMode ? 'on' : 'off'}>
			{content}
		</div>
	),
}));

// Mock RichOverview - the Rich-mode dashboard is exercised in its own test
// file. Here we only need a lightweight stub that proves Rich mode rendered and
// still surfaces the narrative (via the shared markdown-renderer testid) so the
// existing synopsis assertions hold under the new Rich default.
vi.mock('../../../../renderer/components/DirectorNotes/RichOverview', () => ({
	RichOverview: ({
		synopsis,
		enableBionifyReadingMode,
	}: {
		synopsis: string;
		enableBionifyReadingMode?: boolean;
	}) => (
		<div data-testid="rich-overview">
			<div data-testid="markdown-renderer" data-bionify={enableBionifyReadingMode ? 'on' : 'off'}>
				{synopsis}
			</div>
		</div>
	),
}));

// Mock SaveMarkdownModal - surface the `content` prop so tests can assert Save
// always operates on the raw synopsis markdown (in both Rich and Plain modes).
vi.mock('../../../../renderer/components/SaveMarkdownModal', () => ({
	SaveMarkdownModal: ({ content, onClose }: { content: string; onClose: () => void }) => (
		<div data-testid="save-markdown-modal" data-content={content}>
			<button onClick={onClose} data-testid="save-modal-close">
				Close
			</button>
		</div>
	),
}));

// Mock markdownConfig
vi.mock('../../../../renderer/utils/markdownConfig', () => ({
	generateTerminalProseStyles: () => '.director-notes-content { color: inherit; }',
}));

// Mock notifyToast so we can assert the unmount-completion toast shape
const mockNotifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

// Mock modalStore so the toast onClick handler doesn't explode in tests
const mockOpenModal = vi.fn();
vi.mock('../../../../renderer/stores/modalStore', () => ({
	useModalStore: { getState: () => ({ openModal: mockOpenModal }) },
}));

// Mock navigator.clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
	value: { writeText: mockWriteText },
	writable: true,
});

// Mock theme

// Mock IPC APIs
const mockGenerateSynopsis = vi.fn();

beforeEach(() => {
	// Reset module-level synopsis cache so each test starts fresh
	_resetCacheForTesting();

	// Reset the persisted default mode so each test starts from "unset".
	settingsMock.value.directorNotesSettings.defaultMode = undefined;

	// jsdom in this environment doesn't provide a working Storage on
	// window.localStorage, so install a minimal in-memory mock that satisfies
	// the Storage methods the component uses (font-scale persistence). Same
	// pattern as GitDiffViewer.test.tsx / ProcessMonitor.test.tsx.
	const store = new Map<string, string>();
	Object.defineProperty(window, 'localStorage', {
		configurable: true,
		writable: true,
		value: {
			getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
			setItem: vi.fn((key: string, value: string) => {
				store.set(key, String(value));
			}),
			removeItem: vi.fn((key: string) => {
				store.delete(key);
			}),
			clear: vi.fn(() => {
				store.clear();
			}),
			key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
			get length() {
				return store.size;
			},
		},
	});

	(window as any).maestro = {
		directorNotes: {
			generateSynopsis: mockGenerateSynopsis,
			onSynopsisProgress: () => () => {},
		},
	};

	mockGenerateSynopsis.mockResolvedValue({
		success: true,
		synopsis: '# Test Synopsis\n\n## Accomplishments\n\n- Test item',
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('AIOverviewTab', () => {
	it('renders loading state initially', async () => {
		// Make generation hang to observe loading
		mockGenerateSynopsis.mockReturnValue(new Promise(() => {}));

		render(<AIOverviewTab theme={mockTheme} />);

		// Should show generating state - spinner shows "Generating…"
		await waitFor(() => {
			const elements = screen.getAllByText(/Generating/);
			expect(elements.length).toBeGreaterThan(0);
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

	it('displays error on exception', async () => {
		mockGenerateSynopsis.mockRejectedValue(new Error('Network error'));

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Network error')).toBeInTheDocument();
		});
	});

	it('renders lookback slider with default value', async () => {
		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/Lookback: 7 days/)).toBeInTheDocument();
		});

		const slider = screen.getByRole('slider');
		expect(slider).toHaveValue('7');
		// Cross-theme guard: the lookback range used to be hardcoded
		// `accent-indigo-500`; it must derive its accent from the active theme.
		expect(slider).toHaveStyle({ accentColor: mockTheme.colors.accent });
		expect(slider).not.toHaveClass('accent-indigo-500');
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

	describe('synopsis font scaling', () => {
		const FONT_SCALE_STORAGE_KEY = 'directorNotes.fontScale';

		beforeEach(() => {
			mockGenerateSynopsis.mockResolvedValue({
				success: true,
				synopsis: '# Synopsis',
				stats: { agentCount: 3, entryCount: 42, durationMs: 95000 },
			});
		});

		it('renders increase/decrease font-size controls with the stats bar', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});

			expect(screen.getByLabelText('Increase font size')).toBeInTheDocument();
			expect(screen.getByLabelText('Decrease font size')).toBeInTheDocument();
		});

		it('persists a larger scale to localStorage when increasing', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByLabelText('Increase font size'));

			// Default is 1.0, step is 0.1.
			expect(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe('1.1');
		});

		it('persists a smaller scale to localStorage when decreasing', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByLabelText('Decrease font size'));

			expect(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe('0.9');
		});

		// Regression guard: the controls used to update state + localStorage but
		// the rendered text never changed, because MarkdownRenderer's `.prose`
		// root carries Tailwind `text-sm` (an absolute rem unit) that pinned the
		// base size. The fix scales `.prose` directly via an injected style rule.
		const proseFontRule = (): string | undefined =>
			Array.from(document.querySelectorAll('style'))
				.map((el) => el.textContent || '')
				.find((css) => css.includes('.director-notes-content .prose'));

		it('injects a scaled .prose font-size rule that tracks the current scale', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});

			// Default scale 1.0.
			expect(proseFontRule()).toContain('font-size: calc(0.875rem * 1) !important');

			fireEvent.click(screen.getByLabelText('Increase font size'));

			expect(proseFontRule()).toContain('font-size: calc(0.875rem * 1.1) !important');
		});

		it('loads the persisted scale and disables increase at the max bound', async () => {
			// Preload a scale at the clamp ceiling (FONT_SCALE_MAX = 2.0).
			window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, '2');

			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});

			expect(screen.getByLabelText('Increase font size')).toBeDisabled();
			expect(screen.getByLabelText('Decrease font size')).not.toBeDisabled();
		});
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
			await import('../../../../renderer/components/DirectorNotes/AIOverviewTab');
		expect(hasCachedSynopsis()).toBe(true);
	});

	it('fires a completion toast that opts in to the custom notification command when generation finishes after unmount', async () => {
		let resolveGeneration!: (value: any) => void;
		mockGenerateSynopsis.mockReturnValue(
			new Promise((resolve) => {
				resolveGeneration = resolve;
			})
		);

		const { unmount } = render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(mockGenerateSynopsis).toHaveBeenCalledTimes(1);
		});

		unmount();

		await act(async () => {
			resolveGeneration({
				success: true,
				synopsis: '# Cached Result',
				generatedAt: 1234567890,
			});
		});

		expect(mockNotifyToast).toHaveBeenCalledTimes(1);
		const toastArg = mockNotifyToast.mock.calls[0][0];
		expect(toastArg).toMatchObject({
			type: 'success',
			title: "Director's Notes",
			message: expect.stringMatching(/synopsis is ready/i),
		});
		// Regression guard: synopsis completion must flow through the custom audio/TTS
		// notification command when the user has one configured.
		expect(toastArg.skipCustomNotification).toBeUndefined();
		// Clicking the toast should open Director's Notes directly to the AI Overview tab.
		expect(typeof toastArg.onClick).toBe('function');
		toastArg.onClick();
		expect(mockOpenModal).toHaveBeenCalledWith('directorNotes', { initialTab: 'ai-overview' });
	});

	it('does not fire a completion toast when generation finishes while still mounted', async () => {
		mockGenerateSynopsis.mockResolvedValue({
			success: true,
			synopsis: '# Synopsis',
			generatedAt: 1234567890,
		});

		render(<AIOverviewTab theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});

		expect(mockNotifyToast).not.toHaveBeenCalled();
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

	describe('Rich/Plain view mode toggle', () => {
		const VIEW_MODE_STORAGE_KEY = 'directorNotes.viewMode';

		beforeEach(() => {
			mockGenerateSynopsis.mockResolvedValue({
				success: true,
				synopsis: '# Synopsis\n\nbody text',
				stats: { agentCount: 3, entryCount: 42, durationMs: 5000 },
			});
		});

		it('renders the Rich and Plain segmented control', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /^rich$/i })).toBeInTheDocument();
			});
			expect(screen.getByRole('button', { name: /^plain$/i })).toBeInTheDocument();
		});

		it('defaults to Rich mode and renders the RichOverview dashboard', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});
			expect(screen.getByRole('button', { name: /^rich$/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});

		it('switches to Plain (raw markdown) and persists the choice', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /^plain$/i }));

			// Rich dashboard gone; the Plain markdown block remains reachable.
			expect(screen.queryByTestId('rich-overview')).not.toBeInTheDocument();
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('plain');
		});

		it('switches back to Rich and restores the dashboard', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /^plain$/i }));
			expect(screen.queryByTestId('rich-overview')).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /^rich$/i }));
			expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('rich');
		});

		it('loads the persisted Plain mode from localStorage on mount', async () => {
			window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'plain');

			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});
			expect(screen.queryByTestId('rich-overview')).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: /^plain$/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});

		it('opens in the persisted defaultMode when no localStorage override exists', async () => {
			// Persisted setting says Plain; no per-session override in localStorage.
			settingsMock.value.directorNotesSettings.defaultMode = 'plain';

			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
			});
			expect(screen.queryByTestId('rich-overview')).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: /^plain$/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});

		it('lets a localStorage override win over the persisted defaultMode', async () => {
			// Persisted default is Plain, but the session override (the in-tab
			// toggle) chose Rich - the override wins.
			settingsMock.value.directorNotesSettings.defaultMode = 'plain';
			window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'rich');

			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});
			expect(screen.getByRole('button', { name: /^rich$/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});

		it('Copy operates on the raw synopsis markdown in Rich mode', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Copy'));

			await waitFor(() => {
				expect(mockWriteText).toHaveBeenCalledWith('# Synopsis\n\nbody text');
			});
		});

		it('Copy operates on the raw synopsis markdown in Plain mode too', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			// Switch to Plain, then copy - same raw markdown, unaffected by mode.
			fireEvent.click(screen.getByRole('button', { name: /^plain$/i }));
			fireEvent.click(screen.getByText('Copy'));

			await waitFor(() => {
				expect(mockWriteText).toHaveBeenCalledWith('# Synopsis\n\nbody text');
			});
		});

		it('Save hands the raw synopsis markdown to the modal in Rich mode', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Save'));

			expect(screen.getByTestId('save-markdown-modal')).toHaveAttribute(
				'data-content',
				'# Synopsis\n\nbody text'
			);
		});

		it('Save hands the raw synopsis markdown to the modal in Plain mode too', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /^plain$/i }));
			fireEvent.click(screen.getByText('Save'));

			expect(screen.getByTestId('save-markdown-modal')).toHaveAttribute(
				'data-content',
				'# Synopsis\n\nbody text'
			);
		});
	});

	// The agent emits the structured JSON narrative now. Plain Mode (and the
	// Copy/Save outputs) must convert it back to readable markdown prose instead
	// of dumping the raw JSON object - the regression that made Plain Mode look
	// like an error.
	describe('Plain Mode renders the structured narrative as prose', () => {
		const narrative = {
			version: 1 as const,
			sections: [
				{
					kind: 'accomplishments' as const,
					title: 'Accomplishments',
					items: [{ text: 'Shipped Plain Mode', severity: 'info' as const, agent: 'Maestro' }],
				},
				{
					kind: 'challenges' as const,
					title: 'Challenges',
					items: [{ text: 'Build broke', severity: 'critical' as const, agent: 'rc' }],
				},
			],
		};
		// What the agent actually returns as the raw synopsis string.
		const rawJson = JSON.stringify(narrative);

		beforeEach(() => {
			mockGenerateSynopsis.mockResolvedValue({
				success: true,
				synopsis: rawJson,
				narrative,
				stats: { agentCount: 2, entryCount: 9, durationMs: 5000 },
			});
		});

		it('renders converted markdown prose, not the raw JSON object', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /^plain$/i }));

			const md = screen.getByTestId('markdown-renderer');
			expect(md.textContent).toContain('## Accomplishments');
			expect(md.textContent).toContain('- Shipped Plain Mode _(Maestro)_');
			expect(md.textContent).toContain('- **Build broke** _(rc)_');
			// Regression guard: Plain Mode must NOT dump the raw JSON object.
			expect(md.textContent).not.toContain('"version"');
			expect(md.textContent).not.toContain('"sections"');
		});

		it('Copy exports the readable prose, not the raw JSON', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Copy'));

			await waitFor(() => {
				expect(mockWriteText).toHaveBeenCalled();
			});
			const copied = mockWriteText.mock.calls[0][0] as string;
			expect(copied).toContain('## Accomplishments');
			expect(copied).not.toContain('"version"');
		});

		it('Save hands the readable prose to the modal, not the raw JSON', async () => {
			render(<AIOverviewTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('rich-overview')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Save'));

			const content = screen.getByTestId('save-markdown-modal').getAttribute('data-content') || '';
			expect(content).toContain('## Accomplishments');
			expect(content).not.toContain('"version"');
		});
	});
});
