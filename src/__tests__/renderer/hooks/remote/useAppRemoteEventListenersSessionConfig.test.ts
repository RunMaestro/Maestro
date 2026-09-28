/**
 * Covers the `update_session_config` allowlist in useAppRemoteEventListeners -
 * the single gate every CLI-driven per-agent edit passes through.
 *
 * The invariants under test: allowlisted keys are written and flushed to disk
 * before the ack (so a CLI read straight after the write is not racing the
 * renderer's debounced persistence), and anything outside the allowlist is
 * dropped rather than written into Session internals.
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

const ack = vi.fn();
const setMany = vi.fn().mockResolvedValue(undefined);

function setup(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId: vi.fn(),
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

	return { setSessions };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdate(setSessions: Mock, sessions: Session[]): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchPatch(sessionId: string, configPatch: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteUpdateSessionConfig', {
			detail: { sessionId, configPatch, responseChannel: 'ch' },
		})
	);
}

/** Let the handler's awaited setMany + ack settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		process: {
			sendRemoteUpdateSessionConfigResponse: ack,
			kill: vi.fn().mockResolvedValue(undefined),
		},
		sessions: { setMany },
	};
});

describe('maestro:remoteUpdateSessionConfig', () => {
	it('writes the bookmark flag so the CLI can pin an agent in the Left Bar', async () => {
		const sessions = [createMockSession({ id: 'session-1', bookmarked: false })];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { bookmarked: true });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.bookmarked).toBe(true);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('clears the bookmark on an explicit false rather than treating it as unset', async () => {
		const sessions = [createMockSession({ id: 'session-1', bookmarked: true })];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { bookmarked: false });
		await flush();

		expect(applyUpdate(setSessions, sessions)[0].bookmarked).toBe(false);
	});

	it('flushes the bookmark to disk before acking, so a follow-up CLI read is not stale', async () => {
		const sessions = [createMockSession({ id: 'session-1', bookmarked: false })];
		setup(sessions);

		dispatchPatch('session-1', { bookmarked: true });
		await flush();

		expect(setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'session-1', bookmarked: true })],
			[]
		);
	});

	it('ignores keys outside the allowlist', async () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { bookmarked: true, aiPid: 99999, name: 'hijacked' });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.bookmarked).toBe(true);
		expect(updated.aiPid).toBe(sessions[0].aiPid);
		expect(updated.name).toBe(sessions[0].name);
	});

	it('rejects a patch containing nothing editable', async () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { aiPid: 1 });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'No editable config fields in patch',
		});
	});

	it('rejects an unknown agent', async () => {
		setup([createMockSession({ id: 'session-1' })]);

		dispatchPatch('nope', { bookmarked: true });
		await flush();

		expect(ack).toHaveBeenCalledWith('ch', { success: false, error: 'Agent not found' });
	});
});

describe('maestro:remoteUpdateSessionConfig with a tabId', () => {
	/** An agent whose second tab is the one under test. */
	function twoTabSession() {
		const session = createMockSession({ id: 'session-1' });
		session.aiTabs = [
			{ ...session.aiTabs[0], id: 'tab-1', hasUnread: false, saveToHistory: true },
			{ ...session.aiTabs[0], id: 'tab-2', hasUnread: false, saveToHistory: true },
		];
		return session;
	}

	it('patches only the targeted tab', async () => {
		const sessions = [twoTabSession()];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { tabId: 'tab-2', hasUnread: true });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.aiTabs[0].hasUnread).toBe(false);
		expect(updated.aiTabs[1].hasUnread).toBe(true);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('flushes the tab flag to disk before acking', async () => {
		setup([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-2', saveToHistory: false });
		await flush();

		const [[persisted]] = setMany.mock.calls.at(-1) as [Session[]];
		expect(persisted.aiTabs[1].saveToHistory).toBe(false);
		expect(persisted.aiTabs[0].saveToHistory).toBe(true);
	});

	it('ignores tab keys outside the allowlist', async () => {
		const sessions = [twoTabSession()];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { tabId: 'tab-1', starred: true, logs: [], agentSessionId: 'x' });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.aiTabs[0].starred).toBe(true);
		expect(updated.aiTabs[0].agentSessionId).toBe(sessions[0].aiTabs[0].agentSessionId);
	});

	it('rejects an unknown tab instead of silently patching nothing', async () => {
		const { setSessions } = setup([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-nope', hasUnread: true });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', { success: false, error: 'Tab not found' });
	});

	it('writes the composer-chip settings (thinking, read-only, model, effort)', async () => {
		const sessions = [twoTabSession()];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', {
			tabId: 'tab-2',
			showThinking: 'sticky',
			readOnlyMode: true,
			customModel: 'opus',
			customEffort: 'high',
			enterToSend: false,
		});
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.aiTabs[1].showThinking).toBe('sticky');
		expect(updated.aiTabs[1].readOnlyMode).toBe(true);
		expect(updated.aiTabs[1].customModel).toBe('opus');
		expect(updated.aiTabs[1].customEffort).toBe('high');
		expect(updated.aiTabs[1].enterToSend).toBe(false);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('clears an override on null so the tab inherits again', async () => {
		const sessions = [twoTabSession()];
		sessions[0].aiTabs[1] = { ...sessions[0].aiTabs[1], customModel: 'opus', enterToSend: false };
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { tabId: 'tab-2', customModel: null, enterToSend: null });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.aiTabs[1].customModel).toBeUndefined();
		expect(updated.aiTabs[1].enterToSend).toBeUndefined();
	});

	it('rejects a wrongly-typed tab value instead of persisting it', async () => {
		const { setSessions } = setup([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-1', readOnlyMode: 'yes' });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: "Invalid value for tab field 'readOnlyMode'",
		});
	});

	it('rejects an unknown thinking mode', async () => {
		const { setSessions } = setup([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-1', showThinking: 'loud' });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: "Invalid value for tab field 'showThinking'",
		});
	});

	it('rejects a tab-targeted patch with no editable tab fields', async () => {
		const { setSessions } = setup([twoTabSession()]);

		// `bookmarked` is agent state, not tab state - it must not leak across.
		dispatchPatch('session-1', { tabId: 'tab-1', bookmarked: true });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'No editable tab fields in patch',
		});
	});
});
