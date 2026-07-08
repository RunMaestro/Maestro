import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupChatList } from '../../renderer/components/GroupChatList';
import { useContextMenuPosition } from '../../renderer/hooks';
import type { GroupChat, Theme } from '../../renderer/types';

vi.mock('../../renderer/hooks', async () => {
	const actual =
		await vi.importActual<typeof import('../../renderer/hooks')>('../../renderer/hooks');
	return {
		...actual,
		useClickOutside: vi.fn(),
		useContextMenuPosition: vi.fn(() => ({ left: 24, top: 32, ready: true })),
	};
});

const theme: Theme = {
	id: 'custom',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		border: '#333333',
		textMain: '#f5f5f5',
		textDim: '#999999',
		accent: '#4a9eff',
		accentDim: '#2b5f99',
		accentText: '#dbeafe',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const baseChat = (overrides: Partial<GroupChat> = {}): GroupChat => ({
	id: 'chat-1',
	name: 'Planning Room',
	createdAt: 1000,
	updatedAt: 1000,
	moderatorAgentId: 'claude-code',
	moderatorSessionId: 'group-chat-chat-1-moderator',
	participants: [],
	logPath: '/tmp/chat-1/log.jsonl',
	imagesDir: '/tmp/chat-1/images',
	...overrides,
});

const defaultProps = () => ({
	theme,
	groupChats: [] as GroupChat[],
	activeGroupChatId: null,
	onOpenGroupChat: vi.fn(),
	onNewGroupChat: vi.fn(),
	onEditGroupChat: vi.fn(),
	onRenameGroupChat: vi.fn(),
	onDeleteGroupChat: vi.fn(),
	onArchiveGroupChat: vi.fn(),
});

describe('GroupChatList', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('expands an empty uncontrolled list and keeps the new-chat button from toggling it', () => {
		const props = defaultProps();
		render(<GroupChatList {...props} />);

		expect(screen.queryByText('No group chats yet')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Group Chats'));

		expect(screen.getByText('No group chats yet')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('New Group Chat'));

		expect(props.onNewGroupChat).toHaveBeenCalledOnce();
		expect(screen.getByText('No group chats yet')).toBeInTheDocument();
	});

	it('sorts active chats by recent activity and reveals archived chats on demand', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				groupChats={[
					baseChat({ id: 'older', name: 'Older Active', createdAt: 1000, updatedAt: 2000 }),
					baseChat({
						id: 'archived',
						name: 'Archived Room',
						createdAt: 1000,
						updatedAt: 9000,
						archived: true,
					}),
					baseChat({
						id: 'newer',
						name: 'Newer Active',
						createdAt: 1000,
						updatedAt: 3000,
						participants: [
							{
								name: 'Agent One',
								agentId: 'claude-code',
								sessionId: 'session-1',
								addedAt: 1000,
							},
							{
								name: 'Agent Two',
								agentId: 'codex',
								sessionId: 'session-2',
								addedAt: 1000,
							},
						],
					}),
				]}
			/>
		);

		const visibleItems = screen.getAllByText(/Active$/).map((item) => item.textContent);
		expect(visibleItems).toEqual(['Newer Active', 'Older Active']);
		expect(screen.queryByText('Archived Room')).not.toBeInTheDocument();
		expect(screen.getByTitle('2 participants')).toHaveTextContent('2');

		fireEvent.click(screen.getByTitle('Show 1 archived chat'));

		expect(screen.getByTitle('Hide archived chats')).toBeInTheDocument();
		expect(
			screen
				.getAllByText(/^(Newer Active|Older Active|Archived Room)$/)
				.map((item) => item.textContent)
		).toEqual(['Newer Active', 'Older Active', 'Archived Room']);
	});

	it('sorts chats by created time when updated time is missing', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				groupChats={[
					baseChat({ id: 'older', name: 'Older Created', createdAt: 1000, updatedAt: undefined }),
					baseChat({ id: 'newer', name: 'Newer Created', createdAt: 3000, updatedAt: undefined }),
				]}
			/>
		);

		expect(screen.getAllByText(/Created$/).map((item) => item.textContent)).toEqual([
			'Newer Created',
			'Older Created',
		]);
	});

	it('pluralizes archived and participant labels', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				groupChats={[
					baseChat({
						id: 'single-participant',
						name: 'Solo Chat',
						participants: [
							{
								name: 'Agent One',
								agentId: 'claude-code',
								sessionId: 'session-1',
								addedAt: 1000,
							},
						],
					}),
					baseChat({ id: 'archived-a', name: 'Archived A', archived: true }),
					baseChat({ id: 'archived-b', name: 'Archived B', archived: true }),
				]}
			/>
		);

		expect(screen.getByTitle('1 participant')).toHaveTextContent('1');
		expect(screen.getByTitle('Show 2 archived chats')).toHaveTextContent('2');
	});

	it('shows the archived empty state when every chat is archived', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				groupChats={[baseChat({ id: 'archived', name: 'Archived Room', archived: true })]}
			/>
		);

		expect(screen.getByText('All group chats are archived')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Show 1 archived chat'));

		expect(screen.getByText('Archived Room')).toBeInTheDocument();
	});

	it('uses controlled expansion and asks the parent to expand when a chat is added', () => {
		const props = defaultProps();
		const onExpandedChange = vi.fn();
		const { rerender } = render(
			<GroupChatList {...props} isExpanded={false} onExpandedChange={onExpandedChange} />
		);

		fireEvent.click(screen.getByText('Group Chats'));
		expect(onExpandedChange).toHaveBeenCalledWith(true);

		rerender(
			<GroupChatList
				{...props}
				groupChats={[baseChat({ id: 'new-chat', name: 'New Chat' })]}
				isExpanded={false}
				onExpandedChange={onExpandedChange}
			/>
		);

		expect(onExpandedChange).toHaveBeenLastCalledWith(true);
	});

	it('opens chats and renders busy indicators from active and inactive chat state', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				groupChats={[
					baseChat({ id: 'active', name: 'Active Chat' }),
					baseChat({ id: 'inactive', name: 'Inactive Chat' }),
					baseChat({ id: 'idle', name: 'Idle Chat' }),
				]}
				activeGroupChatId="active"
				groupChatState="moderator-thinking"
				participantStates={new Map([['Agent One', 'working']])}
				groupChatStates={new Map([['inactive', 'agent-working']])}
				allGroupChatParticipantStates={new Map([['idle', new Map([['Agent Two', 'working']])]])}
			/>
		);

		fireEvent.click(screen.getByText('Inactive Chat'));
		expect(props.onOpenGroupChat).toHaveBeenCalledWith('inactive');

		fireEvent.doubleClick(screen.getByText('Idle Chat'));
		expect(props.onOpenGroupChat).toHaveBeenCalledWith('idle');

		expect(screen.getAllByTitle('Thinking...')).toHaveLength(3);
		expect(screen.queryByTitle('Idle')).not.toBeInTheDocument();
	});

	it('runs context-menu edit, rename, archive, unarchive, delete, and escape close actions', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				groupChats={[
					baseChat({ id: 'active', name: 'Active Chat' }),
					baseChat({ id: 'archived', name: 'Archived Chat', archived: true }),
				]}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });
		const editMenu = screen.getByRole('button', { name: 'Edit' }).closest('div')!;
		expect(within(editMenu).getByRole('button', { name: 'Archive' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(props.onEditGroupChat).toHaveBeenCalledWith('active');
		expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		expect(props.onRenameGroupChat).toHaveBeenCalledWith('active');

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });
		fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
		expect(props.onArchiveGroupChat).toHaveBeenCalledWith('active', true);

		fireEvent.click(screen.getByTitle('Show 1 archived chat'));
		fireEvent.contextMenu(screen.getByText('Archived Chat'), { clientX: 12, clientY: 18 });
		fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
		expect(props.onArchiveGroupChat).toHaveBeenCalledWith('archived', false);

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(props.onDeleteGroupChat).toHaveBeenCalledWith('active');

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });
		expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Enter' });
		expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
	});

	it('renders a hidden context menu while its measured position is not ready', () => {
		vi.mocked(useContextMenuPosition).mockReturnValueOnce({ left: 24, top: 32, ready: false });
		const props = defaultProps();
		render(
			<GroupChatList {...props} groupChats={[baseChat({ id: 'active', name: 'Active Chat' })]} />
		);

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });

		expect(screen.getByRole('button', { name: 'Edit' }).closest('div')).toHaveStyle({
			opacity: '0',
		});
	});

	it('omits archive actions when no archive callback is provided', () => {
		const props = defaultProps();
		render(
			<GroupChatList
				{...props}
				onArchiveGroupChat={undefined}
				groupChats={[baseChat({ id: 'active', name: 'Active Chat' })]}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });

		expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
	});

	it('does not archive when the context-menu chat no longer exists', () => {
		const props = defaultProps();
		const { rerender } = render(
			<GroupChatList {...props} groupChats={[baseChat({ id: 'active', name: 'Active Chat' })]} />
		);

		fireEvent.contextMenu(screen.getByText('Active Chat'), { clientX: 12, clientY: 18 });
		rerender(<GroupChatList {...props} groupChats={[]} />);
		fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

		expect(props.onArchiveGroupChat).not.toHaveBeenCalled();
	});
});
