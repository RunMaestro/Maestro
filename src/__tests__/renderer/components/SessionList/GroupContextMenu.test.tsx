import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupContextMenu } from '../../../../renderer/components/SessionList/GroupContextMenu';
import { mockTheme } from '../../../helpers/mockTheme';

const group = { id: 'g1', name: 'Maestro', emoji: '🎹', collapsed: false } as any;

function setup(overrides: Record<string, unknown> = {}) {
	const props = {
		x: 0,
		y: 0,
		theme: mockTheme,
		group,
		groupsPlusEnabled: true,
		memberCount: 0,
		onRename: vi.fn(),
		onNewAgent: vi.fn(),
		onDelete: vi.fn(),
		eligibleParentGroups: [],
		onMoveInto: vi.fn(),
		onMoveToTopLevel: vi.fn(),
		onNewGroupInside: vi.fn(),
		onDismiss: vi.fn(),
		...overrides,
	};
	render(<GroupContextMenu {...(props as any)} />);
	return props;
}

describe('GroupContextMenu', () => {
	it('does not render a Change Emoji option (emoji is changed via Rename)', () => {
		setup();
		expect(screen.queryByText('Change Emoji...')).toBeNull();
		// Rename is always present.
		expect(screen.getByText('Rename Group...')).toBeTruthy();
	});

	it('lists New Agent in Group first, above Rename', () => {
		setup();
		const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim());
		expect(labels[0]).toBe('New Agent in Group...');
		expect(labels[1]).toBe('Rename Group...');
	});

	it('lists Import Agent right below New Agent in Group, and fires it', () => {
		const onImportAgent = vi.fn();
		const props = setup({ onImportAgent });
		const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim());
		expect(labels.slice(0, 3)).toEqual([
			'New Agent in Group...',
			'Import Agent...',
			'Rename Group...',
		]);
		fireEvent.click(screen.getByText('Import Agent...'));
		expect(onImportAgent).toHaveBeenCalledTimes(1);
		expect(props.onDismiss).toHaveBeenCalled();
	});

	it('omits Import Agent when no handler is given', () => {
		setup();
		expect(screen.queryByText('Import Agent...')).toBeNull();
	});

	it('honors deleteLabel override and fires onDelete', () => {
		const props = setup({ memberCount: 3, deleteLabel: 'Delete Group' });
		fireEvent.click(screen.getByText('Delete Group'));
		expect(props.onDelete).toHaveBeenCalledTimes(1);
		// Falls back to default label when no override and members exist.
		expect(screen.queryByText('Remove Group and Agents')).toBeNull();
	});

	it('omits the delete button entirely when onDelete is not provided', () => {
		setup({ onDelete: undefined });
		expect(screen.queryByText('Delete Group')).toBeNull();
		expect(screen.queryByText('Remove Group and Agents')).toBeNull();
	});

	it('lists eligible root folders in its Move into submenu', () => {
		const props = setup({
			eligibleParentGroups: [{ id: 'parent', name: 'Company', emoji: '🏢', collapsed: false }],
		});

		const moveIntoButton = screen.getByRole('button', { name: 'Move into...' });
		expect(moveIntoButton).toHaveAttribute('aria-expanded', 'false');

		fireEvent.click(moveIntoButton);
		expect(moveIntoButton).toHaveAttribute('aria-expanded', 'true');
		fireEvent.click(screen.getByText('Company'));

		expect(props.onMoveInto).toHaveBeenCalledWith('parent');
	});

	it('offers top-level and nested creation actions for child and root groups', () => {
		const childProps = setup({
			group: { ...group, parentGroupId: 'parent' },
		});
		fireEvent.click(screen.getByText('Move to top level'));
		expect(childProps.onMoveToTopLevel).toHaveBeenCalledTimes(1);

		const rootProps = setup();
		fireEvent.click(screen.getByText('New group inside...'));
		expect(rootProps.onNewGroupInside).toHaveBeenCalledTimes(1);
	});

	it('hides hierarchy actions while Groups+ is disabled', () => {
		setup({
			groupsPlusEnabled: false,
			group: { ...group, parentGroupId: 'parent' },
			eligibleParentGroups: [{ id: 'parent', name: 'Company', emoji: '🏢', collapsed: false }],
		});

		expect(screen.queryByText('Move into...')).not.toBeInTheDocument();
		expect(screen.queryByText('Move to top level')).not.toBeInTheDocument();
		expect(screen.queryByText('New group inside...')).not.toBeInTheDocument();
	});

	describe('Group Settings', () => {
		it('sits between Rename and nested group creation for a user group', () => {
			setup({ onGroupSettings: vi.fn() });
			const labels = screen.getAllByRole('button').map((button) => button.textContent);
			const at = labels.indexOf('Group Settings...');
			expect(labels[at - 1]).toBe('Rename Group...');
			expect(labels[at + 1]).toBe('New group inside...');
		});

		it('opens Group Settings and dismisses the menu', () => {
			const onGroupSettings = vi.fn();
			const props = setup({ onGroupSettings });
			fireEvent.click(screen.getByText('Group Settings...'));
			expect(onGroupSettings).toHaveBeenCalledTimes(1);
			expect(props.onDismiss).toHaveBeenCalledTimes(1);
		});

		it('is shown for a group marked as a user group', () => {
			setup({ onGroupSettings: vi.fn(), group: { ...group, kind: 'user' } });
			expect(screen.getByText('Group Settings...')).toBeInTheDocument();
		});

		it('is hidden for a worktree group, by kind or by the worktree emoji', () => {
			setup({ onGroupSettings: vi.fn(), group: { ...group, kind: 'worktree' } });
			expect(screen.queryByText('Group Settings...')).not.toBeInTheDocument();

			setup({ onGroupSettings: vi.fn(), group: { ...group, emoji: '🌳' } });
			expect(screen.queryByText('Group Settings...')).not.toBeInTheDocument();
			// The rest of the menu is still there.
			expect(screen.getAllByText('Rename Group...')).toHaveLength(2);
		});

		it('is hidden when the host passes no handler', () => {
			setup();
			expect(screen.queryByText('Group Settings...')).not.toBeInTheDocument();
		});
	});

	describe('Delegation Graph', () => {
		it('sits after Group Settings and before nested group creation', () => {
			setup({ onGroupSettings: vi.fn(), onOpenDelegationGraph: vi.fn() });
			const labels = screen.getAllByRole('button').map((button) => button.textContent);
			const at = labels.indexOf('Delegation Graph');
			expect(labels[at - 1]).toBe('Group Settings...');
			expect(labels[at + 1]).toBe('New group inside...');
		});

		it('opens the graph and dismisses the menu', () => {
			const onOpenDelegationGraph = vi.fn();
			const props = setup({ onOpenDelegationGraph });
			fireEvent.click(screen.getByText('Delegation Graph'));
			expect(onOpenDelegationGraph).toHaveBeenCalledTimes(1);
			expect(props.onDismiss).toHaveBeenCalledTimes(1);
		});

		it('is offered for a worktree group, which has no Group Settings', () => {
			setup({
				onGroupSettings: vi.fn(),
				onOpenDelegationGraph: vi.fn(),
				group: { ...group, kind: 'worktree' },
			});
			expect(screen.getByText('Delegation Graph')).toBeInTheDocument();
			expect(screen.queryByText('Group Settings...')).not.toBeInTheDocument();
		});

		it('is hidden when the host passes no handler', () => {
			setup();
			expect(screen.queryByText('Delegation Graph')).not.toBeInTheDocument();
		});
	});

	describe('Move Group to Window', () => {
		const targets = [
			{ windowId: 'p', isMain: true, windowNumber: 1, label: 'Main Window', isCurrentOwner: true },
			{ windowId: 'w2', isMain: false, windowNumber: 2, label: 'Window 2', isCurrentOwner: false },
		];

		it('is hidden in a single-window app', () => {
			setup({ onMoveToNewWindow: vi.fn(), onMoveToWindow: vi.fn(), windowTargets: [] });
			expect(screen.queryByText('Move Group to Window...')).not.toBeInTheDocument();
		});

		it('shows even when this window holds none of the group (memberCount 0)', () => {
			setup({
				memberCount: 0,
				windowTargets: targets,
				onMoveToNewWindow: vi.fn(),
				onMoveToWindow: vi.fn(),
			});
			expect(screen.getByText('Move Group to Window...')).toBeInTheDocument();
		});

		it('moves to a new or existing window and disables the window holding all of it', () => {
			const props = setup({
				windowTargets: targets,
				onMoveToNewWindow: vi.fn(),
				onMoveToWindow: vi.fn(),
			});
			fireEvent.click(screen.getByText('Move Group to Window...'));
			expect(screen.getByText('Main Window').closest('button')).toBeDisabled();
			fireEvent.click(screen.getByText('Window 2'));
			expect(props.onMoveToWindow).toHaveBeenCalledWith('w2');
			expect(props.onDismiss).toHaveBeenCalled();
		});

		it('offers New Window', () => {
			const props = setup({
				windowTargets: targets,
				onMoveToNewWindow: vi.fn(),
				onMoveToWindow: vi.fn(),
			});
			fireEvent.click(screen.getByText('Move Group to Window...'));
			fireEvent.click(screen.getByText('New Window'));
			expect(props.onMoveToNewWindow).toHaveBeenCalledTimes(1);
		});
	});
});
