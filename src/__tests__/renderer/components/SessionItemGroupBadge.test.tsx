/**
 * @fileoverview Tests for the group pill on a bookmarked agent's row.
 *
 * The pill text comes from `groupBadgeLabel(group)`: the group's own
 * `shortLabel` when the user set one, otherwise the automatic abbreviation of
 * the group name. The override replaces the ABBREVIATED text only. With
 * `showFullGroupLabelInBookmarks` on the pill still shows the real name, and
 * the `title` is the full group name in every mode, so the pill is always
 * decodable on hover whatever the user typed into it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { usePhoneLayout } from '../../../renderer/hooks/ui/useViewportBreakpoint';
import type { Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

const GROUP_NAME = '[1] Aleyemma/Money-Sessions';

const group = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: GROUP_NAME,
	emoji: '💰',
	collapsed: false,
	...overrides,
});

const session = () =>
	createMockSession({
		name: 'Ledger',
		cwd: '/home/user/project',
		fullPath: '/home/user/project',
		projectRoot: '/home/user/project',
		groupId: 'group-1',
		bookmarked: true,
	});

const defaultProps = {
	variant: 'bookmark' as const,
	theme: mockTheme,
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

const pill = () => document.querySelector('.row-group-chip');

describe('SessionItem group pill', () => {
	beforeEach(() => {
		useSettingsStore.setState({
			showGroupLabelInBookmarks: true,
			showFullGroupLabelInBookmarks: false,
		});
	});

	afterEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
	});

	it('draws the automatic abbreviation when the group has no shortLabel', () => {
		render(<SessionItem {...defaultProps} session={session()} group={group()} />);
		expect(pill()).toHaveTextContent('AMS');
		expect(pill()).toHaveAttribute('title', GROUP_NAME);
	});

	it('draws the shortLabel, and keeps the full group name as the title', () => {
		render(
			<SessionItem {...defaultProps} session={session()} group={group({ shortLabel: 'Money' })} />
		);
		expect(pill()).toHaveTextContent('Money');
		expect(pill()).not.toHaveTextContent('AMS');
		expect(pill()).toHaveAttribute('title', GROUP_NAME);
	});

	it('falls back to the abbreviation for a whitespace-only shortLabel', () => {
		render(
			<SessionItem {...defaultProps} session={session()} group={group({ shortLabel: '   ' })} />
		);
		expect(pill()).toHaveTextContent('AMS');
	});

	it('shows the real group name, not the shortLabel, when full labels are on', () => {
		useSettingsStore.setState({ showFullGroupLabelInBookmarks: true });
		// A label that is not a substring of the name, so the negative assertion means something.
		render(
			<SessionItem {...defaultProps} session={session()} group={group({ shortLabel: 'Payroll' })} />
		);
		expect(pill()).toHaveTextContent(GROUP_NAME);
		expect(pill()).not.toHaveTextContent('Payroll');
		expect(pill()).toHaveAttribute('title', GROUP_NAME);
	});

	it('draws no pill when group labels are off, shortLabel or not', () => {
		useSettingsStore.setState({ showGroupLabelInBookmarks: false });
		render(
			<SessionItem {...defaultProps} session={session()} group={group({ shortLabel: 'Money' })} />
		);
		expect(pill()).toBeNull();
	});

	it('draws no pill outside the bookmark variant', () => {
		render(
			<SessionItem
				{...defaultProps}
				variant="flat"
				session={session()}
				group={group({ shortLabel: 'Money' })}
			/>
		);
		expect(pill()).toBeNull();
	});

	it('draws no pill on a phone', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		render(
			<SessionItem {...defaultProps} session={session()} group={group({ shortLabel: 'Money' })} />
		);
		expect(pill()).toBeNull();
	});
});
