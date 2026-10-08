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
});
