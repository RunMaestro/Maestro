import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingStatusPill } from '../../renderer/components/ThinkingStatusPill';
import type { AITab, BatchRunState, Session, Theme, ThinkingItem } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-theme',
	name: 'Integration Theme',
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

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		cwd: '/repo',
		projectRoot: '/repo',
		toolType: 'claude-code',
		state: 'busy',
		inputMode: 'ai',
		aiPid: 1,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		busySource: 'ai',
		thinkingStartTime: Date.now() - 75_000,
		currentCycleTokens: 1500,
		agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
		...overrides,
	};
}

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		name: 'Planning Tab',
		state: 'busy',
		agentSessionId: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		thinkingStartTime: Date.now() - 30_000,
		...overrides,
	};
}

function createItem(sessionOverrides: Partial<Session> = {}, tab?: AITab | null): ThinkingItem {
	return {
		session: createSession(sessionOverrides),
		tab: tab ?? null,
	};
}

function createItemWithTab(
	sessionOverrides: Partial<Session> = {},
	tabOverrides: Partial<AITab> = {}
): ThinkingItem {
	const tab = createTab(tabOverrides);
	return {
		session: createSession({ aiTabs: [tab], ...sessionOverrides }),
		tab,
	};
}

describe('ThinkingStatusPill integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it('renders nothing without active thinking or AutoRun state', () => {
		const { container } = render(<ThinkingStatusPill thinkingItems={[]} theme={theme} />);

		expect(container.firstChild).toBeNull();
	});

	it('renders primary thinking details, callbacks, elapsed timer, and interrupt action', () => {
		const onSessionClick = vi.fn();
		const onInterrupt = vi.fn();
		const item = createItemWithTab(
			{ id: 'session-active', name: 'Active Maestro', currentCycleTokens: 2500 },
			{
				id: 'tab-active',
				name: 'Build Plan',
				agentSessionId: 'named-session-id',
				thinkingStartTime: Date.now() - 3725_000,
			}
		);

		render(
			<ThinkingStatusPill
				thinkingItems={[item]}
				theme={theme}
				namedSessions={{ 'named-session-id': 'Named Claude' }}
				onSessionClick={onSessionClick}
				onInterrupt={onInterrupt}
				activeSessionId="session-active"
			/>
		);

		expect(screen.getByText('Active Maestro')).toBeInTheDocument();
		expect(screen.getByText('2.5K')).toBeInTheDocument();
		expect(screen.getByText('Named Claude')).toBeInTheDocument();
		expect(screen.getByText('1h 2m 5s')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Named Claude'));
		expect(onSessionClick).toHaveBeenCalledWith('session-active', 'tab-active');

		fireEvent.click(screen.getByTitle(/Interrupt .+ \(Ctrl\+C\)/));
		expect(onInterrupt).toHaveBeenCalledOnce();

		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(screen.getByText('1h 2m 8s')).toBeInTheDocument();
	});

	it('falls back through tab, UUID, thinking placeholder, and session display names', () => {
		const tabItem = createItemWithTab(
			{ id: 'session-tab', name: 'Tab Session', currentCycleTokens: 0 },
			{ name: 'Named Tab', agentSessionId: null }
		);
		const { rerender } = render(<ThinkingStatusPill thinkingItems={[tabItem]} theme={theme} />);
		expect(screen.getByText('Thinking...')).toBeInTheDocument();
		expect(screen.getByText('Named Tab')).toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[
					createItem({
						id: 'session-uuid',
						name: 'UUID Session',
						agentSessionId: 'uuid-1234567890',
					}),
				]}
				theme={theme}
			/>
		);
		expect(screen.getByText('UUID-123')).toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[
					createItem({
						id: 'session-name',
						name: 'Name Only Session',
						agentSessionId: undefined,
						thinkingStartTime: undefined,
					}),
				]}
				theme={theme}
			/>
		);
		expect(screen.getByText('Name Only Session')).toBeInTheDocument();
		expect(screen.queryByText('Elapsed:')).not.toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[
					createItemWithTab(
						{ id: 'session-tab-only', name: 'Tab Only Session', agentSessionId: undefined },
						{ name: 'Tab Only', agentSessionId: null }
					),
				]}
				theme={theme}
			/>
		);
		expect(screen.getByText('Tab Only')).toHaveAttribute('title', 'Claude Session');
	});

	it('shows all thinking items in the expanded dropdown and routes row clicks', () => {
		const onSessionClick = vi.fn();
		const first = createItem({ id: 'session-1', name: 'Primary Session' });
		const second = createItemWithTab(
			{ id: 'session-2', name: 'Secondary Session', currentCycleTokens: 500 },
			{ id: 'tab-2', name: 'Review Tab', agentSessionId: 'review-session' }
		);
		const third = createItem({ id: 'session-3', name: 'Legacy Session', currentCycleTokens: 0 });
		const fourth = createItemWithTab(
			{ id: 'session-4', name: 'Plain Tab Session', agentSessionId: undefined },
			{ id: 'tab-4', name: 'Plain Tab', agentSessionId: null }
		);
		const fifth = createItem({
			id: 'session-5',
			name: 'Session Fallback',
			agentSessionId: undefined,
		});

		render(
			<ThinkingStatusPill
				thinkingItems={[first, second, third, fourth, fifth]}
				theme={theme}
				namedSessions={{ 'review-session': 'Reviewer' }}
				onSessionClick={onSessionClick}
			/>
		);

		expect(screen.getByText('+4')).toBeInTheDocument();
		fireEvent.mouseEnter(screen.getByTitle('+4 more thinking'));
		expect(screen.getByText('All Thinking Sessions')).toBeInTheDocument();
		expect(screen.getByText('Secondary Session')).toBeInTheDocument();
		expect(screen.getByText('Reviewer')).toBeInTheDocument();
		expect(screen.getByText('Plain Tab')).toBeInTheDocument();
		expect(screen.getAllByText('Session Fallback').length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText('500')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Secondary Session').closest('button')!);
		expect(onSessionClick).toHaveBeenCalledWith('session-2', 'tab-2');

		fireEvent.mouseLeave(screen.getByTitle('+4 more thinking'));
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(screen.queryByText('All Thinking Sessions')).not.toBeInTheDocument();
	});

	it('renders AutoRun state, worktree status, stop actions, and stopping state', () => {
		const onStopAutoRun = vi.fn();
		const autoRunState = {
			isRunning: true,
			isStopping: false,
			completedTasks: 2,
			totalTasks: 5,
			startTime: Date.now() - 90_061_000,
			worktreeActive: true,
			worktreeBranch: 'feature/integration',
		} as BatchRunState;
		const { rerender } = render(
			<ThinkingStatusPill
				thinkingItems={[createItem({ name: 'Hidden Thinking' })]}
				theme={theme}
				autoRunState={autoRunState}
				onStopAutoRun={onStopAutoRun}
			/>
		);

		expect(screen.getByText('AutoRun')).toBeInTheDocument();
		expect(screen.getByText('2/5')).toBeInTheDocument();
		expect(screen.getByText('1d 1h 1m 1s')).toBeInTheDocument();
		expect(screen.getByTitle('Worktree: feature/integration')).toBeInTheDocument();
		expect(screen.queryByText('Hidden Thinking')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Stop auto-run after current task'));
		expect(onStopAutoRun).toHaveBeenCalledOnce();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[]}
				theme={theme}
				autoRunState={{
					...autoRunState,
					isStopping: true,
					worktreeBranch: undefined,
					completedTasks: 3,
				}}
				onStopAutoRun={onStopAutoRun}
			/>
		);
		expect(screen.getByText('AutoRun Stopping')).toBeInTheDocument();
		expect(screen.getByText((_, element) => element?.textContent === '3/5')).toBeInTheDocument();
		expect(screen.getByTitle('Stopping after current task...')).toBeDisabled();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[]}
				theme={theme}
				autoRunState={{ ...autoRunState, isStopping: false, worktreeBranch: undefined }}
			/>
		);
		expect(screen.queryByText('Stop')).not.toBeInTheDocument();
		expect(screen.getByTitle('Worktree: active')).toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[]}
				theme={theme}
				autoRunState={
					{
						isRunning: true,
						isStopping: false,
						completedTasks: 0,
						totalTasks: 1,
					} as BatchRunState
				}
			/>
		);
		expect(screen.getByText('0/1')).toBeInTheDocument();
	});

	it('re-renders for memoized thinking item, named-session, active-session, and theme changes', () => {
		const item = createItem({ id: 'session-1', name: 'Original', currentCycleTokens: 500 });
		const { rerender } = render(
			<ThinkingStatusPill thinkingItems={[item]} theme={theme} namedSessions={{}} />
		);
		expect(screen.getByText('Original')).toBeInTheDocument();
		expect(screen.getByText('500')).toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[createItem({ id: 'session-1', name: 'Renamed', currentCycleTokens: 1000 })]}
				theme={theme}
				namedSessions={{}}
			/>
		);
		expect(screen.getByText('Renamed')).toBeInTheDocument();
		expect(screen.getByText('1.0K')).toBeInTheDocument();

		const first = createItem({ id: 'session-1', name: 'First' });
		const second = createItem({ id: 'session-2', name: 'Second' });
		rerender(
			<ThinkingStatusPill
				thinkingItems={[first, second]}
				theme={theme}
				activeSessionId="session-2"
				namedSessions={{}}
			/>
		);
		expect(screen.getByText('Second')).toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[
					createItemWithTab(
						{ id: 'session-3', name: 'Named Session' },
						{ id: 'tab-3', agentSessionId: 'agent-3', name: undefined }
					),
				]}
				theme={theme}
				namedSessions={{ 'agent-3': 'Agent Three' }}
			/>
		);
		expect(screen.getByText('Agent Three')).toBeInTheDocument();

		rerender(
			<ThinkingStatusPill
				thinkingItems={[
					createItemWithTab(
						{ id: 'session-3', name: 'Named Session' },
						{ id: 'tab-3', agentSessionId: 'agent-3', name: undefined }
					),
				]}
				theme={{ ...theme, colors: { ...theme.colors, accent: '#ff00ff' } }}
				namedSessions={{ 'agent-3': 'Agent Three Updated' }}
			/>
		);
		expect(screen.getByText('Agent Three Updated')).toBeInTheDocument();
	});

	it('compares memoized props across AutoRun, thinking item, named-session, and theme changes', () => {
		const compare = (
			ThinkingStatusPill as unknown as {
				compare: (
					prev: React.ComponentProps<typeof ThinkingStatusPill>,
					next: React.ComponentProps<typeof ThinkingStatusPill>
				) => boolean;
			}
		).compare;
		const baseItem = createItemWithTab(
			{ id: 'session-compare', name: 'Compare Session' },
			{ id: 'tab-compare', name: 'Compare Tab', agentSessionId: 'agent-compare' }
		);
		const baseProps: React.ComponentProps<typeof ThinkingStatusPill> = {
			thinkingItems: [baseItem],
			theme,
			namedSessions: { 'agent-compare': 'Compare Agent' },
			activeSessionId: 'session-compare',
		};

		expect(
			compare({ ...baseProps, autoRunState: { isRunning: false } as BatchRunState }, baseProps)
		).toBe(false);

		const autoRunState = {
			isRunning: true,
			completedTasks: 1,
			totalTasks: 5,
			isStopping: false,
			startTime: Date.now(),
			worktreeActive: false,
			worktreeBranch: undefined,
		} as BatchRunState;
		const autoRunProps = { ...baseProps, autoRunState };
		expect(compare(autoRunProps, { ...autoRunProps, autoRunState: { ...autoRunState } })).toBe(
			true
		);
		expect(
			compare(autoRunProps, {
				...autoRunProps,
				autoRunState: { ...autoRunState, totalTasks: 6 },
			})
		).toBe(false);
		expect(
			compare(autoRunProps, {
				...autoRunProps,
				autoRunState: { ...autoRunState, isStopping: true },
			})
		).toBe(false);
		expect(
			compare(autoRunProps, {
				...autoRunProps,
				autoRunState: { ...autoRunState, startTime: autoRunState.startTime! + 1 },
			})
		).toBe(false);
		expect(
			compare(autoRunProps, {
				...autoRunProps,
				autoRunState: { ...autoRunState, worktreeActive: true },
			})
		).toBe(false);
		expect(
			compare(autoRunProps, {
				...autoRunProps,
				autoRunState: { ...autoRunState, worktreeBranch: 'branch' },
			})
		).toBe(false);

		expect(
			compare(baseProps, {
				...baseProps,
				thinkingItems: [...baseProps.thinkingItems, createItem()],
			})
		).toBe(false);
		expect(
			compare(baseProps, {
				...baseProps,
				thinkingItems: [
					{
						...baseItem,
						tab: { ...baseItem.tab!, name: 'Renamed Tab' },
					},
				],
			})
		).toBe(false);
		expect(
			compare(baseProps, {
				...baseProps,
				namedSessions: { 'agent-compare': 'Compare Agent' },
			})
		).toBe(true);
		expect(
			compare(baseProps, {
				...baseProps,
				namedSessions: { 'agent-compare': 'Updated Agent' },
			})
		).toBe(false);
		const noClaudeProps = {
			...baseProps,
			thinkingItems: [createItem({ agentSessionId: undefined }, null)],
			namedSessions: {},
		};
		expect(compare(noClaudeProps, { ...noClaudeProps, namedSessions: {} })).toBe(true);
		expect(
			compare(baseProps, {
				...baseProps,
				theme: { ...theme, colors: { ...theme.colors, accent: '#ff00ff' } },
			})
		).toBe(false);
	});
});
