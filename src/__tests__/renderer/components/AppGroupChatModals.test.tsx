import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppGroupChatModals } from '../../../renderer/components/AppModals';
import type { Theme, GroupChat } from '../../../renderer/types';

vi.mock('../../../renderer/components/GroupChatModal', () => ({
	GroupChatModal: (props: any) => <div data-testid={`group-chat-modal-${props.mode}`} />,
}));
vi.mock('../../../renderer/components/DeleteGroupChatModal', () => ({
	DeleteGroupChatModal: (props: any) => <div data-testid="delete-group-chat-modal" />,
}));
vi.mock('../../../renderer/components/RenameGroupChatModal', () => ({
	RenameGroupChatModal: (props: any) => <div data-testid="rename-group-chat-modal" />,
}));
vi.mock('../../../renderer/components/GroupChatInfoOverlay', () => ({
	GroupChatInfoOverlay: (props: any) => <div data-testid="group-chat-info-overlay" />,
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

const mockGroupChat: GroupChat = {
	id: 'gc-1',
	name: 'Test Group Chat',
	moderatorAgentId: 'agent-1',
	moderatorSessionId: 'mod-session-1',
	participants: [
		{ agentId: 'agent-1', sessionId: 'session-1' },
		{ agentId: 'agent-2', sessionId: 'session-2' },
	],
	createdAt: Date.now(),
	logPath: '/tmp/gc-1.log',
	imagesDir: '/tmp/gc-1-images',
};

const defaultProps = {
	theme: testTheme,
	groupChats: [] as GroupChat[],
	showNewGroupChatModal: false,
	onCloseNewGroupChatModal: vi.fn(),
	onCreateGroupChat: vi.fn(),
	showDeleteGroupChatModal: null as string | null,
	onCloseDeleteGroupChatModal: vi.fn(),
	onConfirmDeleteGroupChat: vi.fn(),
	showRenameGroupChatModal: null as string | null,
	onCloseRenameGroupChatModal: vi.fn(),
	onRenameGroupChat: vi.fn(),
	showEditGroupChatModal: null as string | null,
	onCloseEditGroupChatModal: vi.fn(),
	onUpdateGroupChat: vi.fn(),
	showGroupChatInfo: false,
	activeGroupChatId: null as string | null,
	groupChatMessages: [],
	onCloseGroupChatInfo: vi.fn(),
	onOpenModeratorSession: vi.fn(),
};

describe('AppGroupChatModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('does not render any modals when all booleans are false/null', () => {
		render(<AppGroupChatModals {...defaultProps} />);
		expect(screen.queryByTestId('group-chat-modal-create')).not.toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-modal-edit')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-info-overlay')).not.toBeInTheDocument();
	});

	it('renders create GroupChatModal when showNewGroupChatModal is true', () => {
		render(<AppGroupChatModals {...defaultProps} showNewGroupChatModal={true} />);
		expect(screen.getByTestId('group-chat-modal-create')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-modal-edit')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-info-overlay')).not.toBeInTheDocument();
	});

	it('renders DeleteGroupChatModal when showDeleteGroupChatModal matches a group chat', () => {
		render(
			<AppGroupChatModals
				{...defaultProps}
				groupChats={[mockGroupChat]}
				showDeleteGroupChatModal="gc-1"
			/>
		);
		expect(screen.getByTestId('delete-group-chat-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-modal-create')).not.toBeInTheDocument();
	});

	it('does not render DeleteGroupChatModal when group chat not found', () => {
		render(
			<AppGroupChatModals
				{...defaultProps}
				groupChats={[mockGroupChat]}
				showDeleteGroupChatModal="gc-nonexistent"
			/>
		);
		expect(screen.queryByTestId('delete-group-chat-modal')).not.toBeInTheDocument();
	});

	it('renders RenameGroupChatModal when showRenameGroupChatModal matches a group chat', () => {
		render(
			<AppGroupChatModals
				{...defaultProps}
				groupChats={[mockGroupChat]}
				showRenameGroupChatModal="gc-1"
			/>
		);
		expect(screen.getByTestId('rename-group-chat-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-modal-create')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-group-chat-modal')).not.toBeInTheDocument();
	});

	it('renders edit GroupChatModal when showEditGroupChatModal matches a group chat', () => {
		render(
			<AppGroupChatModals
				{...defaultProps}
				groupChats={[mockGroupChat]}
				showEditGroupChatModal="gc-1"
			/>
		);
		expect(screen.getByTestId('group-chat-modal-edit')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-modal-create')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-info-overlay')).not.toBeInTheDocument();
	});

	it('renders GroupChatInfoOverlay when showGroupChatInfo and activeGroupChatId match a group chat', () => {
		render(
			<AppGroupChatModals
				{...defaultProps}
				groupChats={[mockGroupChat]}
				showGroupChatInfo={true}
				activeGroupChatId="gc-1"
			/>
		);
		expect(screen.getByTestId('group-chat-info-overlay')).toBeInTheDocument();
		expect(screen.queryByTestId('group-chat-modal-create')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-group-chat-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-group-chat-modal')).not.toBeInTheDocument();
	});
});
