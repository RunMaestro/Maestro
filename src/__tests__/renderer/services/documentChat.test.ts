/**
 * Tests for the persistent document chat.
 *
 * The whole feature rests on one claim: the chat is an ordinary AI tab tagged
 * with `documentOrigin`, and everything it promises falls out of that. So these
 * tests are about the claim rather than about the panel - that the binding is
 * found again, that a second message does not re-hand over the document, that
 * reset never destroys a transcript, and that a chat started from the preview
 * does not move the user's view.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	buildDocumentChatMessages,
	findDocumentChatTab,
	popOutDocumentChat,
	readDocumentChatView,
	resetDocumentChat,
	sendDocumentChatMessage,
} from '../../../renderer/services/documentChat';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockSession } from '../../helpers/mockSession';
import { buildDocumentOpeningPrompt } from '../../../shared/acappella/document-scope';
import type { AITab, LogEntry } from '../../../renderer/types';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

const SESSION_ID = 'agent-1';
const DOC_PATH = '/repo/docs/system-overview.md';

function currentSession() {
	return useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID)!;
}

function chatTab(): AITab | null {
	return findDocumentChatTab(currentSession(), DOC_PATH);
}

/** The text of the one queued item, which is what actually reaches the agent. */
function queuedText(): string | undefined {
	return currentSession().executionQueue?.[0]?.text;
}

function logEntry(partial: Partial<LogEntry> & Pick<LogEntry, 'source' | 'text'>): LogEntry {
	return { id: `log-${Math.random()}`, timestamp: Date.now(), ...partial };
}

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [createMockSession({ id: SESSION_ID })],
		activeSessionId: SESSION_ID,
	});
});

describe('sendDocumentChatMessage', () => {
	it('creates one hidden tab bound to the document', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'what is this file for?' });

		const tab = chatTab();
		expect(tab).not.toBeNull();
		expect(tab!.documentOrigin).toEqual({ path: DOC_PATH });
		// Hidden: chatting about a file from a preview pane is not the user asking
		// for a chip in the tab strip.
		expect(tab!.hidden).toBe(true);
	});

	it('leaves the user looking at what they were looking at', () => {
		const before = currentSession();
		sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' });

		const after = currentSession();
		expect(after.activeTabId).toBe(before.activeTabId);
		expect(after.activeFileTabId).toBe(before.activeFileTabId);
		expect(after.inputMode).toBe(before.inputMode);
	});

	it('hands the document over on the FIRST message only', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'what is this file for?' });
		expect(queuedText()).toContain(DOC_PATH);
		expect(queuedText()).toContain('what is this file for?');

		// The queue is what the first message is still sitting in, so a second
		// message must see it and stay plain. Drain it the way the queue would.
		const tabId = chatTab()!.id;
		useSessionStore.setState({
			sessions: [
				{
					...currentSession(),
					executionQueue: [],
					aiTabs: currentSession().aiTabs.map((t) =>
						t.id === tabId
							? { ...t, logs: [logEntry({ source: 'user', text: 'what is this file for?' })] }
							: t
					),
				},
			],
		});

		sendDocumentChatMessage({ path: DOC_PATH, text: 'and the tests?' });
		expect(queuedText()).toBe('and the tests?');
	});

	it('does not re-hand the document over while the first message is still queued', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'first' });
		sendDocumentChatMessage({ path: DOC_PATH, text: 'second' });

		const queue = currentSession().executionQueue!;
		expect(queue).toHaveLength(2);
		expect(queue[1].text).toBe('second');
	});

	it('reuses the same tab for every later message', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'one' });
		const first = chatTab()!.id;
		sendDocumentChatMessage({ path: DOC_PATH, text: 'two' });

		expect(chatTab()!.id).toBe(first);
		expect(currentSession().aiTabs.filter((t) => t.documentOrigin)).toHaveLength(1);
	});

	it('keeps a separate chat per document', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'one' });
		sendDocumentChatMessage({ path: '/repo/README.md', text: 'two' });

		expect(currentSession().aiTabs.filter((t) => t.documentOrigin)).toHaveLength(2);
	});

	it('refuses, loudly, when there is no agent', () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });

		expect(sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' })).toBeNull();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'No agent to chat with' })
		);
	});

	it('ignores an empty message', () => {
		expect(sendDocumentChatMessage({ path: DOC_PATH, text: '   ' })).toBeNull();
		expect(chatTab()).toBeNull();
	});
});

describe('resetDocumentChat', () => {
	it('reveals the old conversation instead of destroying it', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' });
		const oldTabId = chatTab()!.id;

		resetDocumentChat({ path: DOC_PATH });

		const retired = currentSession().aiTabs.find((t) => t.id === oldTabId);
		expect(retired).toBeDefined();
		// Still there, now reachable, and no longer answering for the document.
		expect(retired!.hidden).toBe(false);
		expect(retired!.documentOrigin).toBeUndefined();
		expect(chatTab()).toBeNull();
	});

	it('makes the next message start a fresh conversation', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' });
		const oldTabId = chatTab()!.id;

		resetDocumentChat({ path: DOC_PATH });
		sendDocumentChatMessage({ path: DOC_PATH, text: 'starting over' });

		expect(chatTab()!.id).not.toBe(oldTabId);
		// A fresh tab has never heard of the file, so the document is handed over
		// again - anything else would leave the new session talking about nothing.
		expect(queuedText()).toContain(DOC_PATH);
	});

	it('is a no-op when nothing has been said yet', () => {
		expect(resetDocumentChat({ path: DOC_PATH })).toBeNull();
	});
});

describe('popOutDocumentChat', () => {
	it('reveals and focuses the conversation tab', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' });
		const tabId = chatTab()!.id;

		expect(popOutDocumentChat({ path: DOC_PATH })).toBe(tabId);

		const tab = currentSession().aiTabs.find((t) => t.id === tabId)!;
		expect(tab.hidden).toBe(false);
		expect(currentSession().activeTabId).toBe(tabId);
		// The binding survives the pop-out: the tab is now visible AND still the
		// document's chat, so the bubble keeps showing the same conversation.
		expect(tab.documentOrigin).toEqual({ path: DOC_PATH });
	});

	it('does nothing before the first message', () => {
		expect(popOutDocumentChat({ path: DOC_PATH })).toBeNull();
	});
});

describe('buildDocumentChatMessages', () => {
	const tab = {
		id: 't1',
		logs: [
			// Built with the real producer rather than by hand, so the fixture cannot
			// drift into a shape the opener never emits.
			logEntry({
				source: 'user',
				text: buildDocumentOpeningPrompt(
					{ kind: 'document', sessionId: SESSION_ID, path: DOC_PATH },
					'what is this for?',
					'typed'
				),
			}),
			logEntry({ source: 'thinking', text: 'hmm' }),
			logEntry({ source: 'tool', text: 'Read(file)' }),
			logEntry({ source: 'ai', text: 'It is the overview.' }),
			logEntry({ source: 'stdout', text: 'noise' }),
			logEntry({ source: 'error', text: 'agent exited' }),
		],
	} as unknown as AITab;

	it('keeps what was asked and what came back, and drops the machinery', () => {
		const messages = buildDocumentChatMessages(tab);
		expect(messages.map((m) => m.kind)).toEqual(['you', 'assistant', 'system']);
	});

	it('shows what the user typed rather than the hand-over wrapper', () => {
		const [first] = buildDocumentChatMessages(tab);
		expect(first.text).toBe('what is this for?');
		expect(first.text).not.toContain(DOC_PATH);
	});

	it('is empty for a document nobody has chatted about', () => {
		expect(buildDocumentChatMessages(null)).toEqual([]);
	});
});

describe('readDocumentChatView', () => {
	it('counts only the messages queued for THIS conversation', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'one' });
		sendDocumentChatMessage({ path: '/repo/README.md', text: 'elsewhere' });

		expect(readDocumentChatView(currentSession(), DOC_PATH).pending).toBe(1);
	});

	it('draws a queued message rather than swallowing it', () => {
		// The message is in the queue, not in the transcript, until the agent takes
		// it. A bubble that showed only the transcript would eat what the user just
		// typed, and a chat that swallows your message reads as broken.
		sendDocumentChatMessage({ path: DOC_PATH, text: 'what is this for?' });

		const view = readDocumentChatView(currentSession(), DOC_PATH);
		expect(view.messages).toHaveLength(1);
		expect(view.messages[0]).toMatchObject({
			kind: 'you',
			text: 'what is this for?',
			pending: true,
		});
	});

	it('stops drawing it once the agent has taken it', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'what is this for?' });
		const tabId = chatTab()!.id;

		// Drain the way the queue does: the item leaves, a user entry lands.
		useSessionStore.setState({
			sessions: [
				{
					...currentSession(),
					executionQueue: [],
					aiTabs: currentSession().aiTabs.map((t) =>
						t.id === tabId
							? { ...t, logs: [logEntry({ source: 'user', text: 'what is this for?' })] }
							: t
					),
				},
			],
		});

		const view = readDocumentChatView(currentSession(), DOC_PATH);
		expect(view.messages).toHaveLength(1);
		expect(view.messages[0].pending).toBeUndefined();
	});

	it('reports an unstarted chat honestly', () => {
		const view = readDocumentChatView(currentSession(), DOC_PATH);
		expect(view.tab).toBeNull();
		expect(view.messages).toEqual([]);
		expect(view.busy).toBe(false);
		expect(view.pending).toBe(0);
	});
});
