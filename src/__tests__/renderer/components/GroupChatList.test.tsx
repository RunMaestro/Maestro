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
	} as const;
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
});
