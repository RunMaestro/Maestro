/**
 * @fileoverview Tests for AboutModal component
 * Tests: formatTokens helper, formatDuration helper, layer stack integration,
 * streaming stats loading, external links, child component rendering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AboutModal } from '../../renderer/components/AboutModal';
import { logger } from '../../renderer/utils/logger';
import type { Theme, AutoRunStats } from '../../renderer/types';
import type { GlobalAgentStats } from '../../shared/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="x-icon" className={className} style={style}>
			×
		</span>
	),
	Wand2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="wand-icon" className={className} style={style}>
			🪄
		</span>
	),
	ExternalLink: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="external-link-icon" className={className} style={style}>
			↗
		</span>
	),
	FileCode: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="file-code-icon" className={className} style={style}>
			📄
		</span>
	),
	BarChart3: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="bar-chart-icon" className={className} style={style}>
			📊
		</span>
	),
	Loader2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="loader-icon" className={className} style={style}>
			⏳
		</span>
	),
	Trophy: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="trophy-icon" className={className} style={style}>
			🏆
		</span>
	),
	Globe: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="globe-icon" className={className} style={style}>
			🌐
		</span>
	),
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="check-icon" className={className} style={style}>
			✓
		</span>
	),
	BookOpen: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="book-open-icon" className={className} style={style}>
			📖
		</span>
	),
}));

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-about-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock AchievementCard
vi.mock('../../renderer/components/AchievementCard', () => ({
	AchievementCard: ({
		theme,
		autoRunStats,
		globalStats,
		onEscapeWithBadgeOpen,
	}: {
		theme: Theme;
		autoRunStats: AutoRunStats;
		globalStats: GlobalAgentStats | null;
		onEscapeWithBadgeOpen: (handler: (() => boolean) | null) => void;
	}) => (
		<div data-testid="achievement-card">
			AchievementCard
			<button data-testid="badge-open-trigger" onClick={() => onEscapeWithBadgeOpen(() => true)}>
				Open Badge
			</button>
			<button data-testid="badge-close-trigger" onClick={() => onEscapeWithBadgeOpen(null)}>
				Close Badge
			</button>
		</div>
	),
}));

// Add __APP_VERSION__ and __COMMIT_HASH__ globals
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.0.0';
(globalThis as unknown as { __COMMIT_HASH__: string }).__COMMIT_HASH__ = '';

// Create test theme
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

// Create test autoRunStats
const createAutoRunStats = (overrides: Partial<AutoRunStats> = {}): AutoRunStats => ({
	cumulativeTimeMs: 0,
	longestRunMs: 0,
	totalRuns: 0,
	lastBadgeAcknowledged: null,
	badgeHistory: [],
	...overrides,
});

// Create test global stats
const createGlobalStats = (overrides: Partial<ClaudeGlobalStats> = {}): ClaudeGlobalStats => ({
	totalSessions: 100,
	totalMessages: 500,
	totalInputTokens: 1000000,
	totalOutputTokens: 500000,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: 25.5,
	hasCostData: true,
	totalSizeBytes: 1048576,
	isComplete: true,
	...overrides,
});

describe('AboutModal', () => {
	let theme: Theme;
	let onClose: ReturnType<typeof vi.fn>;
	let unsubscribeMock: ReturnType<typeof vi.fn>;
	let statsCallback: ((stats: ClaudeGlobalStats) => void) | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		theme = createTheme();
		onClose = vi.fn();
		unsubscribeMock = vi.fn();
		statsCallback = null;

		// Mock onGlobalStatsUpdate to capture the callback (now uses agentSessions API)
		vi.mocked(window.maestro.agentSessions.onGlobalStatsUpdate).mockImplementation((callback) => {
			statsCallback = callback;
			return unsubscribeMock;
		});

		// Keep the default promise pending so static render tests do not leak async state updates.
		vi.mocked(window.maestro.agentSessions.getGlobalStats).mockImplementation(
			() => new Promise(() => {})
		);

		// Mock shell.openExternal
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

		// Reset layer stack mocks
		mockRegisterLayer.mockClear().mockReturnValue('layer-about-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		statsCallback = null;
	});

	describe('Initial render', () => {
		it('should render with dialog role and aria attributes', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'About Maestro');
		});

		it('should render the modal header with title', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('About Maestro')).toBeInTheDocument();
		});

		it('should render MAESTRO branding', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('MAESTRO')).toBeInTheDocument();
		});

		it('should render version number', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('v1.0.0')).toBeInTheDocument();
		});

		it('should render commit hash when provided', () => {
			(globalThis as unknown as { __COMMIT_HASH__: string }).__COMMIT_HASH__ = 'abc123';

			try {
				render(
					<AboutModal
						theme={theme}
						handsOnTimeMs={0}
						autoRunStats={createAutoRunStats()}
						onClose={onClose}
					/>
				);

				expect(screen.getByText('v1.0.0 (abc123)')).toBeInTheDocument();
			} finally {
				(globalThis as unknown as { __COMMIT_HASH__: string }).__COMMIT_HASH__ = '';
			}
		});

		it('should render subtitle', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Agent Orchestration Command Center')).toBeInTheDocument();
		});

		it('should render loading state initially', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Loading stats...')).toBeInTheDocument();
		});
	});

	describe('Project links and origin section', () => {
		it('should render the project GitHub action', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('GitHub')).toBeInTheDocument();
		});

		it('should render the Austin origin text', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Born in Austin, TX')).toBeInTheDocument();
		});

		it('should render the origin flag marker', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			const originText = screen.getByText('Born in Austin, TX');
			expect(originText.parentElement?.querySelector('svg')).toBeInTheDocument();
		});
	});

	describe('External links', () => {
		it.each([
			['Visit runmaestro.ai', 'https://runmaestro.ai/?theme=dracula'],
			['Join our Discord', 'https://runmaestro.ai/discord?theme=dracula'],
			['Documentation', 'https://docs.runmaestro.ai/?theme=dracula'],
		])('should open header link %s', async (title, url) => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByTitle(title));

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(url);
		});

		it('should open GitHub repo on project GitHub click', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			// The component renders "GitHub" twice - first one is the project repo link (in Action Links section)
			const githubLinks = screen.getAllByText('GitHub');
			fireEvent.click(githubLinks[0]);

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://github.com/RunMaestro/Maestro'
			);
		});
	});

	describe('Layer stack integration', () => {
		it('should register layer on mount', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'strict',
					ariaLabel: 'About Maestro',
				})
			);
		});

		it('should unregister layer on unmount', () => {
			const { unmount } = render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-about-123');
		});
	});

	describe('Close functionality', () => {
		it('should call onClose when X button is clicked', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			const closeButton = screen.getByTestId('x-icon').closest('button');
			expect(closeButton).toBeInTheDocument();
			fireEvent.click(closeButton!);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose via Escape when no badge overlay is open', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			// Get the registered escape handler
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			expect(registerCall.onEscape).toBeDefined();

			// Call the escape handler
			act(() => {
				registerCall.onEscape();
			});

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should handle badge escape handler before modal close', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			// Simulate badge overlay opening (via mocked AchievementCard)
			const openBadgeButton = screen.getByTestId('badge-open-trigger');
			fireEvent.click(openBadgeButton);

			// Get the registered escape handler
			const registerCall = mockRegisterLayer.mock.calls[0][0];

			// Call the escape handler - should handle badge first
			act(() => {
				registerCall.onEscape();
			});

			// onClose should NOT be called because badge handler intercepted
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Global stats loading', () => {
		it('should subscribe to global stats updates on mount', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(window.maestro.agentSessions.onGlobalStatsUpdate).toHaveBeenCalledTimes(1);
		});

		it('should call getGlobalStats on mount', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(window.maestro.agentSessions.getGlobalStats).toHaveBeenCalledTimes(1);
		});

		it('should unsubscribe from stats updates on unmount', () => {
			const { unmount } = render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			unmount();

			expect(unsubscribeMock).toHaveBeenCalledTimes(1);
		});

		it('should display stats when received via callback', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			// Simulate receiving stats via callback
			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalSessions: 42,
							totalMessages: 123,
							isComplete: true,
						})
					);
				}
			});

			// Should no longer show loading
			expect(screen.queryByText('Loading stats...')).not.toBeInTheDocument();

			// Should show stats
			expect(screen.getByText('42')).toBeInTheDocument();
			expect(screen.getByText('123')).toBeInTheDocument();
		});

		it('should use getGlobalStats result when no streaming update arrives', async () => {
			vi.mocked(window.maestro.agentSessions.getGlobalStats).mockResolvedValueOnce(
				createGlobalStats({
					totalSessions: 7,
					totalMessages: 11,
					isComplete: true,
				})
			);

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				await Promise.resolve();
			});

			expect(screen.queryByText('Loading stats...')).not.toBeInTheDocument();
			expect(screen.getByText('7')).toBeInTheDocument();
			expect(screen.getByText('11')).toBeInTheDocument();
		});

		it('should show spinner when stats are not complete', async () => {
			// Mock getGlobalStats to return incomplete stats
			vi.mocked(window.maestro.agentSessions.getGlobalStats).mockResolvedValue(
				createGlobalStats({ isComplete: false })
			);

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			// Simulate receiving incomplete stats via streaming callback
			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats({ isComplete: false }));
				}
			});

			// Should show spinner icon in the header
			expect(screen.getAllByTestId('loader-icon')).toHaveLength(1);
		});

		it('should handle stats loading error gracefully', async () => {
			const consoleErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			vi.mocked(window.maestro.agentSessions.getGlobalStats).mockRejectedValue(new Error('Failed'));

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Failed to load global agent stats:',
				undefined,
				expect.any(Error)
			);
			consoleErrorSpy.mockRestore();
		});

		it('should display "No sessions found" when no stats', async () => {
			const consoleErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			// Setup the mock to reject BEFORE rendering
			vi.mocked(window.maestro.agentSessions.getGlobalStats).mockRejectedValue(new Error('Failed'));

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('No sessions found')).toBeInTheDocument();
			consoleErrorSpy.mockRestore();
		});
	});

	describe('formatTokens helper (tested via display)', () => {
		it('should format millions with M suffix', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalInputTokens: 2500000,
							totalOutputTokens: 1000000,
						})
					);
				}
			});

			expect(screen.getByText('2.5M')).toBeInTheDocument();
			expect(screen.getByText('1.0M')).toBeInTheDocument();
		});

		it('should format thousands with K suffix', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalInputTokens: 5500,
							totalOutputTokens: 2000,
						})
					);
				}
			});

			expect(screen.getByText('5.5K')).toBeInTheDocument();
			expect(screen.getByText('2.0K')).toBeInTheDocument();
		});

		it('should format small numbers without suffix', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalInputTokens: 599,
							totalOutputTokens: 299,
						})
					);
				}
			});

			// Use unique values that won't match other numbers
			expect(screen.getByText('599')).toBeInTheDocument();
			expect(screen.getByText('299')).toBeInTheDocument();
		});
	});

	describe('formatDuration helper (tested via display)', () => {
		it('should format hours and minutes', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={3900000} // 1h 5m
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats());
				}
			});

			expect(screen.getByText(/Hands-on Time:.*1h 5m/)).toBeInTheDocument();
		});

		it('should format minutes and seconds', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={125000} // 2m 5s
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats());
				}
			});

			expect(screen.getByText(/Hands-on Time:.*2m 5s/)).toBeInTheDocument();
		});

		it('should format only seconds for small values', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={45000} // 45s
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats());
				}
			});

			expect(screen.getByText(/Hands-on Time:.*45s/)).toBeInTheDocument();
		});

		it('should not show Active Time when totalActiveTimeMs is 0', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats());
				}
			});

			expect(screen.queryByText('Active Time')).not.toBeInTheDocument();
		});

		it('should display accumulated hands-on time', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={120000} // 2m total
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats());
				}
			});

			expect(screen.getByText(/Hands-on Time:.*2m 0s/)).toBeInTheDocument();
		});
	});

	describe('Cache tokens display', () => {
		it('should show cache tokens when they exist', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalCacheReadTokens: 50000,
							totalCacheCreationTokens: 25000,
						})
					);
				}
			});

			expect(screen.getByText('Cache Read')).toBeInTheDocument();
			expect(screen.getByText('50.0K')).toBeInTheDocument();
			expect(screen.getByText('Cache Creation')).toBeInTheDocument();
			expect(screen.getByText('25.0K')).toBeInTheDocument();
		});

		it('should hide cache tokens when they are 0', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalCacheReadTokens: 0,
							totalCacheCreationTokens: 0,
						})
					);
				}
			});

			expect(screen.queryByText('Cache Read')).not.toBeInTheDocument();
			expect(screen.queryByText('Cache Creation')).not.toBeInTheDocument();
		});
	});

	describe('Total cost display', () => {
		it('should format cost with 2 decimal places', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalCostUsd: 1234.56,
						})
					);
				}
			});

			expect(screen.getByText('$1,234.56')).toBeInTheDocument();
		});

		it('should show cost with pulse animation when incomplete', async () => {
			// Mock getGlobalStats to return incomplete stats
			vi.mocked(window.maestro.agentSessions.getGlobalStats).mockResolvedValue(
				createGlobalStats({ totalCostUsd: 25.5, isComplete: false })
			);

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalCostUsd: 25.5,
							isComplete: false,
						})
					);
				}
			});

			const costElement = screen.getByText('$25.50');
			expect(costElement).toHaveClass('animate-pulse');
		});

		it('should show cost without pulse animation when complete', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalCostUsd: 25.5,
							isComplete: true,
						})
					);
				}
			});

			const costElement = screen.getByText('$25.50');
			expect(costElement).not.toHaveClass('animate-pulse');
		});

		it('should handle undefined totalCostUsd without crashing', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(createGlobalStats({ totalCostUsd: undefined as any, hasCostData: true }));
				}
			});

			// Should render $0.00 instead of crashing ($ and 0.00 in same span)
			const costSpan = screen.getByText((_content, element) => {
				return (element?.tagName === 'SPAN' && element?.textContent?.includes('0.00')) || false;
			});
			expect(costSpan).toBeInTheDocument();
		});
	});

	describe('AchievementCard integration', () => {
		it('should render AchievementCard', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByTestId('achievement-card')).toBeInTheDocument();
		});
	});

	describe('Austin origin section', () => {
		it('should render Austin origin text', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Born in Austin, TX')).toBeInTheDocument();
		});
	});

	describe('Theme styling', () => {
		it('should apply theme colors to modal', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			const modalContent = dialog.querySelector('div > div');
			expect(modalContent).toHaveStyle({ backgroundColor: theme.colors.bgSidebar });
		});

		it('should apply theme colors to title', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			const title = screen.getByText('MAESTRO');
			expect(title).toHaveStyle({ color: theme.colors.textMain });
		});
	});

	describe('Leaderboard registration action', () => {
		it('should hide the leaderboard action when no registration handler is provided', () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			expect(screen.queryByRole('button', { name: /join leaderboard/i })).not.toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /^leaderboard$/i })).not.toBeInTheDocument();
		});

		it('should render and invoke the unregistered leaderboard action', () => {
			const onOpenLeaderboardRegistration = vi.fn();

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
					onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
					isLeaderboardRegistered={false}
				/>
			);

			const button = screen.getByRole('button', { name: /join leaderboard/i });
			expect(button).toBeInTheDocument();

			fireEvent.click(button);

			expect(onOpenLeaderboardRegistration).toHaveBeenCalledTimes(1);
		});

		it('should render the registered leaderboard action state', () => {
			const onOpenLeaderboardRegistration = vi.fn();

			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
					onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
					isLeaderboardRegistered
				/>
			);

			expect(screen.getByText('Leaderboard')).toBeInTheDocument();
			expect(screen.getByTestId('check-icon')).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /join leaderboard/i })).not.toBeInTheDocument();
		});
	});

	describe('Edge cases', () => {
		it('should handle zero handsOnTimeMs', () => {
			expect(() => {
				render(
					<AboutModal
						theme={theme}
						handsOnTimeMs={0}
						autoRunStats={createAutoRunStats()}
						onClose={onClose}
					/>
				);
			}).not.toThrow();
		});

		it('should handle very large token counts', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalInputTokens: 999999999, // Almost 1 billion
						})
					);
				}
			});

			expect(screen.getByText('1000.0M')).toBeInTheDocument();
		});

		it('should handle very large cost', async () => {
			render(
				<AboutModal
					theme={theme}
					handsOnTimeMs={0}
					autoRunStats={createAutoRunStats()}
					onClose={onClose}
				/>
			);

			await act(async () => {
				if (statsCallback) {
					statsCallback(
						createGlobalStats({
							totalCostUsd: 12345678.9,
						})
					);
				}
			});

			expect(screen.getByText('$12,345,678.90')).toBeInTheDocument();
		});
	});
});
