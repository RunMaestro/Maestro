import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../renderer/types';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockAITab, createMockFileTab, createMockSession, resetStore } from '../../helpers';

const loadResumableSession = vi.fn();
const readFilePreviewContent = vi.fn();
const notifyToast = vi.fn();

vi.mock('../../../renderer/services/resumableSession', () => ({
	loadResumableSession: (...args: unknown[]) => loadResumableSession(...args),
}));
vi.mock('../../../renderer/hooks/tabs/internal/filePreviewTabHelpers', () => ({
	readFilePreviewContent: (...args: unknown[]) => readFilePreviewContent(...args),
}));
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

import {
	REOPENED_TRANSCRIPT_UNAVAILABLE_TEXT,
	__resetReopenedTabContentForTests,
	loadReopenedTabContent,
	needsReopenedTabContent,
	startReopenedTabContentLoader,
} from '../../../renderer/services/reopenedTabContent';

const transcript = [{ id: 'm1', timestamp: 1, source: 'user', text: 'hello' }];

function seed(session: Session): void {
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: session.id,
		sessionsReadOk: true,
	});
}

function current(): Session {
	return useSessionStore.getState().sessions[0];
}

function strippedAiSession(): Session {
	const tab = createMockAITab({ id: 'ai-1', agentSessionId: 'provider-1', logs: [] });
	return createMockSession({
		aiTabs: [tab],
		activeTabId: tab.id,
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
	});
}

describe('reopenedTabContent', () => {
	beforeEach(() => {
		resetStore(useSessionStore);
		__resetReopenedTabContentForTests();
		loadResumableSession.mockReset();
		readFilePreviewContent.mockReset();
		notifyToast.mockReset();
	});

	afterEach(() => {
		__resetReopenedTabContentForTests();
	});

	it('only matches an AI tab with no logs and a session id, or an untouched file tab with a path', () => {
		const session = createMockSession({
			aiTabs: [
				createMockAITab({ id: 'empty', agentSessionId: 'p', logs: [] }),
				createMockAITab({ id: 'fresh', agentSessionId: null, logs: [] }),
				createMockAITab({ id: 'loaded', agentSessionId: 'p', logs: transcript as never }),
			],
			filePreviewTabs: [
				createMockFileTab({ id: 'stripped', path: '/a.md', content: '' }),
				createMockFileTab({ id: 'untitled', path: '', content: '' }),
				createMockFileTab({ id: 'loading', path: '/b.md', content: '', isLoading: true }),
				createMockFileTab({ id: 'editing', path: '/c.md', content: '', editContent: 'x' }),
			],
		});
		const needs = (type: 'ai' | 'file', id: string) =>
			needsReopenedTabContent(session, { type, id });
		expect(needs('ai', 'empty')).toBe(true);
		expect(needs('ai', 'fresh')).toBe(false);
		expect(needs('ai', 'loaded')).toBe(false);
		expect(needs('file', 'stripped')).toBe(true);
		expect(needs('file', 'untitled')).toBe(false);
		expect(needs('file', 'loading')).toBe(false);
		expect(needs('file', 'editing')).toBe(false);
	});

	it('reads a stripped AI transcript back through loadResumableSession', async () => {
		seed(strippedAiSession());
		loadResumableSession.mockResolvedValue({ messages: transcript, name: null, starred: false });

		await expect(loadReopenedTabContent('session-1', { type: 'ai', id: 'ai-1' })).resolves.toBe(
			'loaded'
		);
		expect(loadResumableSession).toHaveBeenCalledWith(
			expect.objectContaining({
				toolType: 'claude-code',
				projectRoot: '/test/project',
				agentSessionId: 'provider-1',
			})
		);
		expect(current().aiTabs[0].logs).toEqual(transcript);
	});

	it('never overwrites logs that arrived while the read was in flight', async () => {
		seed(strippedAiSession());
		let resolve!: (value: unknown) => void;
		loadResumableSession.mockReturnValue(new Promise((r) => (resolve = r)));

		const pending = loadReopenedTabContent('session-1', { type: 'ai', id: 'ai-1' });
		const typed = [{ id: 'new', timestamp: 2, source: 'user', text: 'sent meanwhile' }];
		useSessionStore.setState({
			sessions: [{ ...current(), aiTabs: [{ ...current().aiTabs[0], logs: typed as never }] }],
		});
		resolve({ messages: transcript, name: null, starred: false });
		await pending;

		expect(current().aiTabs[0].logs).toEqual(typed);
	});

	it('leaves a note when the provider no longer has the conversation', async () => {
		seed(strippedAiSession());
		loadResumableSession.mockResolvedValue(null);

		await expect(loadReopenedTabContent('session-1', { type: 'ai', id: 'ai-1' })).resolves.toBe(
			'unavailable'
		);
		expect(current().aiTabs[0].logs).toHaveLength(1);
		expect(current().aiTabs[0].logs[0].text).toBe(REOPENED_TRANSCRIPT_UNAVAILABLE_TEXT);
		expect(current().aiTabs[0].agentSessionId).toBe('provider-1');
	});

	it('reports a failed read once and does not retry it this run', async () => {
		seed(strippedAiSession());
		loadResumableSession.mockRejectedValue(new Error('disk gone'));

		await expect(loadReopenedTabContent('session-1', { type: 'ai', id: 'ai-1' })).resolves.toBe(
			'failed'
		);
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
		await expect(loadReopenedTabContent('session-1', { type: 'ai', id: 'ai-1' })).resolves.toBe(
			'skipped'
		);
		expect(loadResumableSession).toHaveBeenCalledTimes(1);
		expect(current().aiTabs[0].logs).toEqual([]);
	});

	it('re-reads a stripped file tab from disk', async () => {
		const file = createMockFileTab({ id: 'file-1', path: '/a.md', content: '' });
		seed(
			createMockSession({
				filePreviewTabs: [file],
				activeFileTabId: file.id,
				unifiedTabOrder: [{ type: 'file', id: file.id }],
			})
		);
		readFilePreviewContent.mockResolvedValue({ content: '# A', lastModified: 99 });

		await expect(loadReopenedTabContent('session-1', { type: 'file', id: 'file-1' })).resolves.toBe(
			'loaded'
		);
		expect(current().filePreviewTabs[0]).toMatchObject({ content: '# A', lastModified: 99 });
	});

	it('the store subscriber fills the visible reopened tab with one read', async () => {
		loadResumableSession.mockResolvedValue({ messages: transcript, name: null, starred: false });
		const stop = startReopenedTabContentLoader();
		try {
			seed(strippedAiSession());
			// A second store change while the read is in flight must not start another.
			useSessionStore.setState({ sessions: [{ ...current() }] });
			await vi.waitFor(() => expect(current().aiTabs[0].logs).toEqual(transcript));
			expect(loadResumableSession).toHaveBeenCalledTimes(1);
		} finally {
			stop();
		}
	});
});
