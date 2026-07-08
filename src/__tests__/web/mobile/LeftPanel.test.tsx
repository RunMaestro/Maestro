/**
 * Tests for the LeftPanel component (web remote-control side panel).
 *
 * @file src/web/mobile/LeftPanel.tsx
 *
 * Regression coverage for the "Bookmarks" section: bookmarked agents must
 * appear in a dedicated section at the top of the side panel (in addition to
 * their normal group), mirroring the desktop Left Bar. The section is hidden
 * while the unread filter is active.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { LeftPanel } from '../../../web/mobile/LeftPanel';
import type { Session } from '../../../web/hooks/useSessions';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentForeground: '#ffffff',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({
		theme: { id: 'dracula', name: 'Dracula', mode: 'dark', colors: mockColors },
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Partial mock — keep real exports (GESTURE_THRESHOLDS, HAPTIC_PATTERNS, etc.,
// which useSwipeGestures relies on) and only stub the haptics side effect.
vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return { ...actual, triggerHaptic: vi.fn() };
});

// Build a minimal Session with just the fields LeftPanel reads.
const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		aiTabs: [],
		...overrides,
	}) as unknown as Session;

const baseProps = {
	activeSessionId: null,
	onSelectSession: vi.fn(),
	onClose: vi.fn(),
	collapsedGroups: new Set<string>(),
	setCollapsedGroups: vi.fn(),
	showUnreadOnly: false,
	setShowUnreadOnly: vi.fn(),
};

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('LeftPanel — Bookmarks section', () => {
	it('renders a Bookmarks section when an agent is bookmarked', () => {
		const sessions = [
			createSession({ id: 's1', name: 'Bookmarked Agent', bookmarked: true }),
			createSession({ id: 's2', name: 'Plain Agent' }),
		];

		render(<LeftPanel {...baseProps} sessions={sessions} />);

		expect(screen.getByText('Bookmarks')).toBeInTheDocument();
		// Bookmarked agent appears twice: once under Bookmarks, once Ungrouped.
		expect(screen.getAllByText('Bookmarked Agent')).toHaveLength(2);
		// Non-bookmarked agent appears only in its normal section.
		expect(screen.getAllByText('Plain Agent')).toHaveLength(1);
	});

	it('does not render a Bookmarks section when no agent is bookmarked', () => {
		const sessions = [createSession({ id: 's1', name: 'Plain Agent' })];

		render(<LeftPanel {...baseProps} sessions={sessions} />);

		expect(screen.queryByText('Bookmarks')).not.toBeInTheDocument();
	});

	it('hides the Bookmarks section while the unread filter is active', () => {
		// Bookmarked AND busy, so it passes the unread filter and still renders —
		// but the dedicated Bookmarks section header must be suppressed.
		const sessions = [
			createSession({ id: 's1', name: 'Busy Bookmarked', bookmarked: true, state: 'busy' }),
		];

		render(<LeftPanel {...baseProps} sessions={sessions} showUnreadOnly={true} />);

		expect(screen.queryByText('Bookmarks')).not.toBeInTheDocument();
		// The agent itself still shows (in its normal/ungrouped section).
		expect(screen.getByText('Busy Bookmarked')).toBeInTheDocument();
	});
});

describe('LeftPanel interactions', () => {
	it('handles header controls, empty state, and unread auto-disable', () => {
		const onNewAgent = vi.fn();
		const onClose = vi.fn();
		const setShowUnreadOnly = vi.fn();

		render(
			<LeftPanel
				{...baseProps}
				sessions={[]}
				onNewAgent={onNewAgent}
				onClose={onClose}
				showUnreadOnly={true}
				setShowUnreadOnly={setShowUnreadOnly}
			/>
		);

		expect(screen.getByText('No agents yet')).toBeInTheDocument();
		expect(setShowUnreadOnly).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByRole('button', { name: 'Showing unread agents only' }));
		expect(setShowUnreadOnly).toHaveBeenCalledWith(expect.any(Function));

		fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
		expect(onNewAgent).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('selects parent and worktree child sessions and toggles worktree visibility', () => {
		const onSelectSession = vi.fn();
		const parent = createSession({ id: 'parent', name: 'Parent Agent', toolType: 'codex' });
		const child = createSession({
			id: 'child',
			name: 'Child Worktree',
			toolType: 'codex',
			parentSessionId: 'parent',
			worktreeBranch: 'feature/mobile',
			state: 'busy',
		});

		render(
			<LeftPanel
				{...baseProps}
				sessions={[parent, child]}
				activeSessionId="child"
				onSelectSession={onSelectSession}
			/>
		);

		fireEvent.click(screen.getByText('Parent Agent').closest('button') as HTMLButtonElement);
		expect(onSelectSession).toHaveBeenCalledWith('parent');
		expect(screen.getByText('Child Worktree')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Collapse 1 worktree' }));
		expect(screen.queryByText('Child Worktree')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Expand 1 worktree' }));
		fireEvent.click(screen.getByText('Child Worktree').closest('button') as HTMLButtonElement);
		expect(onSelectSession).toHaveBeenCalledWith('child');
	});

	it('collapses named groups and opens the create group sheet', async () => {
		vi.useFakeTimers();
		const onCreateGroup = vi.fn().mockResolvedValue({ id: 'new-group' });
		const setCollapsedGroups = vi.fn();
		const sessions = [
			createSession({
				id: 'grouped',
				name: 'Grouped Agent',
				groupId: 'team',
				groupName: 'Team',
				groupEmoji: '',
			}),
		];

		render(
			<LeftPanel
				{...baseProps}
				sessions={sessions}
				onCreateGroup={onCreateGroup}
				setCollapsedGroups={setCollapsedGroups}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Team/ }));
		expect(setCollapsedGroups).toHaveBeenCalledWith(expect.any(Function));

		fireEvent.click(screen.getByRole('button', { name: 'New group' }));
		expect(screen.getByText('New Group')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create Group' })).toBeDisabled();

		fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'Research' } });
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Create Group' }));
			await Promise.resolve();
		});

		expect(onCreateGroup).toHaveBeenCalledWith('Research', undefined);
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(screen.queryByText('New Group')).not.toBeInTheDocument();
	});

	it('opens the context menu and moves a session to a group', async () => {
		vi.useFakeTimers();
		const onMoveToGroup = vi.fn().mockResolvedValue(true);
		const session = createSession({ id: 'move-me', name: 'Move Me' });
		const groups = [{ id: 'docs', name: 'Docs', emoji: '' }] as any;

		render(
			<LeftPanel
				{...baseProps}
				sessions={[session]}
				groups={groups}
				onMoveToGroup={onMoveToGroup}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Move Me'));
		fireEvent.click(screen.getByRole('button', { name: 'Move to Group' }));
		expect(screen.getByText('Move "Move Me" to Group')).toBeInTheDocument();

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
			await Promise.resolve();
		});

		expect(onMoveToGroup).toHaveBeenCalledWith('move-me', 'docs');
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(screen.queryByText('Move "Move Me" to Group')).not.toBeInTheDocument();
	});
});
