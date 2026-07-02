/**
 * Tests for GroupChatList — left-sidebar list of Group Chats.
 *
 * Characterization tests for Tier 2 listener-hygiene refactor: pin down the
 * GroupChatContextMenu Escape-key behaviour and listener cleanup before
 * swapping to useEventListener.
 */

import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupChatList } from '../../../renderer/components/GroupChatList';
import { mockTheme } from '../../helpers/mockTheme';
import { spyOnListeners, expectAllListenersRemoved } from '../../helpers/listenerLeakAssertions';
import type { GroupChat } from '../../../shared/group-chat-types';

// Stub the click-outside hook so we only measure the context menu's own keydown
// listener in the leak assertion.
vi.mock('../../../renderer/hooks', async (orig) => {
	const actual = await (orig as () => Promise<Record<string, unknown>>)();
	return {
		...actual,
		useClickOutside: vi.fn(),
		useContextMenuPosition: () => ({ left: 0, top: 0, ready: true }),
	};
});

const baseChat: GroupChat = {
	id: 'gc-1',
	name: 'Test Chat',
	createdAt: 1,
	moderatorAgentId: 'claude-code',
	moderatorSessionId: 'group-chat-gc-1-moderator',
	participants: [],
	logPath: '/tmp/log',
	imagesDir: '/tmp/imgs',
};

function renderList(overrides: Partial<Parameters<typeof GroupChatList>[0]> = {}) {
	const defaults = {
		theme: mockTheme,
		groupChats: [baseChat],
		activeGroupChatId: null,
		onOpenGroupChat: vi.fn(),
		onNewGroupChat: vi.fn(),
		onEditGroupChat: vi.fn(),
		onRenameGroupChat: vi.fn(),
		onDeleteGroupChat: vi.fn(),
	};
	return render(<GroupChatList {...defaults} {...overrides} />);
}

function openContextMenu(container: HTMLElement) {
	// Walk up from the chat name to the row element that owns the onContextMenu
	// handler (the row has py-1.5; the section header has py-2 — distinguish by
	// closeting on the cursor-pointer class plus walking up from the name).
	const nameSpan = container.querySelector('span.text-sm.truncate');
	expect(nameSpan).not.toBeNull();
	const row = (nameSpan as HTMLElement).closest('[class*="cursor-pointer"]');
	expect(row).not.toBeNull();
	fireEvent.contextMenu(row as HTMLElement, { clientX: 50, clientY: 50 });
}

describe('GroupChatList', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('renders the list with a single chat', () => {
		const { getByText } = renderList();
		expect(getByText('Test Chat')).toBeInTheDocument();
	});

	it('does not mount the context-menu keydown listener until right-clicked', () => {
		const spies = spyOnListeners(document);
		renderList();
		const keydownAdds = spies.addSpy.mock.calls.filter(([t]) => t === 'keydown');
		expect(keydownAdds).toHaveLength(0);
		spies.restore();
	});

	it('closes the context menu on Escape after right-click', () => {
		const { container, queryByText } = renderList();
		openContextMenu(container);
		expect(queryByText('Edit')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(queryByText('Edit')).not.toBeInTheDocument();
	});

	it('removes the context-menu keydown listener after Escape closes the menu', () => {
		const spies = spyOnListeners(document);
		const { container } = renderList();
		openContextMenu(container);
		fireEvent.keyDown(document, { key: 'Escape' });
		expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
		spies.restore();
	});

	it('removes the context-menu keydown listener on unmount', () => {
		const spies = spyOnListeners(document);
		const { container, unmount } = renderList();
		openContextMenu(container);
		unmount();
		expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
		spies.restore();
	});

	it('stays collapsed when a new chat is added', () => {
		const onExpandedChange = vi.fn();
		const secondChat: GroupChat = { ...baseChat, id: 'gc-2', name: 'Second Chat' };
		const { rerender } = renderList({
			isExpanded: false,
			onExpandedChange,
			groupChats: [baseChat],
		});
		rerender(
			<GroupChatList
				theme={mockTheme}
				groupChats={[baseChat, secondChat]}
				activeGroupChatId={null}
				onOpenGroupChat={vi.fn()}
				onNewGroupChat={vi.fn()}
				onEditGroupChat={vi.fn()}
				onRenameGroupChat={vi.fn()}
				onDeleteGroupChat={vi.fn()}
				isExpanded={false}
				onExpandedChange={onExpandedChange}
			/>
		);
		expect(onExpandedChange).not.toHaveBeenCalled();
	});

	it('expands and creates a chat when New Chat is clicked while collapsed', () => {
		const onExpandedChange = vi.fn();
		const onNewGroupChat = vi.fn();
		const { getByText } = renderList({
			isExpanded: false,
			onExpandedChange,
			onNewGroupChat,
		});
		fireEvent.click(getByText('New Chat'));
		expect(onExpandedChange).toHaveBeenCalledWith(true);
		expect(onNewGroupChat).toHaveBeenCalledTimes(1);
	});

	describe('sort toggle pill', () => {
		// "Banana" was updated most recently; "Apple" comes first alphabetically.
		const apple: GroupChat = {
			...baseChat,
			id: 'gc-apple',
			name: 'Apple',
			createdAt: 1,
			updatedAt: 1,
		};
		const banana: GroupChat = {
			...baseChat,
			id: 'gc-banana',
			name: 'Banana',
			createdAt: 2,
			updatedAt: 100,
		};

		function chatOrder(container: HTMLElement): string[] {
			return Array.from(container.querySelectorAll('span.text-sm.truncate')).map(
				(el) => el.textContent ?? ''
			);
		}

		it('does not render the pill without an onSortAlphabeticalChange callback', () => {
			const { queryByTitle } = renderList({ groupChats: [apple, banana] });
			expect(queryByTitle(/Sorting/)).toBeNull();
		});

		it('does not render the pill with a single chat', () => {
			const { queryByTitle } = renderList({
				groupChats: [apple],
				onSortAlphabeticalChange: vi.fn(),
			});
			expect(queryByTitle(/Sorting/)).toBeNull();
		});

		it('sorts by most recent activity by default', () => {
			const { container } = renderList({
				groupChats: [apple, banana],
				onSortAlphabeticalChange: vi.fn(),
				isExpanded: true,
			});
			expect(chatOrder(container)).toEqual(['Banana', 'Apple']);
		});

		it('sorts alphabetically when sortAlphabetical is true', () => {
			const { container } = renderList({
				groupChats: [apple, banana],
				onSortAlphabeticalChange: vi.fn(),
				sortAlphabetical: true,
				isExpanded: true,
			});
			expect(chatOrder(container)).toEqual(['Apple', 'Banana']);
		});

		it('toggles the sort order when the pill is clicked', () => {
			const onSortAlphabeticalChange = vi.fn();
			const { getByTitle } = renderList({
				groupChats: [apple, banana],
				onSortAlphabeticalChange,
				sortAlphabetical: false,
			});
			fireEvent.click(getByTitle(/Sorting by most recent/));
			expect(onSortAlphabeticalChange).toHaveBeenCalledWith(true);
		});

		it('toggles back to most recent when clicked while alphabetical', () => {
			const onSortAlphabeticalChange = vi.fn();
			const { getByTitle } = renderList({
				groupChats: [apple, banana],
				onSortAlphabeticalChange,
				sortAlphabetical: true,
			});
			fireEvent.click(getByTitle(/Sorting alphabetically/));
			expect(onSortAlphabeticalChange).toHaveBeenCalledWith(false);
		});
	});
});
