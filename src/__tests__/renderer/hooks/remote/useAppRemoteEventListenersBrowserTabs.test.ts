/**
 * Covers the CLI/web browser-tab bridge in useAppRemoteEventListeners.
 *
 * The invariant under test: a `--background` open must not move the user. It
 * creates the tab but leaves the active agent and the visible tab alone, so an
 * agent doing research can't yank the window out from under someone typing.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-tab-id' }));

const openAck = vi.fn();
const closeAck = vi.fn();

function setup(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setActiveSessionId = vi.fn();
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId,
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);

	return { setActiveSessionId, setSessions };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdate(setSessions: Mock, sessions: Session[]): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchOpen(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:openBrowserTab', { detail }));
}

function dispatchClose(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:closeBrowserTab', { detail }));
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		process: {
			sendRemoteOpenBrowserTabResponse: openAck,
			sendRemoteCloseBrowserTabResponse: closeAck,
		},
	};
});

describe('maestro:openBrowserTab', () => {
	it('focuses the agent and the new tab for a foreground open', () => {
		const sessions = [createMockSession({ id: 'session-1', activeBrowserTabId: 'existing' })];
		const { setActiveSessionId, setSessions } = setup(sessions);

		dispatchOpen({ sessionId: 'session-1', url: 'https://example.com/', responseChannel: 'ch' });

		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.browserTabs).toHaveLength(1);
		expect(updated.activeBrowserTabId).toBe('new-tab-id');
	});

	it('does not switch agents or change the visible tab for a background open', () => {
		const sessions = [createMockSession({ id: 'session-1', activeBrowserTabId: 'existing' })];
		const { setActiveSessionId, setSessions } = setup(sessions);

		dispatchOpen({
			sessionId: 'session-1',
			url: 'https://example.com/',
			responseChannel: 'ch',
			background: true,
		});

		expect(setActiveSessionId).not.toHaveBeenCalled();
		const [updated] = applyUpdate(setSessions, sessions);
		// Tab exists, but the user is left exactly where they were.
		expect(updated.browserTabs).toHaveLength(1);
		expect(updated.activeBrowserTabId).toBe('existing');
	});

	it('acks with the created tab id so the caller can close it again', () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		setup(sessions);

		dispatchOpen({
			sessionId: 'session-1',
			url: 'https://example.com/',
			responseChannel: 'ch',
			background: true,
		});

		expect(openAck).toHaveBeenCalledWith('ch', true, 'new-tab-id');
	});

	it('acks false when the session does not exist', () => {
		setup([createMockSession({ id: 'session-1' })]);

		dispatchOpen({ sessionId: 'ghost', url: 'https://example.com/', responseChannel: 'ch' });

		expect(openAck).toHaveBeenCalledWith('ch', false, undefined);
	});
});

describe('maestro:closeBrowserTab', () => {
	const withTabs = () =>
		createMockSession({
			id: 'session-1',
			browserTabs: [
				{ id: 'tab-a', url: 'https://a.test/' },
				{ id: 'tab-b', url: 'https://b.test/' },
			] as any,
			activeBrowserTabId: 'tab-a',
			unifiedTabOrder: [
				{ type: 'browser', id: 'tab-a' },
				{ type: 'browser', id: 'tab-b' },
			] as any,
		});

	it('removes the tab from the owning session without needing an agent id', () => {
		const sessions = [withTabs()];
		const { setSessions } = setup(sessions);

		dispatchClose({ tabId: 'tab-b', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.browserTabs?.map((t) => t.id)).toEqual(['tab-a']);
		expect(updated.unifiedTabOrder).toEqual([{ type: 'browser', id: 'tab-a' }]);
		expect(closeAck).toHaveBeenCalledWith('ch', true);
	});

	it('leaves the visible tab alone when a background tab closes', () => {
		const sessions = [withTabs()];
		const { setSessions } = setup(sessions);

		dispatchClose({ tabId: 'tab-b', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.activeBrowserTabId).toBe('tab-a');
	});

	it('clears the active pointer when the closed tab was the visible one', () => {
		const sessions = [withTabs()];
		const { setSessions } = setup(sessions);

		dispatchClose({ tabId: 'tab-a', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.activeBrowserTabId).toBeNull();
	});

	it('acks false for an unknown tab so a cleanup no-op is distinguishable', () => {
		setup([withTabs()]);

		dispatchClose({ tabId: 'ghost-tab', responseChannel: 'ch' });

		expect(closeAck).toHaveBeenCalledWith('ch', false);
	});
});
