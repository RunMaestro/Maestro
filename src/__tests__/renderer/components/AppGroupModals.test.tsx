import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppGroupModals } from '../../../renderer/components/AppModals';
import type { Theme } from '../../../renderer/types';

vi.mock('../../../renderer/components/CreateGroupModal', () => ({
	CreateGroupModal: (props: any) => <div data-testid="create-group-modal" />,
}));
vi.mock('../../../renderer/components/RenameGroupModal', () => ({
	RenameGroupModal: (props: any) => <div data-testid="rename-group-modal" />,
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
	onCloseRenameGroupModal: vi.fn(),
};

describe('AppGroupModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
});
