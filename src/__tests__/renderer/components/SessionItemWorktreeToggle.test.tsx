/**
 * @fileoverview Tests for the SessionItem worktree collapse/expand chevron.
 *
 * Regression coverage for #1292: the chevron used to be gated purely on
 * `session.worktreeConfig`. Several spawn paths (Auto Run worktree dispatch,
 * quick-create, watcher discovery) attach children via `parentSessionId`
 * without writing `worktreeConfig` on the parent, so those parents rendered an
 * always-visible subtree with no way to collapse it. The toggle must appear
 * whenever the parent actually has worktree children.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import type { Session, Theme } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

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

	it('shows the toggle for a parent that has worktreeConfig', () => {
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
