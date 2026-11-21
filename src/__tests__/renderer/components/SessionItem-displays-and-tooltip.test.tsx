// Source: src/__tests__/renderer/components/SessionListItem.test.tsx
// Source: src/__tests__/renderer/components/SessionItemStatus.test.ts
// Source: src/__tests__/renderer/components/SessionItemWorktreeToggle.test.tsx
// Source: src/__tests__/renderer/components/SessionItemPhone.test.tsx
// Source: src/__tests__/renderer/components/SessionList/SessionTooltipContent.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import React from 'react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { SessionListItem } from '../../../renderer/components/SessionListItem';
import type { ClaudeSession } from '../../../renderer/hooks/agent/useSessionViewer';
import { mockTheme } from '../../helpers/mockTheme';
import { getEnhancedStatusColor } from '../../../renderer/components/SessionItem';
import { createMockSession } from '../../helpers/mockSession';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session } from '../../../renderer/types';
import type { Theme } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { usePhoneLayout } from '../../../renderer/hooks/ui/useViewportBreakpoint';
import { SessionTooltipContent } from '../../../renderer/components/SessionList/SessionTooltipContent';

vi.mock('../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
vi.mock('lucide-react', async (importOriginal) => ({
	...(await importOriginal()),
	Activity: () => <span data-testid="icon-activity" />,
	Folder: () => <span data-testid="icon-folder" />,
	Clock: () => <span data-testid="icon-clock" />,
	GitBranch: () => <span data-testid="icon-git-branch" />,
	Bot: () => <span data-testid="icon-bot" />,
	Bookmark: () => <span data-testid="icon-bookmark" />,
	AlertCircle: () => <span data-testid="icon-alert-circle" />,
	Server: () => <span data-testid="icon-server" />,
}));

describeSourceSuite('SessionListItem', () => {
	const baseSession: ClaudeSession = {
		sessionId: 'test-session-1',
		projectPath: '/project',
		timestamp: '2026-10-04T00:00:00Z',
		modifiedAt: '2026-10-04T00:00:00Z',
		firstMessage: 'Hello',
		messageCount: 2,
		sizeBytes: 200,
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 1,
	};

	describe('SessionListItem rename IME composition', () => {
		it('submits rename on normal Enter key', () => {
			const onSubmitRename = vi.fn();
			const onCancelRename = vi.fn();

			render(
				<SessionListItem
					session={baseSession}
					isSelected={false}
					isStarred={false}
					activeAgentSessionId={null}
					isRenaming={true}
					renameValue="New Name"
					searchMode="title"
					theme={mockTheme}
					selectedItemRef={React.createRef()}
					renameInputRef={React.createRef()}
					onSessionClick={vi.fn()}
					onToggleStar={vi.fn()}
					onQuickResume={vi.fn()}
					onStartRename={vi.fn()}
					onRenameChange={vi.fn()}
					onSubmitRename={onSubmitRename}
					onCancelRename={onCancelRename}
				/>
			);

			const input = screen.getByPlaceholderText('Enter session name...');
			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			input.dispatchEvent(event);

			expect(onSubmitRename).toHaveBeenCalledWith('test-session-1');
			expect(preventDefaultSpy).toHaveBeenCalled();
		});

		it('does not submit rename on Enter during active IME composition (isComposing: true)', () => {
			const onSubmitRename = vi.fn();
			const onCancelRename = vi.fn();

			render(
				<SessionListItem
					session={baseSession}
					isSelected={false}
					isStarred={false}
					activeAgentSessionId={null}
					isRenaming={true}
					renameValue="New Name"
					searchMode="title"
					theme={mockTheme}
					selectedItemRef={React.createRef()}
					renameInputRef={React.createRef()}
					onSessionClick={vi.fn()}
					onToggleStar={vi.fn()}
					onQuickResume={vi.fn()}
					onStartRename={vi.fn()}
					onRenameChange={vi.fn()}
					onSubmitRename={onSubmitRename}
					onCancelRename={onCancelRename}
				/>
			);

			const input = screen.getByPlaceholderText('Enter session name...');
			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
			Object.defineProperty(event, 'isComposing', { value: true });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			input.dispatchEvent(event);

			expect(onSubmitRename).not.toHaveBeenCalled();
			expect(preventDefaultSpy).not.toHaveBeenCalled();
		});

		it('does not submit rename on Enter during Safari IME candidate confirmation (keyCode 229)', () => {
			const onSubmitRename = vi.fn();
			const onCancelRename = vi.fn();

			render(
				<SessionListItem
					session={baseSession}
					isSelected={false}
					isStarred={false}
					activeAgentSessionId={null}
					isRenaming={true}
					renameValue="New Name"
					searchMode="title"
					theme={mockTheme}
					selectedItemRef={React.createRef()}
					renameInputRef={React.createRef()}
					onSessionClick={vi.fn()}
					onToggleStar={vi.fn()}
					onQuickResume={vi.fn()}
					onStartRename={vi.fn()}
					onRenameChange={vi.fn()}
					onSubmitRename={onSubmitRename}
					onCancelRename={onCancelRename}
				/>
			);

			const input = screen.getByPlaceholderText('Enter session name...');
			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
			Object.defineProperty(event, 'keyCode', { value: 229 });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			input.dispatchEvent(event);

			expect(onSubmitRename).not.toHaveBeenCalled();
			expect(preventDefaultSpy).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('SessionItemStatus', () => {
	/**
	 * A Claude Code agent already bound to a provider session. Without the binding,
	 * the hollow-dot case outranks everything below and every label reads
	 * "No active Claude session".
	 */
	function boundSession(overrides: Parameters<typeof createMockSession>[0] = {}) {
		return createMockSession({ agentSessionId: 'provider-session-1', ...overrides });
	}

	function label(session: ReturnType<typeof boundSession>): string {
		return getEnhancedStatusColor(session, mockTheme, false).label;
	}

	describe('getEnhancedStatusColor busy labels', () => {
		it('calls a shell command a command, not thinking', () => {
			const session = boundSession({ state: 'busy', busySource: 'terminal' });

			const status = getEnhancedStatusColor(session, mockTheme, false);

			expect(status.label).toBe('Running command');
			// Still busy: only the wording changes, not the signal.
			expect(status.active).toBe(true);
			expect(status.color).toBe(mockTheme.colors.warning);
		});

		it('calls an agent turn thinking', () => {
			expect(label(boundSession({ state: 'busy', busySource: 'ai' }))).toBe('Thinking');
		});

		// Legacy sessions and any path that marks a row busy without saying why: the
		// AI turn is the common case, so it stays the default.
		it('defaults to thinking when no busy source was recorded', () => {
			expect(label(boundSession({ state: 'busy', busySource: undefined }))).toBe('Thinking');
		});

		it('leaves the other states alone', () => {
			expect(label(boundSession({ state: 'idle' }))).toBe('Ready');
			expect(label(boundSession({ state: 'error' }))).toBe('Error');
			expect(label(boundSession({ state: 'connecting' }))).toBe('Connecting');
		});

		// Auto Run outranks agent state, so a busy row inside a batch says so
		// regardless of what is driving it.
		it('reports Auto Run ahead of the busy source', () => {
			const session = boundSession({ state: 'busy', busySource: 'terminal' });

			expect(getEnhancedStatusColor(session, mockTheme, true).label).toBe('Auto Run active');
		});
	});

	/**
	 * A cross-agent consult runs under a synthetic process id and writes into a
	 * hidden tab, so it never reaches `session.state`. Before this the consulted
	 * agent drew a green "Ready" dot for the entire time it was working - and for a
	 * Claude agent the user had never opened, a dim "No active Claude session" one,
	 * because a fresh consult tab has no provider session until the answer lands.
	 */
	describe('getEnhancedStatusColor consult state', () => {
		it('shows a pulsing busy dot while an idle agent answers a consult', () => {
			const status = getEnhancedStatusColor(
				boundSession({ state: 'idle' }),
				mockTheme,
				false,
				false,
				false,
				true
			);

			expect(status.label).toBe('Answering a consult');
			expect(status.active).toBe(true);
			expect(status.color).toBe(mockTheme.colors.warning);
		});

		// The whole point of the ordering: an unbound Claude agent is the COMMON
		// consult target, so the hollow dot must not mask live work.
		it('outranks the unbound-Claude hollow dot', () => {
			const unbound = createMockSession({ state: 'idle', agentSessionId: undefined, aiTabs: [] });

			const status = getEnhancedStatusColor(unbound, mockTheme, false, false, false, true);

			expect(status.label).toBe('Answering a consult');
			expect(status.color).toBe(mockTheme.colors.warning);
		});

		// Both draw the same dot, so the agent's own turn keeps the more specific
		// wording rather than being relabelled by a consult running beside it.
		it('defers to the agent own turn for the label', () => {
			const busy = boundSession({ state: 'busy', busySource: 'ai' });

			expect(getEnhancedStatusColor(busy, mockTheme, false, false, false, true).label).toBe(
				'Thinking'
			);
		});

		// A stuck auto-retry is a "needs attention" state; a consult is not.
		it('stays below an active outage', () => {
			const status = getEnhancedStatusColor(
				boundSession({ state: 'idle' }),
				mockTheme,
				false,
				false,
				true,
				true
			);

			expect(status.label).toBe('Auto-retrying (stuck)');
		});

		it('leaves an idle agent alone when nothing is consulting it', () => {
			expect(label(boundSession({ state: 'idle' }))).toBe('Ready');
		});
	});

	describe('headless status overlay', () => {
		it('shows running headless work on an unbound agent without mutating desktop state', () => {
			const session = createMockSession({ state: 'idle', agentSessionId: undefined, aiTabs: [] });
			expect(
				getEnhancedStatusColor(session, mockTheme, false, false, false, false, true)
			).toMatchObject({
				active: true,
				color: mockTheme.colors.warning,
				label: 'Running headless turn',
			});
			expect(session.state).toBe('idle');
			expect(session.aiTabs).toHaveLength(0);
		});
		it('leaves a desktop turn busy after headless work has ended', () => {
			expect(
				getEnhancedStatusColor(
					boundSession({ state: 'busy' }),
					mockTheme,
					false,
					false,
					false,
					false,
					false
				)
			).toMatchObject({ active: true, label: 'Thinking' });
		});
	});
});
describeSourceSuite('SessionItemWorktreeToggle', () => {
	const defaultTheme: Theme = {
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
			info: '#8be9fd',
		},
	};

	const createMockSession = (overrides: Partial<Session> = {}): Session =>
		baseCreateMockSession({
			cwd: '/home/user/project',
			fullPath: '/home/user/project',
			projectRoot: '/home/user/project',
			isGitRepo: true,
			...overrides,
		});

	const defaultProps = {
		variant: 'flat' as const,
		theme: defaultTheme,
		isActive: false,
		isKeyboardSelected: false,
		isDragging: false,
		isEditing: false,
		leftSidebarOpen: true,
		onSelect: vi.fn(),
		onDragStart: vi.fn(),
		onContextMenu: vi.fn(),
		onFinishRename: vi.fn(),
		onStartRename: vi.fn(),
		onToggleBookmark: vi.fn(),
	};

	describe('SessionItem worktree metadata', () => {
		const initialSettings = {
			showWorktreeProvider: useSettingsStore.getState().showWorktreeProvider,
			showWorktreeBranchName: useSettingsStore.getState().showWorktreeBranchName,
		};

		beforeEach(() => {
			useSettingsStore.setState({ showWorktreeProvider: false, showWorktreeBranchName: false });
		});

		afterEach(() => {
			useSettingsStore.setState(initialSettings);
		});

		it.each([
			[false, false],
			[false, true],
			[true, false],
			[true, true],
		])('independently shows provider=%s and branch=%s', (showProvider, showBranch) => {
			useSettingsStore.setState({
				showWorktreeProvider: showProvider,
				showWorktreeBranchName: showBranch,
			});
			render(
				<SessionItem
					{...defaultProps}
					variant="worktree"
					session={createMockSession({ toolType: 'codex', worktreeBranch: 'feat/x' })}
				/>
			);

			expect(screen.queryByTitle('Provider: Codex') !== null).toBe(showProvider);
			expect(screen.queryByTitle('feat/x') !== null).toBe(showBranch);
			expect(screen.queryByText('·') !== null).toBe(showProvider && showBranch);
			if (showProvider && showBranch) {
				const provider = screen.getByTitle('Provider: Codex');
				const branch = screen.getByTitle('feat/x');
				expect(provider.parentElement).toBe(branch.parentElement);
				expect(provider).toHaveClass('shrink-0');
				expect(branch).toHaveClass('truncate');
			}
		});

		it('shows the provider without a branch and updates when the agent changes provider', () => {
			useSettingsStore.setState({ showWorktreeProvider: true, showWorktreeBranchName: true });
			const session = createMockSession({ toolType: 'codex', worktreeBranch: undefined });
			const { rerender } = render(
				<SessionItem {...defaultProps} variant="worktree" session={session} />
			);
			expect(screen.getByTitle('Provider: Codex')).toHaveTextContent('Codex');
			expect(screen.queryByText('·')).not.toBeInTheDocument();

			rerender(
				<SessionItem
					{...defaultProps}
					variant="worktree"
					session={{ ...session, toolType: 'claude-code' }}
				/>
			);
			expect(screen.getByTitle('Provider: Claude Code')).toHaveTextContent('Claude Code');
			expect(screen.queryByTitle('Provider: Codex')).not.toBeInTheDocument();
		});

		it('hides worktree metadata while renaming', () => {
			useSettingsStore.setState({ showWorktreeProvider: true, showWorktreeBranchName: true });
			render(
				<SessionItem
					{...defaultProps}
					variant="worktree"
					isEditing
					session={createMockSession({ toolType: 'codex', worktreeBranch: 'feat/x' })}
				/>
			);
			expect(screen.queryByTitle('Provider: Codex')).not.toBeInTheDocument();
			expect(screen.queryByTitle('feat/x')).not.toBeInTheDocument();
		});
	});

	describe('SessionItem worktree collapse toggle', () => {
		it('shows the toggle for a parent with children but no worktreeConfig (#1292)', () => {
			render(
				<SessionItem
					{...defaultProps}
					session={createMockSession({ worktreeConfig: undefined })}
					worktreeChildCount={5}
					onToggleWorktrees={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: 'Collapse worktrees' })).toBeInTheDocument();
		});

		it('shows the toggle for a configured parent that still has children', () => {
			render(
				<SessionItem
					{...defaultProps}
					session={createMockSession({
						worktreeConfig: { basePath: '/home/user/worktrees', watchEnabled: true },
					})}
					worktreeChildCount={2}
					onToggleWorktrees={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: 'Collapse worktrees' })).toBeInTheDocument();
		});

		it('drops the toggle once the last worktree is removed, worktreeConfig and all (#1616)', () => {
			render(
				<SessionItem
					{...defaultProps}
					session={createMockSession({
						worktreeConfig: { basePath: '/home/user/worktrees', watchEnabled: true },
					})}
					worktreeChildCount={0}
					onToggleWorktrees={vi.fn()}
				/>
			);

			expect(screen.queryByRole('button', { name: /worktrees$/ })).not.toBeInTheDocument();
		});

		it('does not show the toggle for a plain agent with no worktrees', () => {
			render(
				<SessionItem
					{...defaultProps}
					session={createMockSession()}
					worktreeChildCount={0}
					onToggleWorktrees={vi.fn()}
				/>
			);

			expect(screen.queryByRole('button', { name: /worktrees$/ })).not.toBeInTheDocument();
		});

		it('does not show the toggle on worktree child rows', () => {
			render(
				<SessionItem
					{...defaultProps}
					variant="worktree"
					session={createMockSession({ parentSessionId: 'parent-1', worktreeBranch: 'feat/x' })}
					worktreeChildCount={3}
					onToggleWorktrees={vi.fn()}
				/>
			);

			expect(screen.queryByRole('button', { name: /worktrees$/ })).not.toBeInTheDocument();
		});

		it('reflects collapsed state and surfaces the hidden-child count badge', () => {
			render(
				<SessionItem
					{...defaultProps}
					session={createMockSession({ worktreesExpanded: false })}
					worktreeChildCount={5}
					onToggleWorktrees={vi.fn()}
				/>
			);

			const toggle = screen.getByRole('button', { name: 'Expand worktrees' });
			expect(toggle).toHaveAttribute('aria-expanded', 'false');
			expect(screen.getByTitle('5 hidden worktrees')).toHaveTextContent('5');
		});

		it('toggles per parent, passing that parent session id', () => {
			const onToggleWorktrees = vi.fn();
			render(
				<SessionItem
					{...defaultProps}
					session={createMockSession({ id: 'parent-42' })}
					worktreeChildCount={5}
					onToggleWorktrees={onToggleWorktrees}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Collapse worktrees' }));

			expect(onToggleWorktrees).toHaveBeenCalledWith('parent-42');
		});

		it('does not select the agent when the toggle is clicked', () => {
			const onSelect = vi.fn();
			render(
				<SessionItem
					{...defaultProps}
					onSelect={onSelect}
					session={createMockSession()}
					worktreeChildCount={5}
					onToggleWorktrees={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Collapse worktrees' }));

			expect(onSelect).not.toHaveBeenCalled();
		});
	});
});
describe('SessionItemPhone', () => {
	const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

	const session = () =>
		createMockSession({
			name: 'Interplay Companion',
			cwd: '/home/user/project',
			fullPath: '/home/user/project',
			projectRoot: '/home/user/project',
			isGitRepo: true,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } as never,
		});

	const defaultProps = {
		variant: 'flat' as const,
		theme: mockTheme,
		isActive: false,
		isKeyboardSelected: false,
		isDragging: false,
		isEditing: false,
		leftSidebarOpen: true,
		gitFileCount: 4,
		onSelect: vi.fn(),
		onDragStart: vi.fn(),
		onContextMenu: vi.fn(),
		onFinishRename: vi.fn(),
		onStartRename: vi.fn(),
		onToggleBookmark: vi.fn(),
	};

	describe('SessionItem on a phone', () => {
		const initialWorktreeSettings = {
			showWorktreeProvider: useSettingsStore.getState().showWorktreeProvider,
			showWorktreeBranchName: useSettingsStore.getState().showWorktreeBranchName,
		};
		beforeEach(() => {
			useSettingsStore.setState({
				showLeftPanelLocationPills: true,
				showLeftPanelGitIndicator: true,
			});
		});

		afterEach(() => {
			mockedUsePhoneLayout.mockReturnValue(false);
			useSettingsStore.setState(initialWorktreeSettings);
		});

		it('hides worktree providers on a phone while preserving the branch setting', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			useSettingsStore.setState({ showWorktreeProvider: true, showWorktreeBranchName: true });
			render(
				<SessionItem
					{...defaultProps}
					variant="worktree"
					session={createMockSession({ toolType: 'codex', worktreeBranch: 'feat/x' })}
				/>
			);
			expect(screen.queryByText('Codex')).not.toBeInTheDocument();
			expect(screen.getByTitle('feat/x')).toBeInTheDocument();
			expect(screen.queryByText('·')).not.toBeInTheDocument();
		});

		it('keeps the adornments on desktop', () => {
			mockedUsePhoneLayout.mockReturnValue(false);
			render(<SessionItem {...defaultProps} session={session()} />);
			expect(screen.getByText('Interplay Companion')).toBeInTheDocument();
			expect(screen.getByTestId('icon-activity')).toBeInTheDocument();
			expect(screen.getByTestId('icon-bookmark')).toBeInTheDocument();
			expect(screen.getByTestId('icon-server')).toBeInTheDocument();
			expect(screen.getByText('GIT')).toBeInTheDocument();
			expect(screen.getByTestId('icon-git-branch')).toBeInTheDocument();
		});

		it('reduces the row to the name and the status dot on a phone', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			render(<SessionItem {...defaultProps} session={session()} />);
			expect(screen.getByText('Interplay Companion')).toBeInTheDocument();
			// Provider line, bookmark, SSH / GIT pills, git dirty count: all gone.
			expect(screen.queryByTestId('icon-activity')).not.toBeInTheDocument();
			expect(screen.queryByTestId('icon-bookmark')).not.toBeInTheDocument();
			expect(screen.queryByTestId('icon-server')).not.toBeInTheDocument();
			expect(screen.queryByText('GIT')).not.toBeInTheDocument();
			expect(screen.queryByTestId('icon-git-branch')).not.toBeInTheDocument();
			// The two-line grid goes with the meta line it existed for.
			expect(document.querySelector('.session-row')).toBeNull();
		});

		it('still surfaces state that needs attention', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			render(
				<SessionItem
					{...defaultProps}
					isInBatch
					session={createMockSession({
						name: 'Busy One',
						agentError: { message: 'boom', type: 'unknown' } as never,
					})}
				/>
			);
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('ERR')).toBeInTheDocument();
		});
	});
});
describe('SessionTooltipContent', () => {
	const theme: Theme = {
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
		},
	} as Theme;

	const baseSession = (overrides: Partial<Session> = {}): Session =>
		createMockSession({
			cwd: '/home/user/project',
			fullPath: '/home/user/project',
			projectRoot: '/home/user/project',
			isGitRepo: true,
			contextUsage: 30,
			activeTimeMs: 60000,
			...overrides,
		});

	describe('SessionTooltipContent AUTO pill', () => {
		it('renders the AUTO pill when isInBatch is true', () => {
			render(<SessionTooltipContent session={baseSession()} theme={theme} isInBatch={true} />);
			expect(screen.getByText('AUTO')).toBeInTheDocument();
		});

		it('does not apply any pulse animation class to the AUTO pill', () => {
			render(<SessionTooltipContent session={baseSession()} theme={theme} isInBatch={true} />);
			const pill = screen.getByText('AUTO').closest('span');
			expect(pill).not.toBeNull();
			expect(pill?.className).not.toMatch(/animate-(pulse|status-pulse|ping|bounce|spin)/);
		});

		it('does not render the AUTO pill when isInBatch is false', () => {
			render(<SessionTooltipContent session={baseSession()} theme={theme} isInBatch={false} />);
			expect(screen.queryByText('AUTO')).not.toBeInTheDocument();
		});
	});
});
