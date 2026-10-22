import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AppGroupModals } from '../../../renderer/components/AppModals';
import { getModalActions, useModalStore } from '../../../renderer/stores/modalStore';
import type { Group, Theme } from '../../../renderer/types';

vi.mock('../../../renderer/components/CreateGroupModal', () => ({
	CreateGroupModal: (props: any) => <div data-testid="create-group-modal" />,
}));
vi.mock('../../../renderer/components/RenameGroupModal', () => ({
	RenameGroupModal: (props: any) => <div data-testid="rename-group-modal" />,
}));
vi.mock('../../../renderer/components/GroupSettingsModal', () => ({
	GroupSettingsModal: (props: any) => (
		<div data-testid="group-settings-modal" data-group-id={props.group.id}>
			<button type="button" onClick={props.onClose}>
				close group settings
			</button>
		</div>
	),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

const backendGroup: Group = { id: 'group-1', name: 'Backend', emoji: '🌳', collapsed: false };
const docsGroup: Group = { id: 'group-2', name: 'Docs', emoji: '📚', collapsed: false };

const defaultProps = {
	theme: testTheme,
	groups: [],
	setGroups: vi.fn(),
	createGroupModalOpen: false,
	onCloseCreateGroupModal: vi.fn(),
	renameGroupModalOpen: false,
	renameGroupId: null,
	renameGroupValue: '',
	setRenameGroupValue: vi.fn(),
	renameGroupEmoji: '',
	setRenameGroupEmoji: vi.fn(),
	renameGroupIcon: undefined,
	setRenameGroupIcon: vi.fn(),
	renameGroupColor: undefined,
	setRenameGroupColor: vi.fn(),
	onCloseRenameGroupModal: vi.fn(),
};

describe('AppGroupModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useModalStore.setState({ modals: new Map() });
	});

	it('does not render any modals when all booleans are false', () => {
		const { container } = render(<AppGroupModals {...defaultProps} />);
		expect(screen.queryByTestId('create-group-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-group-modal')).not.toBeInTheDocument();
	});

	it('renders CreateGroupModal when createGroupModalOpen is true', () => {
		render(<AppGroupModals {...defaultProps} createGroupModalOpen={true} />);
		expect(screen.getByTestId('create-group-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('rename-group-modal')).not.toBeInTheDocument();
	});

	it('renders RenameGroupModal when renameGroupModalOpen is true and renameGroupId is set', () => {
		render(
			<AppGroupModals {...defaultProps} renameGroupModalOpen={true} renameGroupId="group-1" />
		);
		expect(screen.getByTestId('rename-group-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('create-group-modal')).not.toBeInTheDocument();
	});

	it('does not render RenameGroupModal when renameGroupId is null', () => {
		render(<AppGroupModals {...defaultProps} renameGroupModalOpen={true} renameGroupId={null} />);
		expect(screen.queryByTestId('rename-group-modal')).not.toBeInTheDocument();
	});

	describe('GroupSettingsModal', () => {
		const groups = [backendGroup, docsGroup];

		it('does not render while the modal store has it closed', () => {
			render(<AppGroupModals {...defaultProps} groups={groups} />);
			expect(screen.queryByTestId('group-settings-modal')).not.toBeInTheDocument();
		});

		it('renders for the group the modal store names', () => {
			getModalActions().openGroupSettings('group-2');
			render(<AppGroupModals {...defaultProps} groups={groups} />);

			expect(screen.getByTestId('group-settings-modal')).toHaveAttribute(
				'data-group-id',
				'group-2'
			);
			expect(screen.queryByTestId('rename-group-modal')).not.toBeInTheDocument();
		});

		it('opens after the first render, when the store changes', () => {
			render(<AppGroupModals {...defaultProps} groups={groups} />);
			act(() => getModalActions().openGroupSettings('group-1'));

			expect(screen.getByTestId('group-settings-modal')).toHaveAttribute(
				'data-group-id',
				'group-1'
			);
		});

		it('does not render for a group that does not exist', () => {
			getModalActions().openGroupSettings('gone');
			render(<AppGroupModals {...defaultProps} groups={groups} />);

			expect(screen.queryByTestId('group-settings-modal')).not.toBeInTheDocument();
			// The store must not go on reporting a modal nobody can see.
			expect(useModalStore.getState().isOpen('groupSettings')).toBe(false);
		});

		it('goes away when its group is deleted while it is open', () => {
			getModalActions().openGroupSettings('group-1');
			const { rerender } = render(<AppGroupModals {...defaultProps} groups={groups} />);
			expect(screen.getByTestId('group-settings-modal')).toBeInTheDocument();

			rerender(<AppGroupModals {...defaultProps} groups={[docsGroup]} />);
			expect(screen.queryByTestId('group-settings-modal')).not.toBeInTheDocument();
			expect(useModalStore.getState().isOpen('groupSettings')).toBe(false);
		});

		it('closes through the modal store', () => {
			getModalActions().openGroupSettings('group-1');
			render(<AppGroupModals {...defaultProps} groups={groups} />);

			act(() => screen.getByText('close group settings').click());

			expect(useModalStore.getState().isOpen('groupSettings')).toBe(false);
			expect(screen.queryByTestId('group-settings-modal')).not.toBeInTheDocument();
		});
	});
});
