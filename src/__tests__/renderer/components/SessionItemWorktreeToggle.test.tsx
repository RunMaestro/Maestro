/**
 * @fileoverview Tests for the SessionItem worktree collapse/expand chevron.
 *
 * Regression coverage for #1292: the chevron used to be gated purely on
 * `session.worktreeConfig`. Several spawn paths (Auto Run worktree dispatch,
 * quick-create, watcher discovery) attach children via `parentSessionId`
 * without writing `worktreeConfig` on the parent, so those parents rendered an
 * always-visible subtree with no way to collapse it. The toggle must appear
 * whenever the parent actually has worktree children.
 *
 * And for #1616, the other half of the same rule: `worktreeConfig` is a
 * persistent per-agent setting that survives the last worktree being removed,
 * so a parent whose children are gone must NOT keep a chevron over an empty
 * subtree. The live child count is the only input.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Session, Theme } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

const { prState } = vi.hoisted(() => ({
	prState: { current: {} as Record<string, unknown>, refresh: vi.fn() },
}));
vi.mock('../../../renderer/hooks/worktree/useWorktreePullRequest', () => ({
	useWorktreePullRequest: () => ({ loading: false, refresh: prState.refresh, ...prState.current }),
}));
vi.mock('../../../renderer/utils/openUrl', () => ({ openUrl: vi.fn() }));

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

describe('worktree PR summary', () => {
	it('opens accessible details with PR, checks and local divergence', () => {
		const onSelect = vi.fn();
		prState.current = {
			snapshot: {
				discovery: {
					status: 'found',
					pullRequest: {
						identity: { number: 42 },
						title: 'Example',
						url: 'https://github.com/a/b/pull/42',
						state: 'OPEN',
						isDraft: true,
						baseBranch: 'rc',
					},
				},
				ci: {
					status: 'available',
					checkedAt: '2026-11-04T10:00:00Z',
					checks: [
						{
							kind: 'check-run',
							id: '1',
							name: 'Build',
							state: 'failed',
							detailsUrl: 'https://github.com/a/b/actions/runs/1',
							updatedAt: '2026-11-04T10:00:00Z',
						},
					],
				},
				divergence: { status: 'different', ahead: 2, behind: 1 },
			},
		};
		render(
			<LayerStackProvider>
				<SessionItem
					{...defaultProps}
					variant="worktree"
					session={createMockSession()}
					onSelect={onSelect}
				/>
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Show PR and CI details' }));
		expect(screen.getByRole('dialog', { name: 'Worktree PR and CI' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'PR #42: Example' })).toHaveAttribute(
			'href',
			'https://github.com/a/b/pull/42'
		);
		expect(screen.getByText(/OPEN · Draft · Base: rc/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Build' })).toHaveAttribute(
			'href',
			'https://github.com/a/b/actions/runs/1'
		);
		expect(screen.getByText(/2 ahead, 1 behind/)).toBeInTheDocument();
		expect(onSelect).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
	it.each(['authentication required', 'offline'])(
		'shows %s as unavailable rather than no PR',
		(message) => {
			prState.current = {
				snapshot: { discovery: { status: 'unavailable', reason: 'gh', message } },
			};
			render(<SessionItem {...defaultProps} variant="worktree" session={createMockSession()} />);
			expect(screen.getByRole('button', { name: /unavailable/i })).toHaveAttribute(
				'title',
				expect.stringContaining(message)
			);
			expect(screen.queryByRole('button', { name: /No PR/ })).not.toBeInTheDocument();
		}
	);

	it('updates check details while the dialog remains open', () => {
		const check = {
			kind: 'check-run',
			id: '1',
			name: 'Build',
			state: 'pending',
			detailsUrl: null,
			updatedAt: null,
		};
		prState.current = {
			snapshot: {
				discovery: {
					status: 'found',
					pullRequest: {
						identity: { number: 42 },
						title: 'Example',
						url: 'https://github.com/a/b/pull/42',
						state: 'OPEN',
						baseBranch: 'rc',
					},
				},
				ci: { status: 'available', checkedAt: '2026-11-04T10:00:00Z', checks: [check] },
			},
		};
		const session = createMockSession();
		const view = () => (
			<LayerStackProvider>
				<SessionItem {...defaultProps} variant="worktree" session={{ ...session }} />
			</LayerStackProvider>
		);
		const { rerender } = render(view());
		fireEvent.click(screen.getByRole('button', { name: 'Show PR and CI details' }));
		expect(screen.getByText(/Build/).parentElement).toHaveTextContent('pending');
		check.state = 'passed';
		rerender(view());
		expect(screen.getByText(/Build/).parentElement).toHaveTextContent('passed');
		check.state = 'failed';
		rerender(view());
		expect(screen.getByText(/Build/).parentElement).toHaveTextContent('failed');
	});
	it('shows CI transitions and refreshes without selecting the worktree', () => {
		const onSelect = vi.fn();
		const session = createMockSession({ worktreeBranch: 'feat/x' });
		const snapshot = {
			discovery: { status: 'found', pullRequest: { identity: { number: 42 }, state: 'OPEN' } },
			ci: { status: 'available', checks: [{ state: 'pending' }] },
		};
		prState.current = { snapshot };
		const { rerender } = render(
			<SessionItem {...defaultProps} variant="worktree" session={session} onSelect={onSelect} />
		);
		expect(screen.getByRole('button', { name: /PR #42 OPEN, CI pending/ })).toBeInTheDocument();
		snapshot.ci.checks[0].state = 'passed';
		rerender(
			<SessionItem
				{...defaultProps}
				variant="worktree"
				session={{ ...session }}
				onSelect={onSelect}
			/>
		);
		expect(screen.getByRole('button', { name: /CI passed/ })).toBeInTheDocument();
		snapshot.ci.checks[0].state = 'failed';
		rerender(
			<SessionItem
				{...defaultProps}
				variant="worktree"
				session={{ ...session }}
				onSelect={onSelect}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: /CI failed/ }));
		expect(prState.refresh).toHaveBeenCalled();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('keeps keyboard actions on the PR controls from selecting the worktree', () => {
		const onSelect = vi.fn();
		prState.refresh.mockClear();
		prState.current = { snapshot: { discovery: { status: 'no-pr' } } };
		render(
			<LayerStackProvider>
				<SessionItem
					{...defaultProps}
					variant="worktree"
					session={createMockSession()}
					onSelect={onSelect}
				/>
			</LayerStackProvider>
		);
		const refresh = screen.getByRole('button', { name: /No PR/ });
		refresh.focus();
		fireEvent.keyDown(refresh, { key: 'Enter' });
		fireEvent.click(refresh);
		expect(prState.refresh).toHaveBeenCalledOnce();
		const details = screen.getByRole('button', { name: 'Show PR and CI details' });
		details.focus();
		fireEvent.keyDown(details, { key: ' ' });
		fireEvent.click(details);
		expect(screen.getByRole('dialog', { name: 'Worktree PR and CI' })).toBeInTheDocument();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('distinguishes no PR, unknown CI and stale data', () => {
		const session = createMockSession();
		prState.current = { snapshot: { discovery: { status: 'no-pr' } } };
		const { rerender } = render(
			<SessionItem {...defaultProps} variant="worktree" session={session} />
		);
		expect(screen.getByRole('button', { name: /No PR/ })).toBeInTheDocument();
		prState.current = {
			snapshot: {
				discovery: { status: 'found', pullRequest: { identity: { number: 7 }, state: 'OPEN' } },
			},
		};
		rerender(<SessionItem {...defaultProps} variant="worktree" session={{ ...session }} />);
		expect(screen.getByRole('button', { name: /CI unknown/ })).toBeInTheDocument();
		prState.current = { ...prState.current, stale: true, error: 'offline' };
		rerender(<SessionItem {...defaultProps} variant="worktree" session={{ ...session }} />);
		expect(screen.getByRole('button', { name: /PR status stale: offline/ })).toBeInTheDocument();
	});
});
