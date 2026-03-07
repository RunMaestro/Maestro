/**
 * Tests for ThinkingStatusPill component
 *
 * Tests cover:
 * - Pure helper functions (getItemDisplayName, formatTokens)
 * - ElapsedTimeDisplay component (timer, formatTime)
 * - ThinkingItemRow component (click handling, display name, tokens, time)
 * - AutoRunPill component (stop button, task progress, elapsed time, stopping state)
 * - ThinkingStatusPillInner main logic (AutoRun mode, filtering, null return, primary item,
 *   multiple items dropdown, token display, elapsed time, interrupt button)
 * - Memoization (custom arePropsEqual comparison)
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThinkingStatusPill } from '../../../renderer/components/ThinkingStatusPill';
import type { Session, Theme, BatchRunState, AITab, ThinkingItem } from '../../../renderer/types';

// Mock theme for tests
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#007acc',
		border: '#404040',
		error: '#f44747',
		warning: '#cca700',
		success: '#4ec9b0',
		textOnAccent: '#ffffff',
		selectionBg: '#264f78',
		buttonHover: '#2d2d2d',
	},
};

// Helper to create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		cwd: '/test/path',
		projectRoot: '/test/path',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	};
}

// Helper to create a mock AITab
function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		name: 'Tab 1',
		state: 'idle',
		agentSessionId: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		...overrides,
	};
}

// Helper to create a busy/thinking session
function createThinkingSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		state: 'busy',
		busySource: 'ai',
		thinkingStartTime: Date.now() - 30000, // 30 seconds ago
		currentCycleTokens: 1500,
		agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
		...overrides,
	});
}

// Helper to create a ThinkingItem from a session (with optional tab)
function createThinkingItem(
	sessionOverrides: Partial<Session> = {},
	tab?: AITab | null
): ThinkingItem {
	const session = createThinkingSession(sessionOverrides);
	return { session, tab: tab ?? null };
}

// Helper to create a ThinkingItem with a busy tab
function createThinkingItemWithTab(
	sessionOverrides: Partial<Session> = {},
	tabOverrides: Partial<AITab> = {}
): ThinkingItem {
	const tab = createMockAITab({ state: 'busy', ...tabOverrides });
	const session = createThinkingSession({ aiTabs: [tab], ...sessionOverrides });
	return { session, tab };
}

describe('ThinkingStatusPill', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('render conditions', () => {
		it('renders null when no thinking items are provided', () => {
			const { container } = render(<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders thinking pill when thinking items are provided', () => {
			const item = createThinkingItem();
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			// Should show the session name
			const sessionNameElements = screen.getAllByText('Test Session');
			expect(sessionNameElements.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('formatTokens helper (via UI)', () => {
		it('displays tokens under 1000 as-is', () => {
			const item = createThinkingItem({ currentCycleTokens: 500 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('500')).toBeInTheDocument();
		});

		it('displays tokens at exactly 1000 in K notation', () => {
			const item = createThinkingItem({ currentCycleTokens: 1000 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('1.0K')).toBeInTheDocument();
		});

		it('displays tokens over 1000 in K notation with decimal', () => {
			const item = createThinkingItem({ currentCycleTokens: 2500 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('2.5K')).toBeInTheDocument();
		});

		it('displays large tokens correctly', () => {
			const item = createThinkingItem({ currentCycleTokens: 15700 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('15.7K')).toBeInTheDocument();
		});

		it('shows "Thinking..." when tokens are 0', () => {
			const item = createThinkingItem({ currentCycleTokens: 0 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('Thinking...')).toBeInTheDocument();
		});
	});

	describe('ElapsedTimeDisplay component', () => {
		it('displays seconds and minutes', () => {
			const startTime = Date.now() - 75000; // 1m 15s ago
			const item = createThinkingItem({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('1m 15s')).toBeInTheDocument();
		});

		it('displays hours when appropriate', () => {
			const startTime = Date.now() - 3725000; // 1h 2m 5s ago
			const item = createThinkingItem({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('1h 2m 5s')).toBeInTheDocument();
		});

		it('displays days when appropriate', () => {
			const startTime = Date.now() - 90061000; // 1d 1h 1m 1s ago
			const item = createThinkingItem({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('1d 1h 1m 1s')).toBeInTheDocument();
		});

		it('updates time every second', () => {
			const startTime = Date.now();
			const item = createThinkingItem({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);

			expect(screen.getByText('0m 0s')).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText('0m 3s')).toBeInTheDocument();
		});

		it('cleans up interval on unmount', () => {
			const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
			const item = createThinkingItem();

			const { unmount } = render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);

			unmount();
			expect(clearIntervalSpy).toHaveBeenCalled();
			clearIntervalSpy.mockRestore();
		});
	});

	describe('getItemDisplayName (via UI)', () => {
		it('uses namedSessions lookup when available', () => {
			const item = createThinkingItem({ agentSessionId: 'abc12345-def6' });
			render(
				<ThinkingStatusPill
					thinkingItems={[item]}
					theme={mockTheme}
					namedSessions={{ 'abc12345-def6': 'Custom Name' }}
				/>
			);
			expect(screen.getByText('Custom Name')).toBeInTheDocument();
		});

		it('falls back to tab name when no namedSession', () => {
			const item = createThinkingItemWithTab(
				{ agentSessionId: undefined },
				{ name: 'My Tab Name', agentSessionId: 'def67890-ghi' }
			);
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('My Tab Name')).toBeInTheDocument();
		});

		it('falls back to session name when no tab name', () => {
			const item = createThinkingItemWithTab(
				{ name: 'My Session', agentSessionId: undefined },
				{ name: '', agentSessionId: 'xyz98765-abc' }
			);
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			// Claude ID button should show session name when tab name is empty
			const buttons = screen.getAllByText('My Session');
			expect(buttons.length).toBeGreaterThanOrEqual(1);
		});

		it('uses session name when no tab is provided', () => {
			const item = createThinkingItem({
				name: 'Session Name',
				agentSessionId: 'sess1234-5678',
				aiTabs: undefined,
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const buttons = screen.getAllByText('Session Name');
			expect(buttons.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('primary item display', () => {
		it('shows session name', () => {
			const item = createThinkingItem({ name: 'Primary Session' });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const nameElements = screen.getAllByText('Primary Session');
			expect(nameElements.length).toBeGreaterThanOrEqual(1);
		});

		it('shows pulsing indicator dot', () => {
			const item = createThinkingItem();
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const indicator = document.querySelector('.animate-pulse');
			expect(indicator).toBeInTheDocument();
		});

		it('shows Tokens label', () => {
			const item = createThinkingItem({ currentCycleTokens: 100 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('Tokens:')).toBeInTheDocument();
		});

		it('shows Elapsed label with time', () => {
			const item = createThinkingItem();
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('Elapsed:')).toBeInTheDocument();
		});

		it('creates correct tooltip with all info', () => {
			const item = createThinkingItem({
				name: 'Test Name',
				agentSessionId: 'abc12345',
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const nameElements = screen.getAllByText('Test Name');
			const elementWithTooltip = nameElements.find((el) => el.getAttribute('title'));
			expect(elementWithTooltip).toHaveAttribute('title', expect.stringContaining('Test Name'));
			expect(elementWithTooltip).toHaveAttribute(
				'title',
				expect.stringContaining('Claude: abc12345')
			);
		});
	});

	describe('Claude session ID click handler', () => {
		it('calls onSessionClick when Claude ID button is clicked', () => {
			const onSessionClick = vi.fn();
			const item = createThinkingItem({
				id: 'session-123',
				name: 'Click Test Session',
				agentSessionId: 'claude-456',
			});
			render(
				<ThinkingStatusPill
					thinkingItems={[item]}
					theme={mockTheme}
					onSessionClick={onSessionClick}
				/>
			);

			// agentSessionId: 'claude-456' -> displayClaudeId: 'CLAUDE-4'
			const claudeIdButton = screen.getByText('CLAUDE-4');
			expect(claudeIdButton.tagName).toBe('BUTTON');
			fireEvent.click(claudeIdButton);

			// tab is null for legacy items
			expect(onSessionClick).toHaveBeenCalledWith('session-123', undefined);
		});

		it('passes tabId when tab is available', () => {
			const onSessionClick = vi.fn();
			const item = createThinkingItemWithTab(
				{ id: 'session-abc', name: 'Tab Test Session', agentSessionId: undefined },
				{ id: 'tab-999', name: 'Active Tab', agentSessionId: 'tab-claude-id' }
			);
			render(
				<ThinkingStatusPill
					thinkingItems={[item]}
					theme={mockTheme}
					onSessionClick={onSessionClick}
				/>
			);

			const claudeIdButton = screen.getByText('Active Tab');
			fireEvent.click(claudeIdButton);

			expect(onSessionClick).toHaveBeenCalledWith('session-abc', 'tab-999');
		});
	});

	describe('interrupt button', () => {
		it('renders stop button when onInterrupt is provided', () => {
			const item = createThinkingItem();
			render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} onInterrupt={() => {}} />
			);
			expect(screen.getByText('Stop')).toBeInTheDocument();
		});

		it('does not render stop button when onInterrupt is not provided', () => {
			const item = createThinkingItem();
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.queryByText('Stop')).not.toBeInTheDocument();
		});

		it('calls onInterrupt when stop button is clicked', () => {
			const onInterrupt = vi.fn();
			const item = createThinkingItem();
			render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} onInterrupt={onInterrupt} />
			);

			fireEvent.click(screen.getByText('Stop'));
			expect(onInterrupt).toHaveBeenCalledTimes(1);
		});

		it('has correct title attribute', () => {
			const item = createThinkingItem();
			render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} onInterrupt={() => {}} />
			);
			expect(screen.getByTitle('Interrupt Claude (Ctrl+C)')).toBeInTheDocument();
		});
	});

	describe('multiple thinking items', () => {
		it('shows +N indicator when multiple items are thinking', () => {
			const items = [
				createThinkingItem({ id: 'sess-1', name: 'Session 1' }),
				createThinkingItem({ id: 'sess-2', name: 'Session 2' }),
				createThinkingItem({ id: 'sess-3', name: 'Session 3' }),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);
			expect(screen.getByText('+2')).toBeInTheDocument();
		});

		it('has correct tooltip on +N indicator', () => {
			const items = [createThinkingItem({ id: 'sess-1' }), createThinkingItem({ id: 'sess-2' })];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);
			expect(screen.getByTitle('+1 more thinking')).toBeInTheDocument();
		});

		it('expands dropdown on mouse enter', () => {
			const items = [
				createThinkingItem({ id: 'sess-1', name: 'Primary' }),
				createThinkingItem({ id: 'sess-2', name: 'Secondary' }),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();
		});

		it('closes dropdown on mouse leave', () => {
			const items = [
				createThinkingItem({ id: 'sess-1', name: 'Primary' }),
				createThinkingItem({ id: 'sess-2', name: 'Secondary' }),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);
			expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();

			fireEvent.mouseLeave(indicator);
			expect(screen.queryByText('All Thinking Sessions')).not.toBeInTheDocument();
		});

		it('shows all thinking items in dropdown', () => {
			const items = [
				createThinkingItem({ id: 'sess-1', name: 'Session Alpha' }),
				createThinkingItem({ id: 'sess-2', name: 'Session Beta' }),
				createThinkingItem({ id: 'sess-3', name: 'Session Gamma' }),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);

			const indicator = screen.getByText('+2').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();
			// Session Alpha appears twice - once in primary pill, once in dropdown
			expect(screen.getAllByText('Session Alpha').length).toBeGreaterThanOrEqual(2);
			expect(screen.getByText('Session Beta')).toBeInTheDocument();
			expect(screen.getByText('Session Gamma')).toBeInTheDocument();
		});

		it('shows multiple tabs from same session as separate items', () => {
			const session = createThinkingSession({ id: 'sess-1', name: 'Agent A' });
			const tab1 = createMockAITab({ id: 'tab-1', name: 'Write', state: 'busy' });
			const tab2 = createMockAITab({ id: 'tab-2', name: 'Read', state: 'busy' });
			const items: ThinkingItem[] = [
				{ session, tab: tab1 },
				{ session, tab: tab2 },
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);

			// Should show +1 indicator for the second tab
			expect(screen.getByText('+1')).toBeInTheDocument();

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			// 'Write' appears in both primary pill and dropdown row
			expect(screen.getAllByText('Write').length).toBeGreaterThanOrEqual(2);
			expect(screen.getByText('Read')).toBeInTheDocument();
			// Agent name appears multiple times (pill + 2 dropdown rows)
			expect(screen.getAllByText('Agent A').length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('ThinkingItemRow component (via dropdown)', () => {
		it('calls onSessionClick with session ID and tab ID when clicked', () => {
			const onSessionClick = vi.fn();
			const tab = createMockAITab({ id: 'tab-xyz', state: 'busy' });
			const session = createThinkingSession({ id: 'sess-1', name: 'Session 1', aiTabs: [tab] });
			const items: ThinkingItem[] = [
				{ session, tab },
				createThinkingItem({ id: 'sess-2', name: 'Session 2' }),
			];
			render(
				<ThinkingStatusPill
					thinkingItems={items}
					theme={mockTheme}
					onSessionClick={onSessionClick}
				/>
			);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			// Click on the first session row in dropdown
			const rows = screen.getAllByRole('button');
			const sessionRow = rows.find((row) => row.textContent?.includes('Session 1'));
			expect(sessionRow).toBeDefined();
			fireEvent.click(sessionRow!);

			expect(onSessionClick).toHaveBeenCalledWith('sess-1', 'tab-xyz');
		});

		it('shows tokens when available in item row', () => {
			const items = [
				createThinkingItem({ id: 'sess-1', name: 'Primary' }),
				createThinkingItem({ id: 'sess-2', name: 'Secondary', currentCycleTokens: 5000 }),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('5.0K')).toBeInTheDocument();
		});

		it('shows elapsed time in item row', () => {
			const items = [
				createThinkingItem({ id: 'sess-1', name: 'Primary' }),
				createThinkingItem({
					id: 'sess-2',
					name: 'Secondary',
					thinkingStartTime: Date.now() - 120000, // 2 minutes
				}),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('2m 0s')).toBeInTheDocument();
		});
	});

	describe('AutoRun mode', () => {
		it('shows AutoRunPill when autoRunState.isRunning is true', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 2,
				startTime: Date.now() - 60000,
				tasks: [],
				batchName: 'Test Batch',
			};
			render(
				<ThinkingStatusPill
					thinkingItems={[createThinkingItem()]}
					theme={mockTheme}
					autoRunState={autoRunState}
				/>
			);
			expect(screen.getByText('AutoRun')).toBeInTheDocument();
		});

		it('shows task progress in AutoRunPill', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 2,
				totalTasks: 10,
				completedTasks: 3,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} autoRunState={autoRunState} />
			);
			expect(screen.getByText('Tasks:')).toBeInTheDocument();
			expect(screen.getByText('3/10')).toBeInTheDocument();
		});

		it('shows elapsed time in AutoRunPill', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now() - 45000,
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} autoRunState={autoRunState} />
			);
			expect(screen.getByText('Elapsed:')).toBeInTheDocument();
			expect(screen.getByText('0m 45s')).toBeInTheDocument();
		});

		it('shows stop button in AutoRunPill when onStopAutoRun is provided', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill
					thinkingItems={[]}
					theme={mockTheme}
					autoRunState={autoRunState}
					onStopAutoRun={() => {}}
				/>
			);
			expect(screen.getByText('Stop')).toBeInTheDocument();
		});

		it('calls onStopAutoRun when stop button is clicked', () => {
			const onStopAutoRun = vi.fn();
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill
					thinkingItems={[]}
					theme={mockTheme}
					autoRunState={autoRunState}
					onStopAutoRun={onStopAutoRun}
				/>
			);
			fireEvent.click(screen.getByText('Stop'));
			expect(onStopAutoRun).toHaveBeenCalledTimes(1);
		});

		it('shows AutoRun Stopping label and Stopping button when isStopping is true', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: true,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill
					thinkingItems={[]}
					theme={mockTheme}
					autoRunState={autoRunState}
					onStopAutoRun={() => {}}
				/>
			);
			expect(screen.getByText('AutoRun Stopping...')).toBeInTheDocument();
			expect(screen.getByText('Stopping')).toBeInTheDocument();
		});

		it('disables stop button when isStopping', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: true,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill
					thinkingItems={[]}
					theme={mockTheme}
					autoRunState={autoRunState}
					onStopAutoRun={() => {}}
				/>
			);
			const stopButton = screen.getByText('Stopping').closest('button');
			expect(stopButton).toBeDisabled();
		});

		it('uses Date.now() as fallback when startTime is undefined', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: undefined as unknown as number,
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} autoRunState={autoRunState} />
			);
			expect(screen.getByText('0m 0s')).toBeInTheDocument();
		});

		it('prioritizes AutoRun over thinking items', () => {
			const item = createThinkingItem({ name: 'Thinking Session' });
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} autoRunState={autoRunState} />
			);
			expect(screen.getByText('AutoRun')).toBeInTheDocument();
			expect(screen.queryByText('Thinking Session')).not.toBeInTheDocument();
		});
	});

	describe('tab-level display', () => {
		it('uses tab with busy state for display', () => {
			const item = createThinkingItemWithTab(
				{ agentSessionId: undefined },
				{ name: 'Busy Tab', agentSessionId: 'busy-claude-id' }
			);
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('Busy Tab')).toBeInTheDocument();
		});

		it('uses tab thinkingStartTime over session thinkingStartTime', () => {
			const tab = createMockAITab({
				state: 'busy',
				thinkingStartTime: Date.now() - 90000, // 1m 30s
			});
			const session = createThinkingSession({
				aiTabs: [tab],
				thinkingStartTime: Date.now() - 30000, // 30s
			});
			const item: ThinkingItem = { session, tab };
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			// Should show 1m 30s from tab, not 0m 30s from session
			expect(screen.getByText('1m 30s')).toBeInTheDocument();
		});
	});

	describe('styling', () => {
		it('applies warning color to pulsing indicator in thinking mode', () => {
			const item = createThinkingItem();
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const indicator = document.querySelector('.animate-pulse');
			expect(indicator).toHaveStyle({ backgroundColor: mockTheme.colors.warning });
		});

		it('applies accent color to pulsing indicator in AutoRun mode', () => {
			const autoRunState: BatchRunState = {
				isRunning: true,
				isPaused: false,
				isStopping: false,
				currentTaskIndex: 0,
				totalTasks: 5,
				completedTasks: 0,
				startTime: Date.now(),
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} autoRunState={autoRunState} />
			);
			const indicator = document.querySelector('.animate-pulse');
			expect(indicator).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('applies error color to stop button', () => {
			const item = createThinkingItem();
			render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} onInterrupt={() => {}} />
			);
			const stopButton = screen.getByText('Stop').closest('button');
			expect(stopButton).toHaveStyle({ backgroundColor: mockTheme.colors.error });
		});

		it('applies accent color to Claude ID button', () => {
			const item = createThinkingItem({
				name: 'Accent Test',
				agentSessionId: 'test-id-1234',
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const claudeButton = screen.getByText('TEST-ID-');
			expect(claudeButton.tagName).toBe('BUTTON');
			expect(claudeButton).toHaveStyle({ color: mockTheme.colors.accent });
		});
	});

	describe('memoization (arePropsEqual)', () => {
		it('re-renders when autoRunState.isRunning changes', () => {
			const { rerender } = render(
				<ThinkingStatusPill
					thinkingItems={[]}
					theme={mockTheme}
					autoRunState={{ isRunning: false } as BatchRunState}
				/>
			);

			expect(screen.queryByText('AutoRun')).not.toBeInTheDocument();

			rerender(
				<ThinkingStatusPill
					thinkingItems={[]}
					theme={mockTheme}
					autoRunState={
						{
							isRunning: true,
							completedTasks: 0,
							totalTasks: 5,
							startTime: Date.now(),
						} as BatchRunState
					}
				/>
			);

			expect(screen.getByText('AutoRun')).toBeInTheDocument();
		});

		it('re-renders when thinking item count changes', () => {
			const item1 = createThinkingItem({ id: 'sess-1', name: 'Session 1' });
			const item2 = createThinkingItem({ id: 'sess-2', name: 'Session 2' });

			const { rerender } = render(<ThinkingStatusPill thinkingItems={[item1]} theme={mockTheme} />);

			expect(screen.queryByText('+1')).not.toBeInTheDocument();

			rerender(<ThinkingStatusPill thinkingItems={[item1, item2]} theme={mockTheme} />);

			expect(screen.getByText('+1')).toBeInTheDocument();
		});

		it('re-renders when item property changes', () => {
			const item = createThinkingItem({ currentCycleTokens: 500 });

			const { rerender } = render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);

			expect(screen.getByText('500')).toBeInTheDocument();

			const updatedItem: ThinkingItem = {
				session: { ...item.session, currentCycleTokens: 1500 },
				tab: item.tab,
			};

			rerender(<ThinkingStatusPill thinkingItems={[updatedItem]} theme={mockTheme} />);

			expect(screen.getByText('1.5K')).toBeInTheDocument();
		});

		it('re-renders when theme changes', () => {
			const item = createThinkingItem({ name: 'Theme Test' });
			const newTheme = {
				...mockTheme,
				colors: { ...mockTheme.colors, accent: '#ff0000' },
			};

			const { rerender } = render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);

			rerender(<ThinkingStatusPill thinkingItems={[item]} theme={newTheme} />);

			const claudeButton = screen.getByText('ABC12345');
			expect(claudeButton.tagName).toBe('BUTTON');
			expect(claudeButton).toHaveStyle({ color: '#ff0000' });
		});

		it('re-renders when namedSessions changes for thinking item', () => {
			const item = createThinkingItem({
				name: 'Named Test Session',
				agentSessionId: 'abc12345',
			});

			const { rerender } = render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} namedSessions={{}} />
			);

			const initialButtons = screen.getAllByText('Named Test Session');
			expect(initialButtons.length).toBeGreaterThanOrEqual(1);

			rerender(
				<ThinkingStatusPill
					thinkingItems={[item]}
					theme={mockTheme}
					namedSessions={{ abc12345: 'Custom Name' }}
				/>
			);

			expect(screen.getByText('Custom Name')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles item with no agentSessionId', () => {
			const item = createThinkingItem({
				name: 'No Claude ID Session',
				agentSessionId: undefined,
				aiTabs: undefined,
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const elements = screen.getAllByText('No Claude ID Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles item with no thinkingStartTime', () => {
			const item = createThinkingItem({
				name: 'No Time Session',
				thinkingStartTime: undefined,
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const elements = screen.getAllByText('No Time Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText('Elapsed:')).not.toBeInTheDocument();
		});

		it('handles special characters in session names', () => {
			const item = createThinkingItem({
				name: '<script>alert("xss")</script>',
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const elements = screen.getAllByText('<script>alert("xss")</script>');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles unicode in session names', () => {
			const item = createThinkingItem({ name: '🎼 Maestro Session' });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const elements = screen.getAllByText('🎼 Maestro Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles very long session names', () => {
			const item = createThinkingItem({
				name: 'This is a very long session name that might cause layout issues',
			});
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const elements = screen.getAllByText(
				'This is a very long session name that might cause layout issues'
			);
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles large token counts', () => {
			const item = createThinkingItem({ currentCycleTokens: 999999 });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			expect(screen.getByText('1000.0K')).toBeInTheDocument();
		});

		it('handles item with null tab (legacy session)', () => {
			const item = createThinkingItem({ name: 'Legacy Session', aiTabs: [] });
			render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);
			const elements = screen.getAllByText('Legacy Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles multiple thinking items', () => {
			const items = [
				createThinkingItem({ id: 'busy-1', name: 'Busy 1' }),
				createThinkingItem({ id: 'busy-2', name: 'Busy 2' }),
			];
			render(<ThinkingStatusPill thinkingItems={items} theme={mockTheme} />);
			const busy1Elements = screen.getAllByText('Busy 1');
			expect(busy1Elements.length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('+1')).toBeInTheDocument();
		});

		it('handles rapid state changes', () => {
			const item = createThinkingItem();
			const { rerender } = render(<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />);

			for (let i = 0; i < 10; i++) {
				const updatedItem: ThinkingItem = {
					session: { ...item.session, currentCycleTokens: i * 100 },
					tab: item.tab,
				};
				rerender(<ThinkingStatusPill thinkingItems={[updatedItem]} theme={mockTheme} />);
			}

			expect(screen.getByText('900')).toBeInTheDocument();
		});
	});

	describe('component display names', () => {
		it('ThinkingStatusPill has correct displayName', () => {
			expect(ThinkingStatusPill.displayName).toBe('ThinkingStatusPill');
		});
	});

	describe('memo regression tests', () => {
		it('should re-render when theme changes', () => {
			const item = createThinkingItem();
			const { rerender, container } = render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} />
			);

			const pill = container.firstChild as HTMLElement;
			expect(pill).toBeTruthy();

			const newTheme = {
				...mockTheme,
				colors: {
					...mockTheme.colors,
					textMain: '#ff0000',
				},
			};

			rerender(<ThinkingStatusPill thinkingItems={[item]} theme={newTheme} />);
			expect(container.firstChild).toBeTruthy();
		});

		it('should re-render when autoRunState changes', () => {
			const { rerender } = render(<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} />);

			expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();

			const autoRunState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				totalTasks: 5,
				currentTaskIndex: 2,
				startTime: Date.now(),
				completedTasks: 3,
			};

			rerender(
				<ThinkingStatusPill thinkingItems={[]} theme={mockTheme} autoRunState={autoRunState} />
			);

			expect(screen.getByText('3/5')).toBeInTheDocument();
		});

		it('should re-render when namedSessions mapping changes', () => {
			const item = createThinkingItem({ agentSessionId: 'claude-abc123' });

			const { rerender } = render(
				<ThinkingStatusPill thinkingItems={[item]} theme={mockTheme} namedSessions={{}} />
			);

			expect(screen.getAllByText('Test Session').length).toBeGreaterThan(0);

			rerender(
				<ThinkingStatusPill
					thinkingItems={[item]}
					theme={mockTheme}
					namedSessions={{ 'claude-abc123': 'Custom Named Session' }}
				/>
			);

			expect(screen.getAllByText('Custom Named Session').length).toBeGreaterThan(0);
		});
	});
});
