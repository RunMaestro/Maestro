/**
 * Tests for TabSwitcherModal component
 *
 * TabSwitcherModal provides quick navigation between AI tabs with:
 * - Fuzzy search filtering
 * - Two view modes: "Open Tabs" and "All Named" (named sessions only)
 * - Context gauge visualization for token usage
 * - Keyboard navigation (Arrow keys, Enter, Tab to switch modes)
 * - Number hotkeys (Cmd+1-9, Cmd+0) for quick selection
 * - Layer stack integration for modal management
 * - Named session sync and loading
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TabSwitcherModal } from '../../../renderer/components/TabSwitcherModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, AITab } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Search: () => <svg data-testid="search-icon" />,
	Star: () => <svg data-testid="star-icon" />,
}));

// Create a test theme
const createTestTheme = (overrides: Partial<Theme['colors']> = {}): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
		...overrides,
	},
});

// Create test tabs
const createTestTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: `tab-${Math.random().toString(36).substr(2, 9)}`,
	name: '',
	agentSessionId: `${Math.random().toString(36).substr(2, 8)}-abcd-1234-5678-123456789abc`,
	starred: false,
	state: 'idle',
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: Date.now(),
	usageStats: {
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.05,
		contextWindow: 200000,
	},
	...overrides,
});

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('TabSwitcherModal', () => {
	let theme: Theme;

	beforeEach(() => {
		theme = createTestTheme();
		vi.clearAllMocks();

		// Mock scrollIntoView (not available in jsdom)
		Element.prototype.scrollIntoView = vi.fn();

		// Reset the mocks for each test
		vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([]);
		vi.mocked(window.maestro.agentSessions.updateSessionName).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('pure helper functions', () => {
		describe('formatTokens', () => {
			it('formats tokens under 1000 as-is', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 500,
						outputTokens: 200,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.01,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// 500 + 200 = 700 tokens, should show "700 tokens"
				expect(screen.getByText('700 tokens')).toBeInTheDocument();
			});

			it('formats tokens >= 1000 with K suffix', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 5000,
						outputTokens: 3500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.1,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// 5000 + 3500 = 8500 tokens = 8.5K
				expect(screen.getByText('8.5K tokens')).toBeInTheDocument();
			});

			it('formats exactly 1000 tokens with K suffix', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 700,
						outputTokens: 300,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.02,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('1.0K tokens')).toBeInTheDocument();
			});
		});

		describe('formatCost', () => {
			it('formats zero cost', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('$0.00')).toBeInTheDocument();
			});

			it('formats cost less than $0.01 as <$0.01', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.005,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('<$0.01')).toBeInTheDocument();
			});

			it('formats cost >= $0.01 with two decimal places', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 1.23,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('$1.23')).toBeInTheDocument();
			});
		});

		describe('formatRelativeTime', () => {
			it('formats "just now" for < 1 minute ago', () => {
				const tab = createTestTab({
					logs: [{ id: '1', timestamp: Date.now() - 30000, source: 'stdout', text: 'test' }],
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('just now')).toBeInTheDocument();
			});

			it('formats minutes ago', () => {
				const tab = createTestTab({
					logs: [
						{ id: '1', timestamp: Date.now() - 5 * 60 * 1000, source: 'stdout', text: 'test' },
					],
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('5m ago')).toBeInTheDocument();
			});

			it('formats hours ago', () => {
				const tab = createTestTab({
					logs: [
						{ id: '1', timestamp: Date.now() - 3 * 60 * 60 * 1000, source: 'stdout', text: 'test' },
					],
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('3h ago')).toBeInTheDocument();
			});

			it('formats days ago', () => {
				const tab = createTestTab({
					logs: [
						{
							id: '1',
							timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000,
							source: 'stdout',
							text: 'test',
						},
					],
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('2d ago')).toBeInTheDocument();
			});

			it('formats as date for > 7 days ago', () => {
				const tab = createTestTab({
					logs: [
						{
							id: '1',
							timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
							source: 'stdout',
							text: 'test',
						},
					],
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// Should show something like "Nov 27" (short month + day)
				const dateText = screen.queryByText(/^\w{3}\s\d{1,2}$/);
				expect(dateText).toBeInTheDocument();
			});
		});

		describe('getTabDisplayName', () => {
			it('returns tab name if set', () => {
				const tab = createTestTab({ name: 'My Custom Tab' });

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('My Custom Tab')).toBeInTheDocument();
			});

			it('returns first UUID octet if no name', () => {
				const tab = createTestTab({
					name: '',
					agentSessionId: 'abc12345-1234-5678-9abc-123456789abc',
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('ABC12345')).toBeInTheDocument();
			});

			it('returns "New Session" if no name or UUID', () => {
				const tab = createTestTab({ name: '', agentSessionId: undefined });

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('New Session')).toBeInTheDocument();
			});
		});

		describe('getUuidPill', () => {
			it('shows UUID pill when tab has both name and agentSessionId', () => {
				const tab = createTestTab({
					name: 'Named Tab',
					agentSessionId: 'def56789-1234-5678-9abc-123456789abc',
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('Named Tab')).toBeInTheDocument();
				expect(screen.getByText('DEF56789')).toBeInTheDocument();
			});

			it('does not show UUID pill when no agentSessionId', () => {
				const tab = createTestTab({
					name: 'Named Tab',
					agentSessionId: undefined,
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				expect(screen.getByText('Named Tab')).toBeInTheDocument();
				// No UUID pill should be shown
				expect(screen.queryByText(/^[A-F0-9]{8}$/)).not.toBeInTheDocument();
			});
		});

		describe('getContextPercentage', () => {
			it('hides context gauge when no usageStats', () => {
				const tab = createTestTab({ usageStats: undefined });

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// Context gauge should not be rendered when contextWindow is not configured
				expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
			});

			it('hides context gauge when contextWindow is 0', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.05,
						contextWindow: 0,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// Context gauge should not be rendered when contextWindow is 0
				expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
			});

			it('calculates correct percentage', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 20000,
						outputTokens: 10000,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.5,
						contextWindow: 100000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// 20000 / 100000 = 20%
				expect(screen.getByText('20%')).toBeInTheDocument();
			});

			it('caps at 100%', () => {
				const tab = createTestTab({
					usageStats: {
						inputTokens: 150000,
						outputTokens: 0,
						cacheReadInputTokens: 100000, // Excluded from calculation (cumulative)
						cacheCreationInputTokens: 100000,
						totalCostUsd: 5.0,
						contextWindow: 200000,
					},
				});

				renderWithLayerStack(
					<TabSwitcherModal
						theme={theme}
						tabs={[tab]}
						activeTabId={tab.id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={vi.fn()}
					/>
				);

				// (150000 + 100000) / 200000 = 125% -> capped at 100% (cacheRead excluded)
				expect(screen.getByText('100%')).toBeInTheDocument();
			});
		});
	});

	describe('rendering', () => {
		it('renders search header with icon and input', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByTestId('search-icon')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('Search open tabs...')).toBeInTheDocument();
			expect(screen.getByText('ESC')).toBeInTheDocument();
		});

		it('renders dialog with correct ARIA attributes', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Tab Switcher');
		});

		it('renders mode toggle pills', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText(/Open Tabs/)).toBeInTheDocument();
			expect(screen.getByText(/All Named/)).toBeInTheDocument();
			expect(screen.getByText(/↑↓ navigate • Enter select/)).toBeInTheDocument();
		});

		it('renders footer with navigation hints', () => {
			const tabs = [createTestTab(), createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('2 tabs')).toBeInTheDocument();
			expect(
				screen.getByText('↑↓ navigate • Enter select • ⌘1-9 quick select')
			).toBeInTheDocument();
		});

		it('renders shortcut hint when provided', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					shortcut={{ id: 'test', label: 'Test', keys: ['Meta', 'T'] }}
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// In jsdom environment, navigator.userAgent doesn't contain 'Mac'
			// so shortcut formatter uses Ctrl+T format instead of ⌘T
			expect(screen.getByText('Ctrl+T')).toBeInTheDocument();
		});

		it('renders empty state for no tabs', () => {
			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[]}
					activeTabId=""
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('No open tabs')).toBeInTheDocument();
		});

		it('renders tabs sorted alphabetically', () => {
			const tabs = [
				createTestTab({ name: 'Zebra' }),
				createTestTab({ name: 'Alpha' }),
				createTestTab({ name: 'Beta' }),
			];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const buttons = screen
				.getAllByRole('button')
				.filter(
					(b) =>
						b.textContent?.includes('Alpha') ||
						b.textContent?.includes('Beta') ||
						b.textContent?.includes('Zebra')
				);

			expect(buttons[0]).toHaveTextContent('Alpha');
			expect(buttons[1]).toHaveTextContent('Beta');
			expect(buttons[2]).toHaveTextContent('Zebra');
		});
	});

	describe('tab indicators', () => {
		it('shows busy indicator for busy tabs', () => {
			const tab = createTestTab({ state: 'busy' });

			const { container } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Busy indicator should have animate-pulse class and warning color
			const pulsingDot = container.querySelector('.animate-pulse');
			expect(pulsingDot).toBeInTheDocument();
			expect(pulsingDot).toHaveStyle({ backgroundColor: theme.colors.warning });
		});

		it('shows active indicator for active tab', () => {
			const tab = createTestTab({ state: 'idle' });

			const { container } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Find any indicator dot with the success color (check style object)
			// The container wrapper for the indicator has class 'flex-shrink-0 w-2 h-2'
			// Inside it, there's a div that has the actual background color
			const indicatorWrappers = container.querySelectorAll('.flex-shrink-0.w-2.h-2');
			// At least one indicator should exist
			expect(indicatorWrappers.length).toBeGreaterThan(0);

			// Find the colored dot inside the wrapper
			const dots = container.querySelectorAll('.w-2.h-2.rounded-full');
			// For active non-busy tab, we should have a green dot
			// Note: The style might use rgb() format instead of hex
			const greenDot = Array.from(dots).find((d) => {
				const style = d.getAttribute('style') || '';
				return style.includes('rgb(137, 209, 133)') || style.includes(theme.colors.success);
			});
			expect(greenDot).toBeTruthy();
		});

		it('shows starred indicator for starred tabs', () => {
			const tab = createTestTab({ starred: true });

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('★')).toBeInTheDocument();
		});
	});

	describe('ContextGauge component', () => {
		it('renders SVG gauge with correct structure', () => {
			const tab = createTestTab({
				usageStats: {
					inputTokens: 10000,
					outputTokens: 10000,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.5,
					contextWindow: 100000,
				},
			});

			const { container } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should have an SVG for the gauge
			const svgs = container.querySelectorAll('svg');
			// One is the Search icon, one is the gauge
			expect(svgs.length).toBeGreaterThan(0);

			// Find the gauge SVG (it has circles)
			const gaugeSvg = Array.from(svgs).find((svg) => svg.querySelectorAll('circle').length === 2);
			expect(gaugeSvg).toBeTruthy();
		});

		it('applies color based on percentage (success for low)', () => {
			const tab = createTestTab({
				usageStats: {
					inputTokens: 10000,
					outputTokens: 5000,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.25,
					contextWindow: 200000,
				},
			});

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// 5% usage should show success color
			expect(screen.getByText('5%')).toHaveStyle({ color: theme.colors.success });
		});
	});

	describe('view mode switching', () => {
		it('switches to All Named mode on pill click', async () => {
			const tabs = [createTestTab({ name: 'Open Tab' })];

			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([
				{
					agentId: 'claude-code',
					agentSessionId: 'closed-123-abc-def-789',
					projectPath: '/test',
					sessionName: 'Closed Session',
					starred: false,
				},
			]);

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Wait for named sessions to load
			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			// Click All Named pill
			fireEvent.click(screen.getByText(/All Named/));

			// Should now show named sessions
			await waitFor(() => {
				expect(screen.getByText('Closed Session')).toBeInTheDocument();
			});
		});

		it('switches modes with Tab key', async () => {
			const tabs = [createTestTab({ name: 'Open Tab' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Focus input and press Tab
			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.keyDown(input, { key: 'Tab' });

			// Placeholder should change to indicate All Named mode
			expect(screen.getByPlaceholderText('Search named sessions...')).toBeInTheDocument();
		});

		it('shows "Closed" badge for closed named sessions', async () => {
			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([
				{
					agentId: 'claude-code',
					agentSessionId: 'closed-session-id',
					projectPath: '/test',
					sessionName: 'Closed Session',
				},
			]);

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[]}
					activeTabId=""
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Wait for load
			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			fireEvent.click(screen.getByText(/All Named/));

			await waitFor(() => {
				expect(screen.getByText('Closed')).toBeInTheDocument();
			});
		});

		it('filters named sessions by current project', async () => {
			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([
				{
					agentId: 'claude-code',
					agentSessionId: 'same-project-id',
					projectPath: '/test',
					sessionName: 'Same Project Session',
				},
				{
					agentId: 'claude-code',
					agentSessionId: 'different-project-id',
					projectPath: '/other-project',
					sessionName: 'Different Project Session',
				},
				{
					agentId: 'codex',
					agentSessionId: 'other-agent-id',
					projectPath: '/test',
					sessionName: 'Other Agent Session',
				},
			]);

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[]}
					activeTabId=""
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			fireEvent.click(screen.getByText(/All Named/));

			await waitFor(() => {
				expect(screen.getByText('Same Project Session')).toBeInTheDocument();
				expect(screen.queryByText('Different Project Session')).not.toBeInTheDocument();
				expect(screen.queryByText('Other Agent Session')).not.toBeInTheDocument();
			});
		});

		it('switches to Starred mode on pill click', async () => {
			const starredTab = createTestTab({ name: 'Starred Tab', starred: true });
			const unstarredTab = createTestTab({ name: 'Unstarred Tab', starred: false });

			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([
				{
					agentId: 'claude-code',
					agentSessionId: 'starred-closed-123',
					projectPath: '/test',
					sessionName: 'Starred Closed Session',
					starred: true,
				},
				{
					agentId: 'claude-code',
					agentSessionId: 'unstarred-closed-456',
					projectPath: '/test',
					sessionName: 'Unstarred Closed Session',
					starred: false,
				},
			]);

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[starredTab, unstarredTab]}
					activeTabId={starredTab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			// Click Starred pill (use exact pattern to avoid matching list items)
			fireEvent.click(screen.getByRole('button', { name: /Starred \(\d+\)/ }));

			// Should show only starred items
			await waitFor(() => {
				expect(screen.getByText('Starred Tab')).toBeInTheDocument();
				expect(screen.queryByText('Unstarred Tab')).not.toBeInTheDocument();
				// Closed starred session should also appear
				expect(screen.getByText('Starred Closed Session')).toBeInTheDocument();
				expect(screen.queryByText('Unstarred Closed Session')).not.toBeInTheDocument();
			});

			// Placeholder should indicate starred mode
			expect(screen.getByPlaceholderText('Search starred sessions...')).toBeInTheDocument();
		});

		it('shows "No starred sessions" when there are no starred items', async () => {
			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([]);

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[createTestTab({ name: 'Unstarred Tab', starred: false })]}
					activeTabId=""
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			fireEvent.click(screen.getByRole('button', { name: /Starred \(\d+\)/ }));

			await waitFor(() => {
				expect(screen.getByText('No starred sessions')).toBeInTheDocument();
			});
		});

		it('shows correct count for Starred pill', async () => {
			const starredTab1 = createTestTab({ name: 'Starred 1', starred: true });
			const starredTab2 = createTestTab({ name: 'Starred 2', starred: true });
			const unstarredTab = createTestTab({ name: 'Unstarred', starred: false });

			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([
				{
					agentId: 'claude-code',
					agentSessionId: 'starred-closed-abc',
					projectPath: '/test',
					sessionName: 'Starred Closed',
					starred: true,
				},
			]);

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[starredTab1, starredTab2, unstarredTab]}
					activeTabId={starredTab1.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			// Should show count of 3: 2 open starred + 1 closed starred
			expect(screen.getByText(/Starred \(3\)/)).toBeInTheDocument();
		});

		it('cycles through all three modes with Tab key', async () => {
			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[createTestTab({ name: 'Test Tab' })]}
					activeTabId=""
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Tab 1: open -> all-named
			fireEvent.keyDown(input, { key: 'Tab' });
			expect(screen.getByPlaceholderText('Search named sessions...')).toBeInTheDocument();

			// Tab 2: all-named -> starred
			fireEvent.keyDown(input, { key: 'Tab' });
			expect(screen.getByPlaceholderText('Search starred sessions...')).toBeInTheDocument();

			// Tab 3: starred -> open
			fireEvent.keyDown(input, { key: 'Tab' });
			expect(screen.getByPlaceholderText('Search open tabs...')).toBeInTheDocument();
		});
	});

	describe('search functionality', () => {
		it('filters tabs by name', () => {
			const tabs = [
				createTestTab({ name: 'Alpha Session' }),
				createTestTab({ name: 'Beta Session' }),
				createTestTab({ name: 'Gamma Session' }),
			];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.change(input, { target: { value: 'beta' } });

			expect(screen.getByText('Beta Session')).toBeInTheDocument();
			expect(screen.queryByText('Alpha Session')).not.toBeInTheDocument();
			expect(screen.queryByText('Gamma Session')).not.toBeInTheDocument();
		});

		it('filters by claude session ID', () => {
			const tabs = [
				createTestTab({
					name: '',
					agentSessionId: 'abc12345-1234-5678-9abc-123456789abc',
				}),
				createTestTab({
					name: '',
					agentSessionId: 'xyz98765-1234-5678-9abc-123456789abc',
				}),
			];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.change(input, { target: { value: 'xyz' } });

			expect(screen.getByText('XYZ98765')).toBeInTheDocument();
			expect(screen.queryByText('ABC12345')).not.toBeInTheDocument();
		});

		it('shows empty state when no matches', () => {
			const tabs = [createTestTab({ name: 'My Tab' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.change(input, { target: { value: 'nonexistent' } });

			expect(screen.getByText('No open tabs')).toBeInTheDocument();
		});

		it('resets selection when search changes', () => {
			const tabs = [createTestTab({ name: 'AlphaItem' }), createTestTab({ name: 'BetaItem' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Navigate down
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			// Search should reset selection to 0
			fireEvent.change(input, { target: { value: 'alpha' } });

			// First matching item should be selected (has accent bg)
			const buttons = screen.getAllByRole('button');
			const alphaButton = buttons.find((b) => b.textContent?.includes('AlphaItem'));
			expect(alphaButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('uses fuzzy matching with scoring', () => {
			const tabs = [
				createTestTab({ name: 'Authentication Service' }),
				createTestTab({ name: 'User Auth Module' }),
				createTestTab({ name: 'API Gateway' }),
			];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.change(input, { target: { value: 'auth' } });

			// Both auth-related tabs should match
			expect(screen.getByText('Authentication Service')).toBeInTheDocument();
			expect(screen.getByText('User Auth Module')).toBeInTheDocument();
			expect(screen.queryByText('API Gateway')).not.toBeInTheDocument();
		});
	});

	describe('keyboard navigation', () => {
		it('navigates down with ArrowDown', () => {
			const tabs = [createTestTab({ name: 'FirstItem' }), createTestTab({ name: 'SecondItem' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Navigate down once
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			// Second item should now be selected (highlighted)
			const buttons = screen.getAllByRole('button');
			const secondButton = buttons.find((b) => b.textContent?.includes('SecondItem'));
			expect(secondButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('navigates up with ArrowUp', () => {
			const tabs = [createTestTab({ name: 'FirstItem' }), createTestTab({ name: 'SecondItem' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Navigate down then up
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'ArrowUp' });

			// First item should be selected again
			const buttons = screen.getAllByRole('button');
			const firstButton = buttons.find((b) => b.textContent?.includes('FirstItem'));
			expect(firstButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('clamps selection at boundaries', () => {
			const tabs = [createTestTab({ name: 'FirstItem' }), createTestTab({ name: 'SecondItem' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Try to go up from first item
			fireEvent.keyDown(input, { key: 'ArrowUp' });
			fireEvent.keyDown(input, { key: 'ArrowUp' });

			// Should still be on first item
			const buttons = screen.getAllByRole('button');
			const firstButton = buttons.find((b) => b.textContent?.includes('FirstItem'));
			expect(firstButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('selects item with Enter key', () => {
			const tabs = [createTestTab({ name: 'My Tab' })];
			const onTabSelect = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={onTabSelect}
					onNamedSessionSelect={vi.fn()}
					onClose={onClose}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onTabSelect).toHaveBeenCalledWith(tabs[0].id);
			expect(onClose).toHaveBeenCalled();
		});

		it('stops propagation on Enter', () => {
			const tabs = [createTestTab({ name: 'My Tab' })];
			const parentHandler = vi.fn();

			render(
				<div onKeyDown={parentHandler}>
					<LayerStackProvider>
						<TabSwitcherModal
							theme={theme}
							tabs={tabs}
							activeTabId={tabs[0].id}
							projectRoot="/test"
							onTabSelect={vi.fn()}
							onNamedSessionSelect={vi.fn()}
							onClose={vi.fn()}
						/>
					</LayerStackProvider>
				</div>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(parentHandler).not.toHaveBeenCalled();
		});
	});

	describe('hotkey selection (Cmd+1-9, Cmd+0)', () => {
		it('selects first item with Cmd+1', () => {
			const tabs = [createTestTab({ name: 'FirstItem' }), createTestTab({ name: 'SecondItem' })];
			const onTabSelect = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={onTabSelect}
					onNamedSessionSelect={vi.fn()}
					onClose={onClose}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.keyDown(input, { key: '1', metaKey: true });

			// First tab alphabetically is "FirstItem"
			expect(onTabSelect).toHaveBeenCalledWith(tabs[0].id);
			expect(onClose).toHaveBeenCalled();
		});

		it('selects second item with Cmd+2', () => {
			const tabs = [
				createTestTab({ name: 'AlphaItem' }),
				createTestTab({ name: 'BetaItem' }),
				createTestTab({ name: 'GammaItem' }),
			];
			const onTabSelect = vi.fn();

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={onTabSelect}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.keyDown(input, { key: '2', metaKey: true });

			// Second tab alphabetically is "BetaItem"
			const betaTab = tabs.find((t) => t.name === 'BetaItem');
			expect(onTabSelect).toHaveBeenCalledWith(betaTab!.id);
		});

		it('selects tenth item with Cmd+0', () => {
			// Create 12 tabs
			const tabs = Array.from({ length: 12 }, (_, i) =>
				createTestTab({ name: `Tab ${String(i + 1).padStart(2, '0')}` })
			);
			const onTabSelect = vi.fn();

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={onTabSelect}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.keyDown(input, { key: '0', metaKey: true });

			// Should select "Tab 10" (10th alphabetically)
			const tab10 = tabs.find((t) => t.name === 'Tab 10');
			expect(onTabSelect).toHaveBeenCalledWith(tab10!.id);
		});

		it('renders number badges for first 10 visible items', () => {
			const tabs = Array.from({ length: 5 }, (_, i) => createTestTab({ name: `Tab ${i + 1}` }));

			const { container } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should show badges 1-5
			for (let i = 1; i <= 5; i++) {
				// Find divs with the number badge styling
				const badges = container.querySelectorAll('.w-5.h-5.rounded');
				const badge = Array.from(badges).find((b) => b.textContent === String(i));
				expect(badge).toBeInTheDocument();
			}
		});
	});

	describe('item selection', () => {
		it('calls onTabSelect when clicking an open tab', () => {
			const tabs = [createTestTab({ name: 'My Tab' })];
			const onTabSelect = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={onTabSelect}
					onNamedSessionSelect={vi.fn()}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByText('My Tab'));

			expect(onTabSelect).toHaveBeenCalledWith(tabs[0].id);
			expect(onClose).toHaveBeenCalled();
		});

		it('calls onNamedSessionSelect when clicking a closed named session', async () => {
			vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([
				{
					agentId: 'claude-code',
					agentSessionId: 'closed-abc-123',
					projectPath: '/test',
					sessionName: 'Closed Session',
					starred: true,
				},
			]);

			const onNamedSessionSelect = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[]}
					activeTabId=""
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={onNamedSessionSelect}
					onClose={onClose}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
			});

			fireEvent.click(screen.getByText(/All Named/));

			await waitFor(() => {
				expect(screen.getByText('Closed Session')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Closed Session'));

			expect(onNamedSessionSelect).toHaveBeenCalledWith(
				'closed-abc-123',
				'/test',
				'Closed Session',
				true
			);
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('named session sync', () => {
		it('syncs named open tabs on mount', async () => {
			const tabs = [
				createTestTab({ name: 'Named Tab', agentSessionId: 'session-123' }),
				createTestTab({ name: '', agentSessionId: 'unnamed-session' }),
			];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test/project"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			await waitFor(() => {
				// Should sync only the named tab
				// For claude-code sessions (default), it uses window.maestro.claude.updateSessionName
				expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
					'/test/project',
					'session-123',
					'Named Tab'
				);
			});

			// Should NOT sync the unnamed tab (only 1 call total)
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledTimes(1);
		});

		it('handles sync errors gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// For claude-code sessions (default), it uses window.maestro.claude.updateSessionName
			vi.mocked(window.maestro.claude.updateSessionName).mockRejectedValue(
				new Error('Sync failed')
			);

			const tabs = [createTestTab({ name: 'Tab', agentSessionId: 'abc' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					'[TabSwitcher] Failed to sync tab name:',
					expect.any(Error)
				);
			});

			consoleSpy.mockRestore();
		});
	});

	describe('focus management', () => {
		it('focuses input on mount after delay', async () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Wait for focus delay
			await waitFor(
				() => {
					const input = screen.getByPlaceholderText('Search open tabs...');
					expect(document.activeElement).toBe(input);
				},
				{ timeout: 200 }
			);
		});
	});

	describe('layer stack integration', () => {
		it('registers layer on mount', () => {
			const tabs = [createTestTab()];

			const { unmount } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should render without errors
			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Cleanup should work without errors
			unmount();
		});

		it('updates handler when onClose changes', async () => {
			const tabs = [createTestTab()];
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();

			const { rerender } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={onClose1}
				/>
			);

			rerender(
				<LayerStackProvider>
					<TabSwitcherModal
						theme={theme}
						tabs={tabs}
						activeTabId={tabs[0].id}
						projectRoot="/test"
						onTabSelect={vi.fn()}
						onNamedSessionSelect={vi.fn()}
						onClose={onClose2}
					/>
				</LayerStackProvider>
			);

			// Should still be visible
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('scroll behavior', () => {
		it('scrolls selected item into view', () => {
			const tabs = Array.from({ length: 20 }, (_, i) => createTestTab({ name: `Tab ${i + 1}` }));

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Clear previous calls (initial render may call scrollIntoView)
			vi.mocked(Element.prototype.scrollIntoView).mockClear();

			// Navigate down
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
				block: 'nearest',
				behavior: 'smooth',
			});
		});
	});

	describe('theme styling', () => {
		it('applies accent color to selected item', () => {
			const tabs = [createTestTab({ name: 'MyTestTab' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Find the button that contains the tab name (first item is selected by default)
			const buttons = screen.getAllByRole('button');
			const tabButton = buttons.find((b) => b.textContent?.includes('MyTestTab'));
			expect(tabButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('applies theme colors to modal container', () => {
			const tabs = [createTestTab()];

			const { container } = renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const modalContent = container.querySelector('.w-\\[600px\\]');
			expect(modalContent).toHaveStyle({
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			});
		});

		it('renders with light theme', () => {
			const lightTheme = createTestTheme({
				bgActivity: '#ffffff',
				textMain: '#333333',
				accent: '#0066cc',
			});

			const tabs = [createTestTab({ name: 'Tab' })];

			const { container } = renderWithLayerStack(
				<TabSwitcherModal
					theme={lightTheme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const modalContent = container.querySelector('.w-\\[600px\\]');
			expect(modalContent).toHaveStyle({ backgroundColor: lightTheme.colors.bgActivity });
		});
	});

	describe('edge cases', () => {
		it('handles tab with no usageStats', () => {
			const tab = createTestTab({ usageStats: undefined });

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should not show tokens or cost
			expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
			expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
		});

		it('handles tab with no logs', () => {
			const tab = createTestTab({ logs: [] });

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should not show "ago" text
			expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
		});

		it('handles special characters in tab names', () => {
			const tab = createTestTab({ name: '<script>alert("XSS")</script>' });

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should escape the HTML
			expect(screen.getByText('<script>alert("XSS")</script>')).toBeInTheDocument();
		});

		it('handles unicode tab names', () => {
			const tab = createTestTab({ name: '日本語タブ 🎉' });

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={[tab]}
					activeTabId={tab.id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('日本語タブ 🎉')).toBeInTheDocument();
		});

		it('handles rapid mode switching', () => {
			const tabs = [createTestTab({ name: 'TestTab' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');

			// Rapid Tab key presses - cycles through 3 modes: open -> all-named -> starred -> open
			// 9 presses = 9 mod 3 = 0, so we end up back at open tabs
			for (let i = 0; i < 9; i++) {
				fireEvent.keyDown(input, { key: 'Tab' });
			}

			// Should be back to open tabs (multiple of 3 switches)
			expect(screen.getByPlaceholderText('Search open tabs...')).toBeInTheDocument();
		});

		it('handles empty search with whitespace', () => {
			const tabs = [createTestTab({ name: 'Tab 1' }), createTestTab({ name: 'Tab 2' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const input = screen.getByPlaceholderText('Search open tabs...');
			fireEvent.change(input, { target: { value: '   ' } });

			// Whitespace-only search should show all tabs
			expect(screen.getByText('Tab 1')).toBeInTheDocument();
			expect(screen.getByText('Tab 2')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has tabIndex on dialog for focus', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});

		it('has outline-none on dialog', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('outline-none');
		});

		it('uses semantic button elements for tabs', () => {
			const tabs = [createTestTab({ name: 'TabOne' }), createTestTab({ name: 'TabTwo' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const tabButtons = screen
				.getAllByRole('button')
				.filter((b) => b.textContent?.includes('TabOne') || b.textContent?.includes('TabTwo'));
			expect(tabButtons.length).toBe(2);
		});
	});

	describe('footer display', () => {
		it('shows count for tabs', () => {
			const tabs = [createTestTab()];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('1 tabs')).toBeInTheDocument();
		});

		it('shows "sessions" in All Named mode', () => {
			const tabs = [createTestTab({ name: 'TestTab', agentSessionId: 'test-session-123' })];

			renderWithLayerStack(
				<TabSwitcherModal
					theme={theme}
					tabs={tabs}
					activeTabId={tabs[0].id}
					projectRoot="/test"
					onTabSelect={vi.fn()}
					onNamedSessionSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByText(/All Named/));

			// In All Named mode, footer shows "sessions"
			expect(screen.getByText('1 sessions')).toBeInTheDocument();
		});
	});
});
