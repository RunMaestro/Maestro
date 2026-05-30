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
		memberCount: 0,
		onRename: vi.fn(),
		onChangeEmoji: vi.fn(),
		onNewAgent: vi.fn(),
		onDelete: vi.fn(),
		onDismiss: vi.fn(),
		...overrides,
	};
	render(<GroupContextMenu {...(props as any)} />);
	return props;
}

describe('GroupContextMenu', () => {
	it('renders Change Emoji when onChangeEmoji is provided and fires it (plus dismiss)', () => {
		const props = setup();
		fireEvent.click(screen.getByText('Change Emoji...'));
		expect(props.onChangeEmoji).toHaveBeenCalledTimes(1);
		expect(props.onDismiss).toHaveBeenCalledTimes(1);
	});

	it('omits Change Emoji when onChangeEmoji is not provided', () => {
		setup({ onChangeEmoji: undefined });
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
});
