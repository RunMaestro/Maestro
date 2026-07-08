import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContextMenu } from '../../renderer/components/SessionList/SessionContextMenu';
import type { Group, Session, Theme } from '../../renderer/types';

const hookState = vi.hoisted(() => ({
	clickOutsideHandler: undefined as (() => void) | undefined,
	position: { left: 24, top: 48, ready: true },
}));

vi.mock('../../renderer/hooks', () => ({
	useClickOutside: vi.fn((_ref: unknown, handler: () => void) => {
		hookState.clickOutsideHandler = handler;
	}),
	useContextMenuPosition: vi.fn(() => hookState.position),
}));

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#101010',
		bgActivity: '#181818',
		border: '#303030',
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

const createSession = (overrides: Partial<Session> = {}): Session => ({
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
});

const groups: Group[] = [
	{ id: 'group-1', name: 'Build', emoji: 'B', collapsed: false },
	{ id: 'group-2', name: 'Review', emoji: 'R', collapsed: false },
];

const createCallbacks = () => ({
	onConfigureWorktrees: vi.fn(),
	onCreateGroup: vi.fn(),
	onCreatePR: vi.fn(),
	onDelete: vi.fn(),
	onDeleteWorktree: vi.fn(),
	onDismiss: vi.fn(),
	onDuplicate: vi.fn(),
	onEdit: vi.fn(),
	onMoveToGroup: vi.fn(),
	onQuickCreateWorktree: vi.fn(),
	onRename: vi.fn(),
	onToggleBookmark: vi.fn(),
});

function renderMenu(
	props: Partial<React.ComponentProps<typeof SessionContextMenu>> = {},
	callbacks = createCallbacks()
) {
	render(
		<SessionContextMenu
			x={12}
			y={18}
			theme={theme}
			session={createSession(props.session ? props.session : undefined)}
			groups={groups}
			hasWorktreeChildren={false}
			{...callbacks}
			{...props}
		/>
	);

	return callbacks;
}

function openMoveSubmenu() {
	const wrapper = screen.getByText('Move to Group').closest('[tabindex="0"]');
	if (!wrapper) throw new Error('Move to Group wrapper not found');
	vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
		bottom: 520,
		height: 28,
		left: 700,
		right: 790,
		top: 500,
		width: 90,
		x: 700,
		y: 500,
		toJSON: () => ({}),
	});
	fireEvent.mouseEnter(wrapper);
	return wrapper as HTMLElement;
}

describe('SessionContextMenu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hookState.clickOutsideHandler = undefined;
		hookState.position = { left: 24, top: 48, ready: true };
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 520 });
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 820 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs primary parent-session actions and dismisses after each click', () => {
		const callbacks = renderMenu({
			session: createSession({ bookmarked: false }),
			onCreatePR: undefined,
			onDeleteWorktree: undefined,
			onQuickCreateWorktree: undefined,
			onConfigureWorktrees: undefined,
			onCreateGroup: undefined,
		});

		fireEvent.click(screen.getByRole('button', { name: /Rename/i }));
		fireEvent.click(screen.getByRole('button', { name: /Edit Agent/i }));
		fireEvent.click(screen.getByRole('button', { name: /Duplicate/i }));
		fireEvent.click(screen.getByRole('button', { name: /Add Bookmark/i }));
		fireEvent.click(screen.getByRole('button', { name: /Remove Agent/i }));

		expect(callbacks.onRename).toHaveBeenCalledTimes(1);
		expect(callbacks.onEdit).toHaveBeenCalledTimes(1);
		expect(callbacks.onDuplicate).toHaveBeenCalledTimes(1);
		expect(callbacks.onToggleBookmark).toHaveBeenCalledTimes(1);
		expect(callbacks.onDelete).toHaveBeenCalledTimes(1);
		expect(callbacks.onDismiss).toHaveBeenCalledTimes(5);
	});

	it('renders bookmarked parent sessions with remove-bookmark action', () => {
		const callbacks = renderMenu({
			session: createSession({ bookmarked: true }),
			onCreatePR: undefined,
			onDeleteWorktree: undefined,
			onQuickCreateWorktree: undefined,
			onConfigureWorktrees: undefined,
			onCreateGroup: undefined,
		});

		const bookmarkButton = screen.getByRole('button', { name: /Remove Bookmark/i });

		fireEvent.click(bookmarkButton);

		expect(callbacks.onToggleBookmark).toHaveBeenCalledTimes(1);
		expect(callbacks.onDismiss).toHaveBeenCalledTimes(1);
	});

	it('opens the move submenu, handles disabled current groups, and creates groups', () => {
		const callbacks = renderMenu({
			session: createSession({ groupId: 'group-1' }),
		});

		const wrapper = openMoveSubmenu();

		expect(screen.getByRole('button', { name: /Build.*current/i })).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: /^Ungrouped/i }));
		fireEvent.click(screen.getByRole('button', { name: /Review/i }));
		fireEvent.click(screen.getByRole('button', { name: /Create New Group/i }));

		expect(callbacks.onMoveToGroup).toHaveBeenNthCalledWith(1, '');
		expect(callbacks.onMoveToGroup).toHaveBeenNthCalledWith(2, 'group-2');
		expect(callbacks.onCreateGroup).toHaveBeenCalledTimes(1);
		expect(callbacks.onDismiss).toHaveBeenCalledTimes(3);

		fireEvent.keyDown(wrapper, { key: 'Escape' });
		expect(screen.queryByRole('button', { name: /Create New Group/i })).not.toBeInTheDocument();
	});

	it('supports keyboard opening and disables Ungrouped for ungrouped sessions', () => {
		renderMenu({
			session: createSession({ groupId: undefined }),
			groups: [],
			onCreateGroup: undefined,
		});

		const wrapper = screen.getByText('Move to Group').closest('[tabindex="0"]');
		if (!wrapper) throw new Error('Move to Group wrapper not found');

		fireEvent.keyDown(wrapper, { key: ' ' });

		expect(screen.getByRole('button', { name: /^Ungrouped/i })).toBeDisabled();
		expect(screen.queryByRole('button', { name: /Create New Group/i })).not.toBeInTheDocument();
	});

	it('lets Escape bubble to dismiss when the move submenu is closed', () => {
		const callbacks = renderMenu();
		const wrapper = screen.getByText('Move to Group').closest('[tabindex="0"]');
		if (!wrapper) throw new Error('Move to Group wrapper not found');

		fireEvent.keyDown(wrapper, { key: 'Escape' });

		expect(callbacks.onDismiss).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('button', { name: /Create New Group/i })).not.toBeInTheDocument();
	});

	it('clears pending submenu close timers on hover and unmount', () => {
		vi.useFakeTimers();
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const { unmount } = render(
			<SessionContextMenu
				x={12}
				y={18}
				theme={theme}
				session={createSession()}
				groups={groups}
				hasWorktreeChildren={false}
				{...createCallbacks()}
			/>
		);

		const wrapper = openMoveSubmenu();
		fireEvent.mouseLeave(wrapper);
		fireEvent.mouseEnter(wrapper);
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
		fireEvent.mouseLeave(wrapper);
		fireEvent.mouseLeave(wrapper);
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

		unmount();
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(3);
		clearTimeoutSpy.mockRestore();
	});

	it('closes the move submenu after the delayed mouse-leave timeout', () => {
		vi.useFakeTimers();
		renderMenu();

		const wrapper = openMoveSubmenu();
		expect(screen.getByRole('button', { name: /Create New Group/i })).toBeInTheDocument();

		fireEvent.mouseLeave(wrapper);
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(screen.queryByRole('button', { name: /Create New Group/i })).not.toBeInTheDocument();
	});

	it('renders parent worktree actions only when supported', () => {
		const callbacks = renderMenu({
			hasWorktreeChildren: true,
			session: createSession({
				isGitRepo: true,
				worktreeConfig: { baseBranch: 'main' } as Session['worktreeConfig'],
			}),
		});

		fireEvent.click(screen.getByRole('button', { name: /Create Worktree/i }));
		fireEvent.click(screen.getByRole('button', { name: /Configure Worktrees/i }));

		expect(callbacks.onQuickCreateWorktree).toHaveBeenCalledTimes(1);
		expect(callbacks.onConfigureWorktrees).toHaveBeenCalledTimes(1);
		expect(callbacks.onDismiss).toHaveBeenCalledTimes(2);
	});

	it('renders configure worktrees without quick-create when only configuration is available', () => {
		renderMenu({
			session: createSession({ isGitRepo: true, worktreeConfig: undefined }),
			onQuickCreateWorktree: undefined,
		});

		expect(screen.queryByRole('button', { name: /Create Worktree/i })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Configure Worktrees/i })).toBeInTheDocument();
	});

	it('keeps the menu hidden until positioning is ready', () => {
		hookState.position = { left: 24, top: 48, ready: false };

		const { container } = render(
			<SessionContextMenu
				x={12}
				y={18}
				theme={theme}
				session={createSession()}
				groups={groups}
				hasWorktreeChildren={false}
				{...createCallbacks()}
			/>
		);

		expect(container.firstElementChild).toHaveStyle({ opacity: '0' });
	});

	it('renders child worktree actions without parent-only actions', () => {
		const callbacks = renderMenu({
			session: createSession({
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature/context-menu',
			}),
		});

		expect(screen.queryByRole('button', { name: /Add Bookmark/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Move to Group/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Remove Agent/i })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Create Pull Request/i }));
		fireEvent.click(screen.getByRole('button', { name: /Remove Worktree/i }));

		expect(callbacks.onCreatePR).toHaveBeenCalledTimes(1);
		expect(callbacks.onDeleteWorktree).toHaveBeenCalledTimes(1);
		expect(callbacks.onDismiss).toHaveBeenCalledTimes(2);
	});

	it('omits child worktree action section when no child worktree callbacks are provided', () => {
		renderMenu({
			session: createSession({
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature/no-actions',
			}),
			onCreatePR: undefined,
			onDeleteWorktree: undefined,
		});

		expect(screen.queryByRole('button', { name: /Create Pull Request/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Remove Worktree/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Remove Agent/i })).not.toBeInTheDocument();
	});

	it('dismisses on Escape and click outside', () => {
		const callbacks = renderMenu();

		fireEvent.keyDown(document, { key: 'Escape' });
		act(() => {
			hookState.clickOutsideHandler?.();
		});

		expect(callbacks.onDismiss).toHaveBeenCalledTimes(2);
	});
});
