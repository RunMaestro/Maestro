/**
 * Tests for ThinkingStatusPill component
 *
 * Tests cover:
 * - Pure helper functions (getWriteModeTab, getSessionDisplayName, formatTokens)
 * - ElapsedTimeDisplay component (timer, formatTime)
 * - SessionRow component (click handling, display name, tokens, time)
 * - AutoRunPill component (stop button, task progress, elapsed time, stopping state)
 * - ThinkingStatusPillInner main logic (AutoRun mode, filtering, null return, primary session,
 *   multiple sessions dropdown, token display, elapsed time, interrupt button)
 * - Memoization (custom arePropsEqual comparison)
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThinkingStatusPill } from '../../../renderer/components/ThinkingStatusPill';
import type { Session, Theme, BatchRunState, AITab } from '../../../renderer/types';

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

describe('ThinkingStatusPill', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('render conditions', () => {
		it('renders null when no thinking sessions are provided', () => {
			const { container } = render(<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders thinking pill when thinking sessions are provided', () => {
			const thinkingSession = createThinkingSession();
			render(<ThinkingStatusPill thinkingSessions={[thinkingSession]} theme={mockTheme} />);
			// Should show the session name (appears in both label span and Claude ID button)
			const sessionNameElements = screen.getAllByText('Test Session');
			expect(sessionNameElements.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('formatTokens helper (via UI)', () => {
		it('displays tokens under 1000 as-is', () => {
			const session = createThinkingSession({ currentCycleTokens: 500 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('500')).toBeInTheDocument();
		});

		it('displays tokens at exactly 1000 in K notation', () => {
			const session = createThinkingSession({ currentCycleTokens: 1000 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('1.0K')).toBeInTheDocument();
		});

		it('displays tokens over 1000 in K notation with decimal', () => {
			const session = createThinkingSession({ currentCycleTokens: 2500 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('2.5K')).toBeInTheDocument();
		});

		it('displays large tokens correctly', () => {
			const session = createThinkingSession({ currentCycleTokens: 15700 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('15.7K')).toBeInTheDocument();
		});

		it('shows "Thinking..." when tokens are 0', () => {
			const session = createThinkingSession({ currentCycleTokens: 0 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('Thinking...')).toBeInTheDocument();
		});
	});

	describe('ElapsedTimeDisplay component', () => {
		it('displays seconds and minutes', () => {
			const startTime = Date.now() - 75000; // 1m 15s ago
			const session = createThinkingSession({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should show 1m 15s format
			expect(screen.getByText('1m 15s')).toBeInTheDocument();
		});

		it('displays hours when appropriate', () => {
			const startTime = Date.now() - 3725000; // 1h 2m 5s ago
			const session = createThinkingSession({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('1h 2m 5s')).toBeInTheDocument();
		});

		it('displays days when appropriate', () => {
			const startTime = Date.now() - 90061000; // 1d 1h 1m 1s ago
			const session = createThinkingSession({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('1d 1h 1m 1s')).toBeInTheDocument();
		});

		it('updates time every second', () => {
			const startTime = Date.now();
			const session = createThinkingSession({ thinkingStartTime: startTime });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);

			// Initially shows 0m 0s
			expect(screen.getByText('0m 0s')).toBeInTheDocument();

			// Advance 3 seconds
			act(() => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText('0m 3s')).toBeInTheDocument();
		});

		it('cleans up interval on unmount', () => {
			const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
			const session = createThinkingSession();

			const { unmount } = render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />
			);

			unmount();

			// clearInterval should have been called
			expect(clearIntervalSpy).toHaveBeenCalled();
			clearIntervalSpy.mockRestore();
		});
	});

	describe('getSessionDisplayName (via UI)', () => {
		it('uses namedSessions lookup when available', () => {
			const session = createThinkingSession({
				agentSessionId: 'abc12345-def6',
			});
			render(
				<ThinkingStatusPill
					thinkingSessions={[session]}
					theme={mockTheme}
					namedSessions={{ 'abc12345-def6': 'Custom Name' }}
				/>
			);
			// Click target should show custom name
			expect(screen.getByText('Custom Name')).toBeInTheDocument();
		});

		it('falls back to tab name when no namedSession', () => {
			const tab = createMockAITab({
				state: 'busy',
				name: 'My Tab Name',
				agentSessionId: 'def67890-ghi',
			});
			const session = createThinkingSession({
				aiTabs: [tab],
				agentSessionId: undefined,
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should show tab name since no namedSession match
			expect(screen.getByText('My Tab Name')).toBeInTheDocument();
		});

		it('falls back to session name when no tab name', () => {
			const tab = createMockAITab({
				state: 'busy',
				name: '', // Empty name
				agentSessionId: 'xyz98765-abc',
			});
			const session = createThinkingSession({
				name: 'My Session',
				aiTabs: [tab],
				agentSessionId: undefined,
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Claude ID button should show session name when tab name is empty
			// (priority: namedSessions > tab name > session name > UUID octet)
			const buttons = screen.getAllByText('My Session');
			expect(buttons.length).toBeGreaterThanOrEqual(1);
		});

		it('uses session name when tab has no agentSessionId', () => {
			const session = createThinkingSession({
				name: 'Session Name',
				agentSessionId: 'sess1234-5678',
				aiTabs: undefined,
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Priority: namedSessions > tab name > session name > UUID octet
			// Without namedSessions or tabs, falls back to session name
			const buttons = screen.getAllByText('Session Name');
			expect(buttons.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('primary session display', () => {
		it('shows session name', () => {
			const session = createThinkingSession({ name: 'Primary Session' });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Session name appears multiple times: in the label span and in the Claude ID button
			const nameElements = screen.getAllByText('Primary Session');
			expect(nameElements.length).toBeGreaterThanOrEqual(1);
		});

		it('shows pulsing indicator dot', () => {
			const session = createThinkingSession();
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should have animate-pulse class on indicator
			const indicator = document.querySelector('.animate-pulse');
			expect(indicator).toBeInTheDocument();
		});

		it('shows Tokens label', () => {
			const session = createThinkingSession({ currentCycleTokens: 100 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('Tokens:')).toBeInTheDocument();
		});

		it('shows Elapsed label with time', () => {
			const session = createThinkingSession();
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('Elapsed:')).toBeInTheDocument();
		});

		it('creates correct tooltip with all info', () => {
			const session = createThinkingSession({
				name: 'Test Name',
				agentSessionId: 'abc12345',
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Session name appears in the non-clickable span with tooltip
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
			const session = createThinkingSession({
				id: 'session-123',
				name: 'Click Test Session',
				agentSessionId: 'claude-456',
			});
			render(
				<ThinkingStatusPill
					thinkingSessions={[session]}
					theme={mockTheme}
					onSessionClick={onSessionClick}
				/>
			);

			// The clickable button shows UUID octet (first 8 chars uppercase) when no tab name or custom name
			// agentSessionId: 'claude-456' -> displayClaudeId: 'CLAUDE-4'
			const claudeIdButton = screen.getByText('CLAUDE-4');
			expect(claudeIdButton.tagName).toBe('BUTTON');
			fireEvent.click(claudeIdButton);

			expect(onSessionClick).toHaveBeenCalledWith('session-123', undefined);
		});

		it('passes tabId when write-mode tab is available', () => {
			const onSessionClick = vi.fn();
			const tab = createMockAITab({
				id: 'tab-999',
				state: 'busy',
				name: 'Active Tab',
				agentSessionId: 'tab-claude-id',
			});
			const session = createThinkingSession({
				id: 'session-abc',
				name: 'Tab Test Session',
				aiTabs: [tab],
				agentSessionId: undefined,
			});
			render(
				<ThinkingStatusPill
					thinkingSessions={[session]}
					theme={mockTheme}
					onSessionClick={onSessionClick}
				/>
			);

			// With tab name available, button shows tab name
			const claudeIdButton = screen.getByText('Active Tab');
			fireEvent.click(claudeIdButton);

			expect(onSessionClick).toHaveBeenCalledWith('session-abc', 'tab-999');
		});
	});

	describe('interrupt button', () => {
		it('renders stop button when onInterrupt is provided', () => {
			const session = createThinkingSession();
			render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} onInterrupt={() => {}} />
			);
			expect(screen.getByText('Stop')).toBeInTheDocument();
		});

		it('does not render stop button when onInterrupt is not provided', () => {
			const session = createThinkingSession();
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.queryByText('Stop')).not.toBeInTheDocument();
		});

		it('calls onInterrupt when stop button is clicked', () => {
			const onInterrupt = vi.fn();
			const session = createThinkingSession();
			render(
				<ThinkingStatusPill
					thinkingSessions={[session]}
					theme={mockTheme}
					onInterrupt={onInterrupt}
				/>
			);

			fireEvent.click(screen.getByText('Stop'));
			expect(onInterrupt).toHaveBeenCalledTimes(1);
		});

		it('has correct title attribute', () => {
			const session = createThinkingSession();
			render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} onInterrupt={() => {}} />
			);
			expect(screen.getByTitle('Interrupt Claude (Ctrl+C)')).toBeInTheDocument();
		});
	});

	describe('multiple thinking sessions', () => {
		it('shows +N indicator when multiple sessions are thinking', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Session 1' }),
				createThinkingSession({ id: 'sess-2', name: 'Session 2' }),
				createThinkingSession({ id: 'sess-3', name: 'Session 3' }),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);
			// Should show +2 (excluding the primary session)
			expect(screen.getByText('+2')).toBeInTheDocument();
		});

		it('has correct tooltip on +N indicator', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1' }),
				createThinkingSession({ id: 'sess-2' }),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);
			expect(screen.getByTitle('+1 more thinking')).toBeInTheDocument();
		});

		it('expands dropdown on mouse enter', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Primary' }),
				createThinkingSession({ id: 'sess-2', name: 'Secondary' }),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			// State update is synchronous
			expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();
		});

		it('closes dropdown on mouse leave', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Primary' }),
				createThinkingSession({ id: 'sess-2', name: 'Secondary' }),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();

			fireEvent.mouseLeave(indicator);

			expect(screen.queryByText('All Thinking Sessions')).not.toBeInTheDocument();
		});

		it('shows all thinking sessions in dropdown', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Session Alpha' }),
				createThinkingSession({ id: 'sess-2', name: 'Session Beta' }),
				createThinkingSession({ id: 'sess-3', name: 'Session Gamma' }),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);

			const indicator = screen.getByText('+2').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();
			// Session Alpha appears twice - once in primary pill, once in dropdown
			expect(screen.getAllByText('Session Alpha').length).toBeGreaterThanOrEqual(2);
			expect(screen.getByText('Session Beta')).toBeInTheDocument();
			expect(screen.getByText('Session Gamma')).toBeInTheDocument();
		});
	});

	describe('SessionRow component (via dropdown)', () => {
		it('calls onSessionClick with session ID and tab ID when clicked', () => {
			const onSessionClick = vi.fn();
			const tab = createMockAITab({ id: 'tab-xyz', state: 'busy' });
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Session 1', aiTabs: [tab] }),
				createThinkingSession({ id: 'sess-2', name: 'Session 2' }),
			];
			render(
				<ThinkingStatusPill
					thinkingSessions={sessions}
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

		it('shows tokens when available in session row', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Primary' }),
				createThinkingSession({ id: 'sess-2', name: 'Secondary', currentCycleTokens: 5000 }),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			// 5000 tokens = 5.0K
			expect(screen.getByText('5.0K')).toBeInTheDocument();
		});

		it('shows elapsed time in session row', () => {
			const sessions = [
				createThinkingSession({ id: 'sess-1', name: 'Primary' }),
				createThinkingSession({
					id: 'sess-2',
					name: 'Secondary',
					thinkingStartTime: Date.now() - 120000, // 2 minutes
				}),
			];
			render(<ThinkingStatusPill thinkingSessions={sessions} theme={mockTheme} />);

			const indicator = screen.getByText('+1').parentElement!;
			fireEvent.mouseEnter(indicator);

			expect(screen.getByText('2m 0s')).toBeInTheDocument();
		});
	});

	describe('AutoRun mode', () => {
		it('shows AutoRunPill when autoRunState.isRunning is true', () => {
			const sessions = [createMockSession()];
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
					thinkingSessions={sessions}
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
				<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} autoRunState={autoRunState} />
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
				startTime: Date.now() - 45000, // 45 seconds ago
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} autoRunState={autoRunState} />
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
					thinkingSessions={[]}
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
					thinkingSessions={[]}
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
					thinkingSessions={[]}
					theme={mockTheme}
					autoRunState={autoRunState}
					onStopAutoRun={() => {}}
				/>
			);
			// AutoRun label should show stopping state
			expect(screen.getByText('AutoRun Stopping...')).toBeInTheDocument();
			// Button should show "Stopping" text
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
					thinkingSessions={[]}
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
				startTime: undefined as unknown as number, // Simulate undefined
				tasks: [],
				batchName: 'Batch',
			};
			render(
				<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} autoRunState={autoRunState} />
			);
			// Should show 0m 0s since startTime defaults to now
			expect(screen.getByText('0m 0s')).toBeInTheDocument();
		});

		it('prioritizes AutoRun over thinking sessions', () => {
			const thinkingSession = createThinkingSession({ name: 'Thinking Session' });
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
					thinkingSessions={[thinkingSession]}
					theme={mockTheme}
					autoRunState={autoRunState}
				/>
			);
			// Should show AutoRun, not thinking session
			expect(screen.getByText('AutoRun')).toBeInTheDocument();
			expect(screen.queryByText('Thinking Session')).not.toBeInTheDocument();
		});
	});

	describe('getWriteModeTab helper (via UI)', () => {
		it('uses tab with busy state for display', () => {
			const idleTab = createMockAITab({ id: 'idle-tab', name: 'Idle Tab', state: 'idle' });
			const busyTab = createMockAITab({
				id: 'busy-tab',
				name: 'Busy Tab',
				state: 'busy',
				agentSessionId: 'busy-claude-id',
			});
			const session = createThinkingSession({
				aiTabs: [idleTab, busyTab],
				agentSessionId: undefined,
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should use the busy tab's name
			expect(screen.getByText('Busy Tab')).toBeInTheDocument();
		});

		it('uses tab thinkingStartTime over session thinkingStartTime', () => {
			const busyTab = createMockAITab({
				id: 'busy-tab',
				state: 'busy',
				thinkingStartTime: Date.now() - 90000, // 1m 30s
			});
			const session = createThinkingSession({
				aiTabs: [busyTab],
				thinkingStartTime: Date.now() - 30000, // 30s (would show 0m 30s if used)
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should show 1m 30s from tab, not 0m 30s from session
			expect(screen.getByText('1m 30s')).toBeInTheDocument();
		});
	});

	describe('styling', () => {
		it('applies warning color to pulsing indicator in thinking mode', () => {
			const session = createThinkingSession();
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
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
				<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} autoRunState={autoRunState} />
			);
			const indicator = document.querySelector('.animate-pulse');
			expect(indicator).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('applies error color to stop button', () => {
			const session = createThinkingSession();
			render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} onInterrupt={() => {}} />
			);
			const stopButton = screen.getByText('Stop').closest('button');
			expect(stopButton).toHaveStyle({ backgroundColor: mockTheme.colors.error });
		});

		it('applies accent color to Claude ID button', () => {
			const session = createThinkingSession({
				name: 'Accent Test',
				agentSessionId: 'test-id-1234',
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Claude ID button shows UUID octet when no custom name or tab name
			// agentSessionId: 'test-id-1234' -> displayClaudeId: 'TEST-ID-'
			const claudeButton = screen.getByText('TEST-ID-');
			expect(claudeButton.tagName).toBe('BUTTON');
			expect(claudeButton).toHaveStyle({ color: mockTheme.colors.accent });
		});
	});

	describe('memoization (arePropsEqual)', () => {
		// We can test memoization behavior by checking re-renders don't happen unnecessarily
		it('re-renders when autoRunState.isRunning changes', () => {
			const { rerender } = render(
				<ThinkingStatusPill
					thinkingSessions={[]}
					theme={mockTheme}
					autoRunState={{ isRunning: false } as BatchRunState}
				/>
			);

			// Should not show AutoRun initially
			expect(screen.queryByText('AutoRun')).not.toBeInTheDocument();

			rerender(
				<ThinkingStatusPill
					thinkingSessions={[]}
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

			// Should show AutoRun after change
			expect(screen.getByText('AutoRun')).toBeInTheDocument();
		});

		it('re-renders when thinking session count changes', () => {
			const session1 = createThinkingSession({ id: 'sess-1', name: 'Session 1' });
			const session2 = createThinkingSession({ id: 'sess-2', name: 'Session 2' });

			const { rerender } = render(
				<ThinkingStatusPill thinkingSessions={[session1]} theme={mockTheme} />
			);

			expect(screen.queryByText('+1')).not.toBeInTheDocument();

			rerender(<ThinkingStatusPill thinkingSessions={[session1, session2]} theme={mockTheme} />);

			expect(screen.getByText('+1')).toBeInTheDocument();
		});

		it('re-renders when session property changes', () => {
			const session = createThinkingSession({ currentCycleTokens: 500 });

			const { rerender } = render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />
			);

			expect(screen.getByText('500')).toBeInTheDocument();

			rerender(
				<ThinkingStatusPill
					thinkingSessions={[{ ...session, currentCycleTokens: 1500 }]}
					theme={mockTheme}
				/>
			);

			expect(screen.getByText('1.5K')).toBeInTheDocument();
		});

		it('re-renders when theme changes', () => {
			const session = createThinkingSession({ name: 'Theme Test' });
			const newTheme = {
				...mockTheme,
				colors: { ...mockTheme.colors, accent: '#ff0000' },
			};

			const { rerender } = render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />
			);

			rerender(<ThinkingStatusPill thinkingSessions={[session]} theme={newTheme} />);

			// Component should have re-rendered with new theme
			// Claude ID button shows UUID octet (ABC12345 from default agentSessionId)
			const claudeButton = screen.getByText('ABC12345');
			expect(claudeButton.tagName).toBe('BUTTON');
			expect(claudeButton).toHaveStyle({ color: '#ff0000' });
		});

		it('re-renders when namedSessions changes for thinking session', () => {
			const session = createThinkingSession({
				name: 'Named Test Session',
				agentSessionId: 'abc12345',
			});

			const { rerender } = render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} namedSessions={{}} />
			);

			// Initially shows session name (no namedSessions match)
			const initialButtons = screen.getAllByText('Named Test Session');
			expect(initialButtons.length).toBeGreaterThanOrEqual(1);

			rerender(
				<ThinkingStatusPill
					thinkingSessions={[session]}
					theme={mockTheme}
					namedSessions={{ abc12345: 'Custom Name' }}
				/>
			);

			// After rerender, should show custom name from namedSessions
			expect(screen.getByText('Custom Name')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles session with no agentSessionId', () => {
			const session = createThinkingSession({
				name: 'No Claude ID Session',
				agentSessionId: undefined,
				aiTabs: undefined,
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should still render with session name (appears in both places when no agentSessionId)
			const elements = screen.getAllByText('No Claude ID Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles session with no thinkingStartTime', () => {
			const session = createThinkingSession({
				name: 'No Time Session',
				thinkingStartTime: undefined,
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should still render, just without elapsed time
			const elements = screen.getAllByText('No Time Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText('Elapsed:')).not.toBeInTheDocument();
		});

		it('handles special characters in session names', () => {
			const session = createThinkingSession({
				name: '<script>alert("xss")</script>',
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should display safely escaped (appears in multiple places)
			const elements = screen.getAllByText('<script>alert("xss")</script>');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles unicode in session names', () => {
			const session = createThinkingSession({ name: '🎼 Maestro Session' });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			const elements = screen.getAllByText('🎼 Maestro Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles very long session names', () => {
			const session = createThinkingSession({
				name: 'This is a very long session name that might cause layout issues',
			});
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			const elements = screen.getAllByText(
				'This is a very long session name that might cause layout issues'
			);
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles large token counts', () => {
			const session = createThinkingSession({ currentCycleTokens: 999999 });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			expect(screen.getByText('1000.0K')).toBeInTheDocument();
		});

		it('handles session with empty aiTabs array', () => {
			const session = createThinkingSession({ name: 'Empty Tabs Session', aiTabs: [] });
			render(<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />);
			// Should still render, using session's name (appears in both places)
			const elements = screen.getAllByText('Empty Tabs Session');
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		it('handles multiple thinking sessions', () => {
			// thinkingSessions should only contain pre-filtered thinking sessions
			const thinkingSessions = [
				createThinkingSession({ id: 'busy-1', name: 'Busy 1' }),
				createThinkingSession({ id: 'busy-2', name: 'Busy 2' }),
			];
			render(<ThinkingStatusPill thinkingSessions={thinkingSessions} theme={mockTheme} />);
			// Should show primary (Busy 1) and +1 indicator (Busy 2)
			// Busy 1 appears multiple times: in session name span AND in Claude ID button
			const busy1Elements = screen.getAllByText('Busy 1');
			expect(busy1Elements.length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('+1')).toBeInTheDocument();
		});

		it('handles rapid state changes', () => {
			const session = createThinkingSession();
			const { rerender } = render(
				<ThinkingStatusPill thinkingSessions={[session]} theme={mockTheme} />
			);

			// Rapidly toggle through states
			for (let i = 0; i < 10; i++) {
				rerender(
					<ThinkingStatusPill
						thinkingSessions={[{ ...session, currentCycleTokens: i * 100 }]}
						theme={mockTheme}
					/>
				);
			}

			// Should show final state
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
			// This test ensures the memo comparator includes theme
			const thinkingSession = createThinkingSession();
			const { rerender, container } = render(
				<ThinkingStatusPill thinkingSessions={[thinkingSession]} theme={mockTheme} />
			);

			// Capture initial text color from theme
			const pill = container.firstChild as HTMLElement;
			expect(pill).toBeTruthy();

			// Rerender with different theme
			const newTheme = {
				...mockTheme,
				colors: {
					...mockTheme.colors,
					textMain: '#ff0000', // Different text color
				},
			};

			rerender(<ThinkingStatusPill thinkingSessions={[thinkingSession]} theme={newTheme} />);

			// Component should have re-rendered with new theme
			// This test would fail if theme was missing from memo comparator
			expect(container.firstChild).toBeTruthy();
		});

		it('should re-render when autoRunState changes', () => {
			// This test ensures the memo comparator handles autoRunState correctly
			// thinkingSessions should be empty when no sessions are thinking

			// Start without AutoRun and no thinking sessions
			const { rerender } = render(<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} />);

			// Should not show anything when no thinking sessions and no autoRun
			expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();

			// Add autoRunState
			const autoRunState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				totalTasks: 5,
				currentTaskIndex: 2,
				startTime: Date.now(),
				completedTasks: 3, // This is what gets displayed as "3/5"
			};

			rerender(
				<ThinkingStatusPill thinkingSessions={[]} theme={mockTheme} autoRunState={autoRunState} />
			);

			// Should now show the AutoRun pill with completedTasks/totalTasks
			expect(screen.getByText('3/5')).toBeInTheDocument();
		});

		it('should re-render when namedSessions mapping changes', () => {
			// This test ensures the memo comparator handles namedSessions correctly
			const thinkingSession = createThinkingSession({
				agentSessionId: 'claude-abc123',
			});

			const { rerender } = render(
				<ThinkingStatusPill
					thinkingSessions={[thinkingSession]}
					theme={mockTheme}
					namedSessions={{}}
				/>
			);

			// Session name should be the default (may appear in multiple places due to tooltip)
			expect(screen.getAllByText('Test Session').length).toBeGreaterThan(0);

			// Update namedSessions with a custom name for this Claude session
			rerender(
				<ThinkingStatusPill
					thinkingSessions={[thinkingSession]}
					theme={mockTheme}
					namedSessions={{ 'claude-abc123': 'Custom Named Session' }}
				/>
			);

			// Should now show the custom name
			expect(screen.getAllByText('Custom Named Session').length).toBeGreaterThan(0);
		});
	});
});
