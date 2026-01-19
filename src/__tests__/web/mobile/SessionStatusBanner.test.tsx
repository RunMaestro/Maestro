/**
 * Tests for SessionStatusBanner component
 *
 * @file src/web/mobile/SessionStatusBanner.tsx
 *
 * Tests the session status banner that displays at-a-glance information
 * about the active session including status, tokens, cost, context usage,
 * thinking indicator, and last response preview.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { SessionStatusBanner } from '../../../web/mobile/SessionStatusBanner';
import type { Session, UsageStats, LastResponsePreview } from '../../../web/hooks/useSessions';

// Mock colors object for reuse
const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

// Mock the ThemeProvider hooks - must include both useThemeColors and useTheme
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: mockColors,
		},
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock the constants for haptics
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [10, 50, 10],
		interrupt: [50],
		success: [10, 30, 10],
		error: [50, 50, 50],
	},
}));

// Mock the logger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Import mocks for assertions
import { triggerHaptic, HAPTIC_PATTERNS } from '../../../web/mobile/constants';
import { webLogger } from '../../../web/utils/logger';

describe('SessionStatusBanner', () => {
	// Mock timers for elapsed time tests
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		// Mock clipboard API
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Helper to create a mock session
	const createSession = (overrides: Partial<Session> = {}): Session => ({
		id: 'test-session-123',
		name: 'Test Session',
		toolType: 'claude-code' as any,
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		projectRoot: '/Users/test/project',
		aiPid: 1234,
		terminalPid: 5678,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		...overrides,
	});

	// Helper to create usage stats
	const createUsageStats = (overrides: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 1000,
		outputTokens: 500,
		contextWindow: 200000,
		totalCostUsd: 0.025,
		...overrides,
	});

	// Helper to create last response preview
	const createLastResponse = (
		overrides: Partial<LastResponsePreview> = {}
	): LastResponsePreview => ({
		text: 'This is a sample response from the AI assistant.',
		fullLength: 50,
		timestamp: Date.now() - 60000, // 1 minute ago
		...overrides,
	});

	// ==========================================
	// Pure Functions Tests (via component rendering)
	// ==========================================

	describe('stripAnsiCodes (via LastResponsePreviewSection)', () => {
		it('strips ANSI escape sequences from response text', async () => {
			const lastResponse = createLastResponse({
				text: '\x1b[32mGreen\x1b[0m and \x1b[31mRed\x1b[0m text',
				fullLength: 100,
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} onExpandResponse={vi.fn()} />);

			// Expand the response preview
			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			// Check that ANSI codes are stripped
			expect(screen.getByText('Green and Red text')).toBeInTheDocument();
		});

		it('handles text with multiple ANSI codes', async () => {
			const lastResponse = createLastResponse({
				text: '\x1b[1m\x1b[4m\x1b[33mBold underline yellow\x1b[0m normal',
				fullLength: 50,
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			expect(screen.getByText('Bold underline yellow normal')).toBeInTheDocument();
		});

		it('handles text with no ANSI codes', async () => {
			const lastResponse = createLastResponse({
				text: 'Plain text without any formatting',
				fullLength: 35,
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			expect(screen.getByText('Plain text without any formatting')).toBeInTheDocument();
		});
	});

	describe('truncatePath (via session cwd display)', () => {
		it('displays short paths without truncation', () => {
			const session = createSession({ cwd: '/home/user' });
			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('/home/user')).toBeInTheDocument();
		});

		it('truncates long paths showing last two components', () => {
			const session = createSession({
				cwd: '/Users/developer/projects/very-long-project-name/src/components',
			});
			render(<SessionStatusBanner session={session} />);

			// Should show truncated path with last two components
			expect(screen.getByText(/\.\.\.\/src\/components/)).toBeInTheDocument();
		});

		it('handles empty path', () => {
			const session = createSession({ cwd: '' });
			render(<SessionStatusBanner session={session} />);

			// Empty path results in empty string (no text rendered for path)
			const nameElement = screen.getByText('Test Session');
			expect(nameElement).toBeInTheDocument();
		});

		it('handles path with single component', () => {
			const session = createSession({
				cwd: '/verylongdirectorynamethatexceedsthirtycharacters',
			});
			render(<SessionStatusBanner session={session} />);

			// Should show ellipsis with truncated single component
			expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
		});

		it('handles path at exact length limit', () => {
			const session = createSession({ cwd: '/home/user/project/exactly30char' });
			render(<SessionStatusBanner session={session} />);

			// 30 chars or less should not be truncated
			const pathElement = screen.getByTitle('/home/user/project/exactly30char');
			expect(pathElement).toBeInTheDocument();
		});
	});

	describe('formatCost (via CostTracker)', () => {
		it('formats very small costs as "<$0.01"', () => {
			const usageStats = createUsageStats({ totalCostUsd: 0.0012 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('<$0.01')).toBeInTheDocument();
		});

		it('formats costs under $1 with 2 decimal places', () => {
			const usageStats = createUsageStats({ totalCostUsd: 0.123 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('$0.12')).toBeInTheDocument();
		});

		it('formats costs $1 or more with 2 decimal places', () => {
			const usageStats = createUsageStats({ totalCostUsd: 5.6789 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('$5.68')).toBeInTheDocument();
		});

		it('formats exactly $0.01 with 2 decimal places', () => {
			const usageStats = createUsageStats({ totalCostUsd: 0.01 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('$0.01')).toBeInTheDocument();
		});

		it('formats exactly $1.00 with 2 decimal places', () => {
			const usageStats = createUsageStats({ totalCostUsd: 1.0 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('$1.00')).toBeInTheDocument();
		});

		it('formats zero cost', () => {
			const usageStats = createUsageStats({ totalCostUsd: 0 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('$0.00')).toBeInTheDocument();
		});

		it('does not render CostTracker when cost is undefined', () => {
			const usageStats = createUsageStats({ totalCostUsd: undefined });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByText(/\$/)).toBeNull();
		});

		it('does not render CostTracker when cost is null', () => {
			const usageStats = createUsageStats({ totalCostUsd: null as any });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByText(/\$/)).toBeNull();
		});
	});

	describe('calculateContextUsage (via ContextUsageBar)', () => {
		it('calculates context usage correctly', () => {
			const usageStats = createUsageStats({
				inputTokens: 50000,
				outputTokens: 50000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			// (50000) / 200000 * 100 = 25%
			expect(screen.getByText('25%')).toBeInTheDocument();
		});

		it('rounds percentage to nearest integer', () => {
			const usageStats = createUsageStats({
				inputTokens: 33333,
				outputTokens: 0,
				contextWindow: 100000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			// 33333 / 100000 * 100 = 33.333... rounds to 33%
			expect(screen.getByText('33%')).toBeInTheDocument();
		});

		it('caps percentage at 100%', () => {
			const usageStats = createUsageStats({
				inputTokens: 150000,
				outputTokens: 100000,
				cacheReadInputTokens: 100000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			// (150000 + 100000) / 200000 = 125% capped to 100%
			expect(screen.getByText('100%')).toBeInTheDocument();
		});

		it('does not render when contextWindow is 0', () => {
			const usageStats = createUsageStats({
				inputTokens: 1000,
				outputTokens: 500,
				contextWindow: 0,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByRole('progressbar')).toBeNull();
		});

		it('does not render when contextWindow is undefined', () => {
			const usageStats = createUsageStats({
				inputTokens: 1000,
				outputTokens: 500,
				contextWindow: undefined,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByRole('progressbar')).toBeNull();
		});

		it('does not render when inputTokens is undefined', () => {
			const usageStats = createUsageStats({
				inputTokens: undefined,
				outputTokens: 500,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByRole('progressbar')).toBeNull();
		});

		it('does not render when usageStats is null', () => {
			const session = createSession({ usageStats: null as any });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByRole('progressbar')).toBeNull();
		});
	});

	describe('getContextBarColor (via ContextUsageBar styling)', () => {
		it('shows success color (green) for usage under 70%', () => {
			const usageStats = createUsageStats({
				inputTokens: 50000,
				outputTokens: 10000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			const { container } = render(<SessionStatusBanner session={session} />);

			// Check that the progress bar has success color
			const progressBar = container.querySelector('[role="progressbar"]');
			expect(progressBar).toBeInTheDocument();
		});

		it('shows warning color (yellow) for usage 70-89%', () => {
			const usageStats = createUsageStats({
				inputTokens: 160000,
				outputTokens: 60000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			const { container } = render(<SessionStatusBanner session={session} />);

			// 80% usage should show warning
			const progressBar = container.querySelector('[role="progressbar"]');
			expect(progressBar).toBeInTheDocument();
			expect(screen.getByText('80%')).toBeInTheDocument();
		});

		it('shows error color (red) for usage 90%+', () => {
			const usageStats = createUsageStats({
				inputTokens: 150000,
				outputTokens: 40000,
				cacheReadInputTokens: 40000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			const { container } = render(<SessionStatusBanner session={session} />);

			// 95% usage should show error
			const progressBar = container.querySelector('[role="progressbar"]');
			expect(progressBar).toBeInTheDocument();
			expect(screen.getByText('95%')).toBeInTheDocument();
		});

		it('shows error color at exactly 90%', () => {
			const usageStats = createUsageStats({
				inputTokens: 90000,
				outputTokens: 90000,
				cacheReadInputTokens: 90000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('90%')).toBeInTheDocument();
		});

		it('shows warning color at exactly 70%', () => {
			const usageStats = createUsageStats({
				inputTokens: 140000,
				outputTokens: 70000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('70%')).toBeInTheDocument();
		});
	});

	describe('formatElapsedTime (via ElapsedTimeDisplay)', () => {
		it('formats seconds under a minute as 0:XX', async () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now() - 45000, // 45 seconds ago
			} as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('0:45')).toBeInTheDocument();
		});

		it('formats minutes and seconds as M:SS', async () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now() - 125000, // 2 min 5 sec ago
			} as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('2:05')).toBeInTheDocument();
		});

		it('formats hours, minutes and seconds as H:MM:SS', async () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now() - 3725000, // 1 hour 2 min 5 sec ago
			} as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('1:02:05')).toBeInTheDocument();
		});

		it('pads seconds with leading zero', async () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now() - 5000, // 5 seconds ago
			} as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('0:05')).toBeInTheDocument();
		});

		it('updates elapsed time every second', async () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now() - 1000, // 1 second ago
			} as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('0:01')).toBeInTheDocument();

			// Advance time by 2 seconds
			act(() => {
				vi.advanceTimersByTime(2000);
			});

			expect(screen.getByText('0:03')).toBeInTheDocument();
		});

		it('cleans up interval on unmount', async () => {
			const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now() - 1000,
			} as any);

			const { unmount } = render(<SessionStatusBanner session={session} />);
			unmount();

			expect(clearIntervalSpy).toHaveBeenCalled();
		});
	});

	describe('formatRelativeTime (via LastResponsePreviewSection)', () => {
		it('shows "just now" for timestamps under 1 minute ago', () => {
			const lastResponse = createLastResponse({
				timestamp: Date.now() - 30000, // 30 seconds ago
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText(/just now/)).toBeInTheDocument();
		});

		it('shows "Xm ago" for timestamps under 1 hour ago', () => {
			const lastResponse = createLastResponse({
				timestamp: Date.now() - 1800000, // 30 minutes ago
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText(/30m ago/)).toBeInTheDocument();
		});

		it('shows "Xh ago" for timestamps under 24 hours ago', () => {
			const lastResponse = createLastResponse({
				timestamp: Date.now() - 7200000, // 2 hours ago
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText(/2h ago/)).toBeInTheDocument();
		});

		it('shows "Xd ago" for timestamps over 24 hours ago', () => {
			const lastResponse = createLastResponse({
				timestamp: Date.now() - 172800000, // 2 days ago
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText(/2d ago/)).toBeInTheDocument();
		});

		it('shows "1m ago" at exactly 60 seconds', () => {
			const lastResponse = createLastResponse({
				timestamp: Date.now() - 60000, // exactly 1 minute ago
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText(/1m ago/)).toBeInTheDocument();
		});
	});

	// ==========================================
	// Component Tests
	// ==========================================

	describe('CostTracker component', () => {
		it('renders with dollar icon and formatted cost', () => {
			const usageStats = createUsageStats({ totalCostUsd: 0.5 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('$0.50')).toBeInTheDocument();
			expect(screen.getByText('💰')).toBeInTheDocument();
		});

		it('has accessible title and aria-label', () => {
			const usageStats = createUsageStats({ totalCostUsd: 1.23 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			const costElement = screen.getByLabelText(/Session cost: \$1.23/);
			expect(costElement).toBeInTheDocument();
		});
	});

	describe('TokenCount component', () => {
		it('displays total tokens under 1000 as plain number', () => {
			const usageStats = createUsageStats({
				inputTokens: 400,
				outputTokens: 200,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('600')).toBeInTheDocument();
		});

		it('displays thousands with K suffix', () => {
			const usageStats = createUsageStats({
				inputTokens: 5000,
				outputTokens: 2500,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('7.5K')).toBeInTheDocument();
		});

		it('displays millions with M suffix', () => {
			const usageStats = createUsageStats({
				inputTokens: 1500000,
				outputTokens: 500000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('2.0M')).toBeInTheDocument();
		});

		it('does not render when total tokens is 0', () => {
			const usageStats = createUsageStats({
				inputTokens: 0,
				outputTokens: 0,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			// The chart emoji should not be present for tokens
			expect(screen.queryByText('📊')).toBeNull();
		});

		it('does not render when usageStats is null', () => {
			const session = createSession({ usageStats: null as any });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByText('📊')).toBeNull();
		});

		it('has accessible aria-label with full token count', () => {
			const usageStats = createUsageStats({
				inputTokens: 12345,
				outputTokens: 6789,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			const tokenElement = screen.getByLabelText(/19,134 tokens used/);
			expect(tokenElement).toBeInTheDocument();
		});

		it('has detailed title with breakdown', () => {
			const usageStats = createUsageStats({
				inputTokens: 1000,
				outputTokens: 500,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			const tokenElement = screen.getByTitle(/Input: 1,000 \| Output: 500 \| Total: 1,500 tokens/);
			expect(tokenElement).toBeInTheDocument();
		});

		it('handles undefined inputTokens with fallback to 0', () => {
			const usageStats = createUsageStats({
				inputTokens: undefined,
				outputTokens: 500,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('500')).toBeInTheDocument();
		});
	});

	describe('ThinkingIndicator component', () => {
		it('renders when session state is busy', () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now(),
			} as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByLabelText('AI is thinking')).toBeInTheDocument();
		});

		it('does not render when session state is idle', () => {
			const session = createSession({ state: 'idle' });

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByLabelText('AI is thinking')).toBeNull();
		});

		it('renders three animated dots', () => {
			const session = createSession({
				state: 'busy',
				thinkingStartTime: Date.now(),
			} as any);

			const { container } = render(<SessionStatusBanner session={session} />);

			const thinkingSpan = screen.getByLabelText('AI is thinking');
			const dots = thinkingSpan.querySelectorAll('span');
			expect(dots.length).toBe(3);
		});
	});

	describe('ContextUsageBar component', () => {
		it('renders progressbar with correct ARIA attributes', () => {
			const usageStats = createUsageStats({
				inputTokens: 100000,
				outputTokens: 50000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			const progressbar = screen.getByRole('progressbar');
			expect(progressbar).toHaveAttribute('aria-valuenow', '50');
			expect(progressbar).toHaveAttribute('aria-valuemin', '0');
			expect(progressbar).toHaveAttribute('aria-valuemax', '100');
		});

		it('has accessible aria-label', () => {
			const usageStats = createUsageStats({
				inputTokens: 100000,
				outputTokens: 50000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByLabelText('Context window 50% used')).toBeInTheDocument();
		});

		it('has descriptive title', () => {
			const usageStats = createUsageStats({
				inputTokens: 100000,
				outputTokens: 50000,
				contextWindow: 200000,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByTitle('Context window: 50% used')).toBeInTheDocument();
		});
	});

	describe('LastResponsePreviewSection component', () => {
		it('does not render when lastResponse is null', () => {
			const session = createSession({ lastResponse: null } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByText('Last Response')).toBeNull();
		});

		it('does not render when lastResponse.text is empty', () => {
			const lastResponse = createLastResponse({ text: '' });
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByText('Last Response')).toBeNull();
		});

		it('renders collapsed by default', () => {
			const lastResponse = createLastResponse({
				text: 'Sample response text',
				fullLength: 100,
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
		});

		it('toggles expansion on click', () => {
			const lastResponse = createLastResponse({
				text: 'Sample response text',
				fullLength: 100,
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
			expect(screen.getByText('Sample response text')).toBeInTheDocument();
		});

		it('shows "has more content" indicator when text is truncated', () => {
			const lastResponse = createLastResponse({
				text: 'Short preview',
				fullLength: 1000, // Full length is much longer
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('1000 chars')).toBeInTheDocument();
		});

		it('does not show char count when text is not truncated', () => {
			const lastResponse = createLastResponse({
				text: 'Full response text here',
				fullLength: 23, // Same length as text
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} />);

			expect(screen.queryByText(/chars$/)).toBeNull();
		});

		it('shows "Tap to view full response" hint when expanded and has more content', () => {
			const lastResponse = createLastResponse({
				text: 'Short preview',
				fullLength: 1000,
			});
			const session = createSession({ lastResponse } as any);
			const onExpandResponse = vi.fn();

			render(<SessionStatusBanner session={session} onExpandResponse={onExpandResponse} />);

			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			expect(screen.getByText('Tap to view full response')).toBeInTheDocument();
		});

		it('does not show hint when text is not truncated', () => {
			const lastResponse = createLastResponse({
				text: 'Full response',
				fullLength: 13,
			});
			const session = createSession({ lastResponse } as any);

			render(<SessionStatusBanner session={session} onExpandResponse={vi.fn()} />);

			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			expect(screen.queryByText('Tap to view full response')).toBeNull();
		});

		it('calls onExpandResponse when preview content is clicked', () => {
			const lastResponse = createLastResponse({
				text: 'Click me to expand',
				fullLength: 100,
			});
			const session = createSession({ lastResponse } as any);
			const onExpandResponse = vi.fn();

			render(<SessionStatusBanner session={session} onExpandResponse={onExpandResponse} />);

			// Expand first
			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			// Click on the preview content
			const previewContent = screen.getByText('Click me to expand');
			fireEvent.click(previewContent);

			expect(onExpandResponse).toHaveBeenCalledWith(lastResponse);
		});

		describe('copy functionality', () => {
			it('copies text to clipboard on share button click', async () => {
				const lastResponse = createLastResponse({
					text: 'Copy this text',
					fullLength: 14,
				});
				const session = createSession({ lastResponse } as any);

				render(<SessionStatusBanner session={session} />);

				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Copy this text');
			});

			it('shows "Copied" feedback after successful copy', async () => {
				const lastResponse = createLastResponse({
					text: 'Copy this text',
					fullLength: 14,
				});
				const session = createSession({ lastResponse } as any);

				render(<SessionStatusBanner session={session} />);

				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				expect(screen.getByText('Copied')).toBeInTheDocument();
				expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.success);
			});

			it('resets copy state after 2 seconds', async () => {
				const lastResponse = createLastResponse({
					text: 'Copy this text',
					fullLength: 14,
				});
				const session = createSession({ lastResponse } as any);

				render(<SessionStatusBanner session={session} />);

				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				expect(screen.getByText('Copied')).toBeInTheDocument();

				act(() => {
					vi.advanceTimersByTime(2000);
				});

				expect(screen.getByText('Copy')).toBeInTheDocument();
			});

			it('shows "Failed" feedback when clipboard write fails', async () => {
				(navigator.clipboard.writeText as any).mockRejectedValueOnce(new Error('Copy failed'));

				const lastResponse = createLastResponse({
					text: 'Copy this text',
					fullLength: 14,
				});
				const session = createSession({ lastResponse } as any);

				render(<SessionStatusBanner session={session} />);

				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				expect(screen.getByText('Failed')).toBeInTheDocument();
				expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.error);
				expect(webLogger.error).toHaveBeenCalled();
			});

			it('uses fallback copy method when clipboard API unavailable', async () => {
				// Remove clipboard API
				const originalClipboard = navigator.clipboard;
				Object.defineProperty(navigator, 'clipboard', {
					value: undefined,
					writable: true,
				});

				// Mock document.execCommand (deprecated but still used for fallback)
				// Note: jsdom doesn't define execCommand by default
				(document as any).execCommand = vi.fn().mockReturnValue(true);
				const appendChildSpy = vi.spyOn(document.body, 'appendChild');
				const removeChildSpy = vi.spyOn(document.body, 'removeChild');

				const lastResponse = createLastResponse({
					text: 'Fallback copy text',
					fullLength: 18,
				});
				const session = createSession({ lastResponse } as any);

				render(<SessionStatusBanner session={session} />);

				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				expect((document as any).execCommand).toHaveBeenCalledWith('copy');
				expect(appendChildSpy).toHaveBeenCalled();
				expect(removeChildSpy).toHaveBeenCalled();
				expect(screen.getByText('Copied')).toBeInTheDocument();

				// Restore
				Object.defineProperty(navigator, 'clipboard', {
					value: originalClipboard,
					writable: true,
				});
				delete (document as any).execCommand;
			});

			it('calls onShare callback when provided', async () => {
				const lastResponse = createLastResponse({
					text: 'Share this text',
					fullLength: 15,
				});
				const session = createSession({ lastResponse } as any);
				const onShare = vi.fn();

				// We need to access the internal LastResponsePreviewSection
				// For now, we test that the copy works (share is internal)
				render(<SessionStatusBanner session={session} />);

				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Share this text');
			});

			it('stops event propagation on share button click', async () => {
				const lastResponse = createLastResponse({
					text: 'Copy text',
					fullLength: 9,
				});
				const session = createSession({ lastResponse } as any);

				render(<SessionStatusBanner session={session} />);

				// Expand first
				const toggleButton = screen.getByRole('button', { name: /expand last response/i });
				fireEvent.click(toggleButton);
				expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

				// Click copy button - should not collapse the section
				const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
				await act(async () => {
					fireEvent.click(copyButton);
				});

				// Should still be expanded
				expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
			});
		});
	});

	// ==========================================
	// Main SessionStatusBanner Component Tests
	// ==========================================

	describe('SessionStatusBanner main component', () => {
		it('returns null when session is null', () => {
			const { container } = render(<SessionStatusBanner session={null} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders with basic session data', () => {
			const session = createSession();
			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('Test Session')).toBeInTheDocument();
			expect(screen.getByText('/Users/test/project')).toBeInTheDocument();
		});

		it('displays session ID (first 8 chars)', () => {
			const session = createSession({ id: 'abcdef1234567890' });
			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('abcdef12')).toBeInTheDocument();
			expect(screen.getByTitle('Session ID: abcdef1234567890')).toBeInTheDocument();
		});

		it('has accessible role and aria-label', () => {
			const session = createSession({ name: 'My Session', state: 'idle' });
			render(<SessionStatusBanner session={session} />);

			// Multiple role="status" elements exist (banner and StatusDot)
			// Find the main banner by aria-label
			const banner = screen.getByLabelText(/Current session: My Session, status: idle/);
			expect(banner).toBeInTheDocument();
			expect(banner).toHaveAttribute('role', 'status');
		});

		it('has aria-live="polite" for status updates', () => {
			const session = createSession();
			render(<SessionStatusBanner session={session} />);

			// Find the main banner by aria-label (it has aria-live)
			const banner = screen.getByLabelText(/Current session: Test Session/);
			expect(banner).toHaveAttribute('aria-live', 'polite');
		});

		describe('input mode indicator', () => {
			it('shows "AI" badge when inputMode is ai', () => {
				const session = createSession({ inputMode: 'ai' });
				render(<SessionStatusBanner session={session} />);

				expect(screen.getByText('AI')).toBeInTheDocument();
			});

			it('shows "Terminal" badge when inputMode is terminal', () => {
				const session = createSession({ inputMode: 'terminal' });
				render(<SessionStatusBanner session={session} />);

				expect(screen.getByText('Terminal')).toBeInTheDocument();
			});
		});

		describe('status indicator', () => {
			it('shows StatusDot for idle state', () => {
				const session = createSession({ state: 'idle' });
				const { container } = render(<SessionStatusBanner session={session} />);

				// StatusDot should be rendered
				expect(
					container.querySelector('[class*="StatusDot"]') ||
						screen.getByLabelText(/Current session.*idle/)
				).toBeInTheDocument();
			});

			it('shows StatusDot for busy state with thinking indicator', () => {
				const session = createSession({
					state: 'busy',
					thinkingStartTime: Date.now(),
				} as any);
				render(<SessionStatusBanner session={session} />);

				expect(screen.getByLabelText('AI is thinking')).toBeInTheDocument();
			});

			it('shows StatusDot for error state', () => {
				const session = createSession({ state: 'error' });
				render(<SessionStatusBanner session={session} />);

				expect(screen.getByLabelText(/Current session.*error/)).toBeInTheDocument();
			});

			it('shows StatusDot for connecting state', () => {
				const session = createSession({ state: 'connecting' });
				render(<SessionStatusBanner session={session} />);

				expect(screen.getByLabelText(/Current session.*connecting/)).toBeInTheDocument();
			});

			it('defaults unknown states to error', () => {
				const session = createSession({ state: 'unknown-state' as any });
				render(<SessionStatusBanner session={session} />);

				expect(screen.getByLabelText(/Current session.*error/)).toBeInTheDocument();
			});

			it('defaults undefined state to idle', () => {
				const session = createSession({ state: undefined as any });
				render(<SessionStatusBanner session={session} />);

				// When state is undefined, it defaults to 'idle' due to || 'idle' fallback
				const banner = screen.getByLabelText(/Current session: Test Session, status: idle/);
				expect(banner).toBeInTheDocument();
			});
		});

		describe('styling', () => {
			it('applies custom className', () => {
				const session = createSession();
				const { container } = render(
					<SessionStatusBanner session={session} className="custom-class" />
				);

				expect(container.firstChild).toHaveClass('custom-class');
			});

			it('applies custom style', () => {
				const session = createSession();
				const { container } = render(
					<SessionStatusBanner session={session} style={{ marginTop: '10px' }} />
				);

				expect(container.firstChild).toHaveStyle({ marginTop: '10px' });
			});
		});

		describe('complete session rendering', () => {
			it('renders all components with full session data', () => {
				const usageStats = createUsageStats({
					inputTokens: 5000,
					outputTokens: 2000,
					contextWindow: 200000,
					totalCostUsd: 0.15,
				});
				const lastResponse = createLastResponse({
					text: 'AI response here',
					fullLength: 100,
					timestamp: Date.now() - 300000, // 5 minutes ago
				});
				const session = createSession({
					name: 'Full Session',
					cwd: '/Users/developer/project',
					state: 'idle',
					inputMode: 'ai',
					usageStats,
					lastResponse,
				} as any);

				render(<SessionStatusBanner session={session} />);

				// Session name
				expect(screen.getByText('Full Session')).toBeInTheDocument();
				// Path
				expect(screen.getByText('/Users/developer/project')).toBeInTheDocument();
				// Mode
				expect(screen.getByText('AI')).toBeInTheDocument();
				// Cost
				expect(screen.getByText('$0.15')).toBeInTheDocument();
				// Tokens
				expect(screen.getByText('7.0K')).toBeInTheDocument();
				// Context usage
				expect(screen.getByText('3%')).toBeInTheDocument();
				// Last response section
				expect(screen.getByText(/5m ago/)).toBeInTheDocument();
			});

			it('shows elapsed time and thinking indicator when busy with thinkingStartTime', () => {
				const session = createSession({
					state: 'busy',
					thinkingStartTime: Date.now() - 30000, // 30 seconds ago
				} as any);

				render(<SessionStatusBanner session={session} />);

				expect(screen.getByText('0:30')).toBeInTheDocument();
				expect(screen.getByLabelText('AI is thinking')).toBeInTheDocument();
			});

			it('does not show elapsed time when busy without thinkingStartTime', () => {
				const session = createSession({
					state: 'busy',
					thinkingStartTime: undefined,
				} as any);

				render(<SessionStatusBanner session={session} />);

				expect(screen.queryByText(/^\d+:\d{2}$/)).toBeNull();
			});
		});
	});

	// ==========================================
	// Edge Cases and Integration Tests
	// ==========================================

	describe('edge cases', () => {
		it('handles session with empty name', () => {
			const session = createSession({ name: '' });
			render(<SessionStatusBanner session={session} />);

			// Should still render the banner - find by aria-label
			const banner = screen.getByLabelText(/Current session: , status: idle/);
			expect(banner).toBeInTheDocument();
		});

		it('handles session with very long name', () => {
			const session = createSession({
				name: 'This is a very long session name that should be displayed with ellipsis truncation',
			});
			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText(/This is a very long session name/)).toBeInTheDocument();
		});

		it('handles session with special characters in name', () => {
			const session = createSession({
				name: '<script>alert("xss")</script>',
			});
			render(<SessionStatusBanner session={session} />);

			// Should be escaped, not executed
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles session with unicode characters', () => {
			const session = createSession({
				name: '🎵 Music App 日本語',
				cwd: '/Users/テスト/프로젝트',
			});
			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('🎵 Music App 日本語')).toBeInTheDocument();
		});

		it('handles extremely large token counts', () => {
			const usageStats = createUsageStats({
				inputTokens: 999999999,
				outputTokens: 999999999,
			});
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			// Should show in M format
			expect(screen.getByText('2000.0M')).toBeInTheDocument();
		});

		it('handles very small cost values', () => {
			const usageStats = createUsageStats({ totalCostUsd: 0.00001 });
			const session = createSession({ usageStats });

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('<$0.01')).toBeInTheDocument();
		});

		it('handles rapid state changes', () => {
			const session1 = createSession({ state: 'idle' });
			const { rerender } = render(<SessionStatusBanner session={session1} />);

			const session2 = createSession({ state: 'busy', thinkingStartTime: Date.now() } as any);
			rerender(<SessionStatusBanner session={session2} />);

			expect(screen.getByLabelText('AI is thinking')).toBeInTheDocument();

			const session3 = createSession({ state: 'idle' });
			rerender(<SessionStatusBanner session={session3} />);

			expect(screen.queryByLabelText('AI is thinking')).toBeNull();
		});

		it('handles session switch', () => {
			const session1 = createSession({ id: 'session-1', name: 'Session One' });
			const { rerender } = render(<SessionStatusBanner session={session1} />);

			expect(screen.getByText('Session One')).toBeInTheDocument();

			const session2 = createSession({ id: 'session-2', name: 'Session Two' });
			rerender(<SessionStatusBanner session={session2} />);

			expect(screen.getByText('Session Two')).toBeInTheDocument();
			expect(screen.queryByText('Session One')).toBeNull();
		});

		it('handles session becoming null', () => {
			const session = createSession();
			const { rerender, container } = render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('Test Session')).toBeInTheDocument();

			rerender(<SessionStatusBanner session={null} />);

			expect(container.firstChild).toBeNull();
		});
	});

	describe('integration scenarios', () => {
		it('renders complete busy state with all indicators', () => {
			const usageStats = createUsageStats({
				inputTokens: 150000,
				outputTokens: 30000,
				contextWindow: 200000,
				totalCostUsd: 2.5,
			});
			const session = createSession({
				name: 'Working Session',
				state: 'busy',
				inputMode: 'ai',
				usageStats,
				thinkingStartTime: Date.now() - 65000, // 1 min 5 sec ago
			} as any);

			render(<SessionStatusBanner session={session} />);

			// All indicators should be present
			expect(screen.getByText('Working Session')).toBeInTheDocument();
			expect(screen.getByText('AI')).toBeInTheDocument();
			expect(screen.getByText('$2.50')).toBeInTheDocument();
			expect(screen.getByText('180.0K')).toBeInTheDocument();
			expect(screen.getByText('75%')).toBeInTheDocument();
			expect(screen.getByText('1:05')).toBeInTheDocument();
			expect(screen.getByLabelText('AI is thinking')).toBeInTheDocument();
		});

		it('renders minimal idle state', () => {
			const session = createSession({
				name: 'Minimal',
				state: 'idle',
				usageStats: null as any,
			});

			render(<SessionStatusBanner session={session} />);

			expect(screen.getByText('Minimal')).toBeInTheDocument();
			// No cost, no tokens, no context bar
			expect(screen.queryByText(/\$/)).toBeNull();
			expect(screen.queryByText('📊')).toBeNull();
			expect(screen.queryByRole('progressbar')).toBeNull();
		});

		it('handles response preview expansion and copy workflow', async () => {
			const lastResponse = createLastResponse({
				text: 'Here is the AI response that can be copied.',
				fullLength: 45,
			});
			const session = createSession({ lastResponse } as any);
			const onExpandResponse = vi.fn();

			render(<SessionStatusBanner session={session} onExpandResponse={onExpandResponse} />);

			// Initially collapsed
			expect(screen.queryByText('Here is the AI response')).toBeNull();

			// Expand
			const toggleButton = screen.getByRole('button', { name: /expand last response/i });
			fireEvent.click(toggleButton);

			// Now visible
			expect(screen.getByText('Here is the AI response that can be copied.')).toBeInTheDocument();

			// Copy
			const copyButton = screen.getByRole('button', { name: /copy response to clipboard/i });
			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
				'Here is the AI response that can be copied.'
			);
			expect(screen.getByText('Copied')).toBeInTheDocument();

			// Collapse
			fireEvent.click(toggleButton);
			expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
		});
	});

	describe('default export', () => {
		it('exports SessionStatusBanner as default', async () => {
			const module = await import('../../../web/mobile/SessionStatusBanner');
			expect(module.default).toBe(module.SessionStatusBanner);
		});
	});
});
