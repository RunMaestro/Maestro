import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionItem } from '../../../renderer/components/SessionItem';
import type { Group, Session, Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#181818',
		border: '#333333',
		textMain: '#f4f4f4',
		textDim: '#999999',
		accent: '#4f9cff',
		accentDim: '#1c4c7a',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const group: Group = {
	id: 'group-1',
	name: 'Build',
	emoji: 'B',
	collapsed: false,
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Main Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	};
}

function renderSessionItem(
	overrides: Partial<React.ComponentProps<typeof SessionItem>> = {},
	callbacks = {
		onSelect: vi.fn(),
		onDragStart: vi.fn(),
		onContextMenu: vi.fn(),
		onFinishRename: vi.fn(),
		onStartRename: vi.fn(),
		onToggleBookmark: vi.fn(),
	}
) {
	render(
		<SessionItem
			session={createSession()}
			variant="flat"
			theme={theme}
			isActive={false}
			isKeyboardSelected={false}
			isDragging={false}
			isEditing={false}
			leftSidebarOpen={true}
			{...callbacks}
			{...overrides}
		/>
	);

	return callbacks;
}

function getSessionRow() {
	const row = screen.getByText('Main Agent').closest('[draggable="true"]');
	expect(row).not.toBeNull();
	return row!;
}

describe('SessionItem', () => {
	it('removes a bookmark from the bookmark variant without selecting the row', () => {
		const callbacks = renderSessionItem({
			session: createSession({ bookmarked: true }),
			variant: 'bookmark',
			group,
		});

		expect(screen.getByText('Build')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Remove bookmark'));

		expect(callbacks.onToggleBookmark).toHaveBeenCalledOnce();
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it('adds a bookmark from a flat session without selecting the row', () => {
		const callbacks = renderSessionItem({
			session: createSession({ bookmarked: false }),
			variant: 'flat',
		});

		fireEvent.click(screen.getByTitle('Add bookmark'));

		expect(callbacks.onToggleBookmark).toHaveBeenCalledOnce();
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it('commits an edited session name from the inline rename input', () => {
		const callbacks = renderSessionItem({
			isEditing: true,
			session: createSession({ name: 'Old Name' }),
		});
		const input = screen.getByDisplayValue('Old Name');

		fireEvent.click(input);
		fireEvent.change(input, { target: { value: 'New Name' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.blur(input);

		expect(callbacks.onFinishRename).toHaveBeenCalledWith('New Name');
		expect(callbacks.onFinishRename).toHaveBeenCalledTimes(2);
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it('ignores non-Enter keys while editing a session name', () => {
		const callbacks = renderSessionItem({
			isEditing: true,
			session: createSession({ name: 'Old Name' }),
		});

		fireEvent.keyDown(screen.getByDisplayValue('Old Name'), { key: 'Escape' });

		expect(callbacks.onFinishRename).not.toHaveBeenCalled();
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it('renders a worktree child without a bookmark action', () => {
		renderSessionItem({
			session: createSession({
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature/test',
			}),
			variant: 'worktree',
		});

		expect(screen.getByText('Main Agent')).toBeInTheDocument();
		expect(screen.queryByTitle('Add bookmark')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Remove bookmark')).not.toBeInTheDocument();
	});

	it('marks active, dragging, jump-numbered sessions with their visible row state', () => {
		renderSessionItem({
			isActive: true,
			isDragging: true,
			jumpNumber: '4',
		});

		const row = getSessionRow();
		expect(row).toHaveClass('opacity-50');
		expect(row).toHaveStyle({
			borderColor: theme.colors.accent,
			backgroundColor: theme.colors.bgActivity,
		});
		expect(screen.getByText('4')).toBeInTheDocument();
	});

	it('marks keyboard-selected sessions without making them active', () => {
		renderSessionItem({
			isKeyboardSelected: true,
		});

		const row = getSessionRow();
		expect(row).toHaveStyle({ borderColor: theme.colors.accent });
		expect(row.getAttribute('style')).toContain('background-color: rgba(24, 24, 24, 0.25)');
	});

	it('renders git, dirty file, and SSH indicators for a remote git repository', () => {
		renderSessionItem({
			session: createSession({
				isGitRepo: true,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			}),
			gitFileCount: 3,
		});

		expect(screen.getByText(/\(SSH\)/)).toBeInTheDocument();
		expect(screen.getByText('3')).toBeInTheDocument();
		expect(screen.getByTitle('Running on remote host via SSH')).toBeInTheDocument();
		expect(screen.getByTitle('Git repository')).toHaveTextContent('GIT');
	});

	it('renders a remote plain directory badge when the session is not a git repo', () => {
		renderSessionItem({
			session: createSession({
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			}),
		});

		expect(screen.getByTitle('Running on remote host via SSH')).toHaveTextContent('REMOTE');
	});

	it('hides the local badge for terminal sessions', () => {
		renderSessionItem({
			session: createSession({ toolType: 'terminal' }),
		});

		expect(screen.queryByTitle('Local directory (not a git repo)')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Git repository')).not.toBeInTheDocument();
	});

	it('renders bookmarked flat sessions and agent errors', () => {
		renderSessionItem({
			session: createSession({
				bookmarked: true,
				agentError: {
					type: 'agent_crashed',
					message: 'Agent stopped unexpectedly',
					recoverable: true,
					agentId: 'claude-code',
					sessionId: 'session-1',
					timestamp: 100,
				},
			}),
		});

		expect(screen.getByTitle('Remove bookmark')).toBeInTheDocument();
		expect(screen.getByTitle('Error: Agent stopped unexpectedly')).toHaveTextContent('ERR');
	});

	it('renders status titles for active agent states', () => {
		const { rerender } = render(
			<SessionItem
				session={createSession({ agentSessionId: 'agent-1', state: 'busy' })}
				variant="flat"
				theme={theme}
				isActive={false}
				isKeyboardSelected={false}
				isDragging={false}
				isEditing={false}
				leftSidebarOpen={true}
				onSelect={vi.fn()}
				onDragStart={vi.fn()}
				onContextMenu={vi.fn()}
				onFinishRename={vi.fn()}
				onStartRename={vi.fn()}
				onToggleBookmark={vi.fn()}
			/>
		);

		expect(screen.getByTitle('Agent is thinking')).toHaveClass('animate-pulse');

		rerender(
			<SessionItem
				session={createSession({
					agentSessionId: 'agent-1',
					state: 'busy',
					cliActivity: {
						playbookId: 'playbook-1',
						playbookName: 'Deploy',
						startedAt: 10,
					},
				})}
				variant="flat"
				theme={theme}
				isActive={false}
				isKeyboardSelected={false}
				isDragging={false}
				isEditing={false}
				leftSidebarOpen={true}
				onSelect={vi.fn()}
				onDragStart={vi.fn()}
				onContextMenu={vi.fn()}
				onFinishRename={vi.fn()}
				onStartRename={vi.fn()}
				onToggleBookmark={vi.fn()}
			/>
		);
		expect(screen.getByTitle('CLI: Running playbook "Deploy"')).toHaveClass('animate-pulse');

		rerender(
			<SessionItem
				session={createSession({ agentSessionId: 'agent-1', state: 'connecting' })}
				variant="flat"
				theme={theme}
				isActive={false}
				isKeyboardSelected={false}
				isDragging={false}
				isEditing={false}
				leftSidebarOpen={true}
				onSelect={vi.fn()}
				onDragStart={vi.fn()}
				onContextMenu={vi.fn()}
				onFinishRename={vi.fn()}
				onStartRename={vi.fn()}
				onToggleBookmark={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Attempting to establish connection')).toHaveClass('animate-pulse');

		rerender(
			<SessionItem
				session={createSession({ agentSessionId: 'agent-1', state: 'error' })}
				variant="flat"
				theme={theme}
				isActive={false}
				isKeyboardSelected={false}
				isDragging={false}
				isEditing={false}
				leftSidebarOpen={true}
				onSelect={vi.fn()}
				onDragStart={vi.fn()}
				onContextMenu={vi.fn()}
				onFinishRename={vi.fn()}
				onStartRename={vi.fn()}
				onToggleBookmark={vi.fn()}
			/>
		);
		expect(screen.getByTitle('No connection with agent')).toBeInTheDocument();

		rerender(
			<SessionItem
				session={createSession({ agentSessionId: 'agent-1', state: 'waiting_input' })}
				variant="flat"
				theme={theme}
				isActive={false}
				isKeyboardSelected={false}
				isDragging={false}
				isEditing={false}
				leftSidebarOpen={true}
				onSelect={vi.fn()}
				onDragStart={vi.fn()}
				onContextMenu={vi.fn()}
				onFinishRename={vi.fn()}
				onStartRename={vi.fn()}
				onToggleBookmark={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Waiting for input')).toBeInTheDocument();
	});

	it('renders batch and unread indicators without an active agent session', () => {
		renderSessionItem({
			isInBatch: true,
			session: createSession({
				aiTabs: [{ id: 'tab-1', name: 'Agent', logs: [], state: 'idle', hasUnread: true }],
			}),
		});

		expect(screen.getByTitle('Auto Run active')).toHaveTextContent('AUTO');
		expect(screen.getByTitle('Unread messages')).toBeInTheDocument();
		expect(screen.getByTitle('No active Claude session')).toHaveClass('animate-pulse');
	});
});
