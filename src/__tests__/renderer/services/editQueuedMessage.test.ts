/**
 * Tests for the shared "edit the newest queued message" flow.
 *
 * The point of the service is that the `editLastQueuedMessage` chord and the
 * palette's "Edit Last Queued Message" entry cannot drift on which item they
 * pick, which tab they land on, or what they say when there is nothing to edit.
 *
 * Two behaviors here are easy to "simplify" into bugs, so they are pinned:
 *  - a queued item whose tab is gone RANKS below one whose tab still exists,
 *    but it is never filtered out, or a closed tab turns into "nothing queued";
 *  - the two empty states are named apart, because "no queued message" printed
 *    over a screen full of queued command cards is the least useful thing this
 *    can report.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestEditLastQueuedMessage } from '../../../renderer/services/editQueuedMessage';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, QueuedItem, Session } from '../../../renderer/types';

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

const SESSION_ID = 'agent-1';

/** Minimal AI tab: the service only needs the id to match and land on. */
const tab = (id: string): AITab => ({ id, name: id, logs: [] }) as unknown as AITab;

/** Queued item; `type` defaults to an editable message. */
function queued(id: string, tabId: string, type: QueuedItem['type'] = 'message'): QueuedItem {
	return { id, tabId, type, timestamp: 1, text: `text-${id}` } as QueuedItem;
}

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: SESSION_ID,
		inputMode: 'ai',
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		...overrides,
	} as Partial<Session>);
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
	return session;
}

/** The session as it stands in the store right now, after any patch. */
const currentSession = (): Session =>
	useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID) as Session;

function flashMessage(): string | undefined {
	const calls = vi.mocked(notifyCenterFlash).mock.calls;
	return calls.length > 0 ? calls[calls.length - 1][0]?.message : undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
	useUIStore.setState({ editingQueuedItemId: null } as never);
	useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
});

describe('requestEditLastQueuedMessage', () => {
	it('opens the edit modal on the newest queued message', () => {
		seed({
			aiTabs: [tab('tab-1')],
			activeTabId: 'tab-1',
			executionQueue: [queued('q1', 'tab-1'), queued('q2', 'tab-1')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		expect(useUIStore.getState().editingQueuedItemId).toBe('q2');
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('skips commands, which carry no editable prompt text', () => {
		seed({
			aiTabs: [tab('tab-1')],
			activeTabId: 'tab-1',
			executionQueue: [queued('msg', 'tab-1'), queued('cmd', 'tab-1', 'command')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		expect(useUIStore.getState().editingQueuedItemId).toBe('msg');
	});

	it('prefers the active tab over a newer item queued on another tab', () => {
		// The queue is agent-level, so the newest item overall may belong to a
		// tab the user is not looking at. Staying put is less surprising.
		seed({
			aiTabs: [tab('tab-1'), tab('tab-2')],
			activeTabId: 'tab-1',
			executionQueue: [queued('here', 'tab-1'), queued('elsewhere', 'tab-2')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		expect(useUIStore.getState().editingQueuedItemId).toBe('here');
	});

	it('lands on the owning tab when the newest item belongs to another one', () => {
		seed({
			aiTabs: [tab('tab-1'), tab('tab-2')],
			activeTabId: 'tab-1',
			executionQueue: [queued('elsewhere', 'tab-2')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		// The modal renders inside its own tab's transcript, so the service has
		// to switch there or the user gets no modal at all.
		expect(currentSession().activeTabId).toBe('tab-2');
		expect(useUIStore.getState().editingQueuedItemId).toBe('elsewhere');
	});

	it('clears a covering file view so the transcript is actually on screen', () => {
		seed({
			aiTabs: [tab('tab-1')],
			activeTabId: 'tab-1',
			activeFileTabId: 'file-1',
			executionQueue: [queued('q1', 'tab-1')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		expect(currentSession().activeFileTabId).toBeNull();
		expect(currentSession().inputMode).toBe('ai');
	});

	it('still edits an item whose tab is gone rather than reporting an empty queue', () => {
		seed({
			aiTabs: [tab('tab-1')],
			activeTabId: 'tab-1',
			executionQueue: [queued('orphan', 'closed-tab')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		expect(useUIStore.getState().editingQueuedItemId).toBe('orphan');
	});

	it('ranks a renderable item above an orphan even when the orphan is newer', () => {
		seed({
			aiTabs: [tab('tab-2')],
			activeTabId: 'tab-2',
			executionQueue: [queued('renderable', 'tab-2'), queued('orphan', 'closed-tab')],
		});

		expect(requestEditLastQueuedMessage()).toBe(true);
		expect(useUIStore.getState().editingQueuedItemId).toBe('renderable');
	});

	it('says nothing is queued when the queue is empty', () => {
		seed({ aiTabs: [tab('tab-1')], activeTabId: 'tab-1', executionQueue: [] });

		expect(requestEditLastQueuedMessage()).toBe(false);
		expect(flashMessage()).toBe('Nothing queued to edit');
		expect(useUIStore.getState().editingQueuedItemId).toBeNull();
	});

	it('says which empty it is when only commands are queued', () => {
		seed({
			aiTabs: [tab('tab-1')],
			activeTabId: 'tab-1',
			executionQueue: [queued('cmd', 'tab-1', 'command')],
		});

		expect(requestEditLastQueuedMessage()).toBe(false);
		expect(flashMessage()).toBe('Only commands are queued');
	});

	it('reports no agent rather than throwing when nothing is selected', () => {
		expect(requestEditLastQueuedMessage()).toBe(false);
		expect(flashMessage()).toBe('No agent selected');
	});
});
