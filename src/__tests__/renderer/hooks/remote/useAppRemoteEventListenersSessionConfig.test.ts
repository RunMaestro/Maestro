/**
 * Covers the `update_session_config` allowlist in useAppRemoteEventListeners -
 * the single gate every CLI-driven per-agent edit passes through.
 *
 * The invariants under test: allowlisted keys are written and flushed to disk
 * before the ack (so a CLI read straight after the write is not racing the
 * renderer's debounced persistence), and anything outside the allowlist is
 * dropped rather than written into Session internals.
 *
 * A `toolType` key switches the provider (`maestro-cli update-agent
 * --provider`). That path used to replace every tab with one fresh tab and
 * kill the agent process; it now runs `switchAgentProvider`, so the tests below
 * pin that tabs, transcripts, and a turn in flight all survive the switch.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../../helpers/mockTab';
import { PROVIDER_OVERRIDE_KEYS } from '../../../../shared/maestro-lib/agents/providerSwap';
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
const kill = vi.fn().mockResolvedValue(undefined);

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

	return { setSessions, sessionsRef };
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
			kill,
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

describe('maestro:remoteUpdateSessionConfig with a toolType (provider switch)', () => {
	/**
	 * A Claude agent mid-turn on its second tab, with a file tab, a queued
	 * message, and provider-specific overrides set: everything the old
	 * destructive switch wiped.
	 */
	function claudeAgent(): Session {
		return createMockSession({
			id: 'session-1',
			toolType: 'claude-code',
			state: 'busy',
			aiPid: 4242,
			customPath: '/opt/claude',
			customArgs: '--verbose',
			customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' },
			customModel: 'opus',
			customContextWindow: 500000,
			contextWindowSource: 'user-edited',
			enableMaestroP: true,
			maestroPMode: 'dynamic',
			aiTabs: [
				createMockAITab({
					id: 'tab-1',
					agentSessionId: 'claude-session-1',
					customEffort: 'high',
					logs: [{ id: 'log-1', timestamp: 1, source: 'user', text: 'first question' }],
				}),
				createMockAITab({
					id: 'tab-2',
					agentSessionId: 'claude-session-2',
					customModel: 'sonnet',
					state: 'busy',
					turnProvider: 'claude-code',
					logs: [{ id: 'log-2', timestamp: 2, source: 'stdout', text: 'still working' }],
				}),
			],
			activeTabId: 'tab-2',
			filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: 'tab-2' },
			],
			executionQueue: [
				{ id: 'queued-1', timestamp: 3, tabId: 'tab-1', type: 'message', text: 'and then this' },
			],
		});
	}

	it('keeps every tab, its transcript, and the tab layout', async () => {
		const sessions = [claudeAgent()];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { toolType: 'codex' });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.toolType).toBe('codex');
		expect(updated.aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
		updated.aiTabs.forEach((tab, index) => {
			expect(tab.logs).toBe(sessions[0].aiTabs[index].logs);
		});
		expect(updated.activeTabId).toBe('tab-2');
		expect(updated.filePreviewTabs).toBe(sessions[0].filePreviewTabs);
		expect(updated.unifiedTabOrder).toBe(sessions[0].unifiedTabOrder);
		// Claude's resume token is parked for the way back, not discarded.
		expect(updated.aiTabs[0].agentSessionId).toBeNull();
		expect(updated.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe(
			'claude-session-1'
		);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('leaves a turn in flight running under the provider that started it', async () => {
		const sessions = [claudeAgent()];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { toolType: 'codex' });
		await flush();

		// Nothing is killed and no busy state is reset: the turn finishes, and
		// `turnProvider` keeps its late events attributed to Claude.
		expect(kill).not.toHaveBeenCalled();
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.state).toBe('busy');
		expect(updated.aiPid).toBe(4242);
		expect(updated.aiTabs[1].state).toBe('busy');
		expect(updated.aiTabs[1].turnProvider).toBe('claude-code');
		expect(updated.executionQueue.map((item) => item.id)).toEqual(['queued-1']);
	});

	it('parks the overrides and restores tabs and overrides exactly on the way back', async () => {
		const original = claudeAgent();
		const { setSessions, sessionsRef } = setup([original]);

		dispatchPatch('session-1', { toolType: 'codex' });
		await flush();
		const [onCodex] = applyUpdate(setSessions, [original]);
		for (const key of PROVIDER_OVERRIDE_KEYS) {
			expect(onCodex[key]).toBeUndefined();
		}
		expect(onCodex.providerOverrides?.['claude-code']).toEqual({
			customPath: '/opt/claude',
			customArgs: '--verbose',
			customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' },
			customModel: 'opus',
			customContextWindow: 500000,
			contextWindowSource: 'user-edited',
			enableMaestroP: true,
			maestroPMode: 'dynamic',
		});

		sessionsRef.current = [onCodex];
		setSessions.mockClear();
		dispatchPatch('session-1', { toolType: 'claude-code' });
		await flush();
		const [back] = applyUpdate(setSessions, [onCodex]);

		expect(back.toolType).toBe('claude-code');
		for (const key of PROVIDER_OVERRIDE_KEYS) {
			expect(back[key]).toStrictEqual(original[key]);
		}
		back.aiTabs.forEach((tab, index) => {
			const before = original.aiTabs[index];
			expect(tab.id).toBe(before.id);
			expect(tab.agentSessionId).toBe(before.agentSessionId);
			expect(tab.usageStats).toStrictEqual(before.usageStats);
			expect(tab.customModel).toBe(before.customModel);
			expect(tab.customEffort).toBe(before.customEffort);
			expect(tab.logs).toBe(before.logs);
		});
	});

	it('flushes the switched agent to disk before acking', async () => {
		setup([claudeAgent()]);

		dispatchPatch('session-1', { toolType: 'codex' });
		await flush();

		const [[persisted]] = setMany.mock.calls.at(-1) as [Session[]];
		expect(persisted.toolType).toBe('codex');
		expect(persisted.aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
		expect(persisted.providerOverrides?.['claude-code']?.customModel).toBe('opus');
		expect(setMany.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
	});

	it('switches the live store entry, so output streamed since the snapshot survives', async () => {
		const snapshot = claudeAgent();
		const { setSessions } = setup([snapshot]);

		dispatchPatch('session-1', { toolType: 'codex' });
		await flush();

		// The busy tab streamed another chunk after the listener read sessionsRef.
		const live: Session = {
			...snapshot,
			aiTabs: snapshot.aiTabs.map((tab) =>
				tab.id === 'tab-2'
					? {
							...tab,
							logs: [...tab.logs, { id: 'log-3', timestamp: 4, source: 'stdout', text: 'more' }],
						}
					: tab
			),
		};
		const [updated] = applyUpdate(setSessions, [live]);
		expect(updated.toolType).toBe('codex');
		expect(updated.aiTabs[1].logs.map((entry) => entry.id)).toEqual(['log-2', 'log-3']);
	});

	it('reports what it could not park in the ack, and keeps the queued message', async () => {
		const agent = claudeAgent();
		agent.executionQueue = [
			{ ...agent.executionQueue[0], turnSettings: { model: 'opus', effort: 'high' } },
		];
		const sessions = [agent];
		const { setSessions } = setup(sessions);

		dispatchPatch('session-1', { toolType: 'codex' });
		await flush();

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.executionQueue.map((item) => item.text)).toEqual(['and then this']);
		expect(updated.executionQueue[0].turnSettings).toBeUndefined();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: true,
			notices: [expect.stringContaining('model "opus" and effort "high" on Claude Code')],
		});
	});

	it.each(['not-a-provider', 'terminal'])(
		'rejects %s instead of writing it into the agent',
		async (toolType) => {
			const { setSessions } = setup([claudeAgent()]);

			dispatchPatch('session-1', { toolType });
			await flush();

			expect(setSessions).not.toHaveBeenCalled();
			expect(setMany).not.toHaveBeenCalled();
			expect(ack).toHaveBeenCalledWith('ch', {
				success: false,
				error: `Unknown provider '${toolType}'`,
			});
		}
	);
});
