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

	// ========================================================================
	// Single-line header contract
	// ========================================================================
	// The section header must NEVER wrap to a second row as the sidebar
	// narrows; instead it progressively drops the count badge, then the
	// archived count, then the "New Chat" label (see the `@container gcheader`
	// rules in src/renderer/index.css).
	//
	// jsdom has no layout engine and does not evaluate container queries, so
	// these tests CANNOT assert "the label is hidden at 275px". What they pin
	// down is the markup contract the CSS depends on: the container context,
	// the anti-wrap utilities, and the hook classes. If a refactor drops any
	// of them the CSS silently stops applying and the wrapping bug returns
	// with no other test failing. The companion cross-file check lives in
	// groupChatHeaderResponsive.regression.test.ts.
	describe('single-line header contract', () => {
		const archivedChat: GroupChat = { ...baseChat, id: 'gc-archived', archived: true };

		/** The header row is the element that owns the container-query context. */
		function getHeader(container: HTMLElement): HTMLElement {
			const header = container.querySelector('.gc-header-container');
			expect(header).not.toBeNull();
			return header as HTMLElement;
		}

		it('establishes the container-query context on the header row', () => {
			// Without this class `container-name: gcheader` never applies and
			// every @container rule below silently no-ops.
			const { container } = renderList();
			expect(getHeader(container)).toBeTruthy();
		});

		it('keeps the title from wrapping and the controls from shrinking', () => {
			// These two utilities are what structurally guarantee a single line
			// regardless of whether container queries are supported at all.
			const { container } = renderList();
			const header = getHeader(container);

			const title = header.querySelector('.whitespace-nowrap');
			expect(title).not.toBeNull();
			expect(title?.textContent).toContain('Group Chats');

			// The right-hand control cluster must not be compressed into a wrap.
			const controls = header.lastElementChild as HTMLElement;
			expect(controls.className).toContain('shrink-0');
		});

		it('tags the group chat count badge as droppable', () => {
			const { container } = renderList({ groupChats: [baseChat] });
			const badge = getHeader(container).querySelector('.gc-count-badge');
			expect(badge).not.toBeNull();
			expect(badge?.textContent).toBe('1');
		});

		it('tags the archived count as droppable but keeps the archive button itself', () => {
			// Only the NUMBER may drop at narrow widths - the button must stay
			// reachable, so the hook class belongs on the count span, never on
			// the button.
			const { container } = renderList({
				groupChats: [baseChat, archivedChat],
				onArchiveGroupChat: vi.fn(),
			});
			const count = getHeader(container).querySelector('.gc-archived-count');
			expect(count).not.toBeNull();
			expect(count?.textContent).toBe('1');
			expect(count?.tagName).toBe('SPAN');
			expect((count as HTMLElement).closest('button')).not.toBeNull();
		});

		it('keeps the "+" visible when the New Chat label drops', () => {
			// The label is the only droppable part; the plus sign has no hook
			// class, so the button never collapses to zero content.
			const { container } = renderList();
			const label = getHeader(container).querySelector('.gc-newchat-label');
			expect(label).not.toBeNull();
			expect(label?.textContent).toBe('New Chat');

			const button = (label as HTMLElement).closest('button') as HTMLElement;
			expect(button.textContent).toContain('+');
		});

		it('keeps an accessible name on the New Chat button once the label is hidden', () => {
			// With the label display:none the accessible name falls back to the
			// title attribute, so a collapsed "+" button is still identifiable.
			const { getByTitle } = renderList();
			expect(getByTitle('New Group Chat')).toBeTruthy();
		});

		it('still fires onNewGroupChat when only the "+" is showing', () => {
			// Hiding the label is purely visual - the click target is the button.
			const onNewGroupChat = vi.fn();
			const { getByTitle } = renderList({ onNewGroupChat });
			fireEvent.click(getByTitle('New Group Chat'));
			expect(onNewGroupChat).toHaveBeenCalled();
		});
	});
});
