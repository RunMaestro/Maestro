/**
 * interruptTurn(): the one Stop behind the desktop pill, the REST route and
 * `maestro-cli interrupt`.
 *
 * The agent-level stop (no tabId) is driven end to end through the hook in
 * hooks/useInterruptHandler.test.ts. This file covers what only a remote caller
 * reaches: the tab scope, the result shape, and the failure codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {} from '../../../renderer/global';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { QueuedItem, Session } from '../../../renderer/types';

vi.mock('../../../renderer/stores/retryStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/retryStore')>()),
	stopRetriesForAgent: vi.fn(() => 0),
	cancelContextCompaction: vi.fn(() => 0),
}));
vi.mock('../../../renderer/services/crossAgentHandoff', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/services/crossAgentHandoff')>()),
	dropMentionHandoffs: vi.fn(),
}));

import { interruptTurn, registerTurnInterruptDeps } from '../../../renderer/services/turnInterrupt';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { cancelContextCompaction, stopRetriesForAgent } from '../../../renderer/stores/retryStore';
import { dropMentionHandoffs } from '../../../renderer/services/crossAgentHandoff';

const originalMaestro = window.maestro;
const processApi = {
	interrupt: vi.fn(),
	kill: vi.fn(),
	cancelCommand: vi.fn(),
	getActiveProcesses: vi.fn(),
};
const crossAgentApi = { cancel: vi.fn() };

/** An agent with a busy tab-a, a busy tab-b and an idle tab-c; tab-a is active. */
function seedAgent(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 'agent-1',
		state: 'busy',
		busySource: 'ai',
		aiTabs: [
			createMockAITab({
				id: 'tab-a',
				state: 'busy',
				logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'go' }],
			}),
			createMockAITab({
				id: 'tab-b',
				state: 'busy',
				logs: [
					{ id: 'l2', timestamp: 2, source: 'user', text: 'go' },
					{ id: 'l3', timestamp: 3, source: 'thinking', text: 'hmm' },
				],
			}),
			createMockAITab({ id: 'tab-c', state: 'idle' }),
		],
		activeTabId: 'tab-a',
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as any);
	return session;
}

const agent = () => useSessionStore.getState().sessions[0];
const tab = (id: string) => agent().aiTabs.find((t) => t.id === id)!;

beforeEach(() => {
	vi.clearAllMocks();
	processApi.interrupt.mockResolvedValue(true);
	processApi.kill.mockResolvedValue(undefined);
	processApi.cancelCommand.mockResolvedValue(false);
	processApi.getActiveProcesses.mockResolvedValue([]);
	crossAgentApi.cancel.mockResolvedValue({ canceled: 0 });
	window.maestro = {
		...originalMaestro,
		process: { ...originalMaestro.process, ...processApi },
		crossAgent: { ...originalMaestro.crossAgent, ...crossAgentApi },
	} as typeof window.maestro;
	registerTurnInterruptDeps(null);
});

afterEach(() => {
	window.maestro = originalMaestro;
	registerTurnInterruptDeps(null);
});

describe('interruptTurn: lookup failures', () => {
	it('answers AGENT_NOT_FOUND and touches nothing', async () => {
		useSessionStore.setState({ sessions: [] } as any);

		const result = await interruptTurn('ghost', { tabId: 'tab-a' });

		expect(result).toMatchObject({
			success: false,
			code: 'AGENT_NOT_FOUND',
			sessionId: 'ghost',
			tabId: 'tab-a',
			wasBusy: false,
		});
		expect(stopRetriesForAgent).not.toHaveBeenCalled();
		expect(processApi.interrupt).not.toHaveBeenCalled();
	});

	it('answers TAB_NOT_FOUND for a tab the agent does not have', async () => {
		seedAgent();

		const result = await interruptTurn('agent-1', { tabId: 'tab-zzz' });

		expect(result).toMatchObject({ success: false, code: 'TAB_NOT_FOUND', tabId: 'tab-zzz' });
		expect(processApi.interrupt).not.toHaveBeenCalled();
		expect(agent().state).toBe('busy');
	});
});

describe('interruptTurn: one tab', () => {
	it("signals that tab's per-tab process and its forced-parallel sibling only", async () => {
		seedAgent();
		processApi.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'agent-1-ai-tab-a' },
			{ sessionId: 'agent-1-ai-tab-b' },
			{ sessionId: 'agent-1-ai-tab-b-fp-1700' },
		]);

		await interruptTurn('agent-1', { tabId: 'tab-b' });

		expect(processApi.interrupt.mock.calls.map(([id]) => id)).toEqual([
			'agent-1-ai-tab-b',
			'agent-1-ai-tab-b-fp-1700',
		]);
	});

	it('narrows the retry, compaction, hand-off and consult cancel to that tab', async () => {
		seedAgent();
		const cancelPendingSynopsis = vi.fn().mockResolvedValue(undefined);
		registerTurnInterruptDeps({
			cancelPendingSynopsis,
			processQueuedItem: vi.fn(),
			ownsQueue: () => true,
		});

		await interruptTurn('agent-1', { tabId: 'tab-b' });

		expect(stopRetriesForAgent).toHaveBeenCalledWith('agent-1', 'tab-b');
		expect(cancelContextCompaction).toHaveBeenCalledWith('agent-1', 'tab-b');
		expect(dropMentionHandoffs).toHaveBeenCalledWith('agent-1', 'tab-b');
		expect(crossAgentApi.cancel).toHaveBeenCalledWith('agent-1', 'tab-b');
		// A synopsis carries no tab id, so only an agent-level stop ends it.
		expect(cancelPendingSynopsis).not.toHaveBeenCalled();
	});

	it('idles that tab and leaves the agent busy on its other turn', async () => {
		seedAgent();

		const result = await interruptTurn('agent-1', { tabId: 'tab-b' });

		expect(result).toEqual({
			success: true,
			sessionId: 'agent-1',
			tabId: 'tab-b',
			wasBusy: true,
			interrupted: true,
			stoppedTabIds: ['tab-b'],
			exited: false,
		});
		expect(tab('tab-b').state).toBe('idle');
		expect(tab('tab-b').logs.map((l) => l.source)).toEqual(['user', 'system']);
		expect(tab('tab-b').logs.at(-1)?.text).toBe('Canceled by user');
		expect(tab('tab-a').state).toBe('busy');
		expect(tab('tab-a').logs).toHaveLength(1);
		expect(agent().state).toBe('busy');
	});

	it('idles the agent when the stopped tab was its only turn', async () => {
		seedAgent({
			aiTabs: [
				createMockAITab({ id: 'tab-a', state: 'idle' }),
				createMockAITab({ id: 'tab-b', state: 'busy' }),
			],
		});

		await interruptTurn('agent-1', { tabId: 'tab-b' });

		expect(agent().state).toBe('idle');
	});

	it('leaves the queue to the exit listener', async () => {
		const queued: QueuedItem = {
			id: 'q1',
			timestamp: 1,
			tabId: 'tab-b',
			type: 'message',
			text: 'next',
		};
		seedAgent({ executionQueue: [queued] });
		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		registerTurnInterruptDeps({
			cancelPendingSynopsis: vi.fn(),
			processQueuedItem,
			ownsQueue: () => true,
		});

		await interruptTurn('agent-1', { tabId: 'tab-b' });

		expect(agent().executionQueue).toEqual([queued]);
		expect(processQueuedItem).not.toHaveBeenCalled();
	});
});

describe('interruptTurn: queued work after a whole-agent stop', () => {
	const queued: QueuedItem = {
		id: 'q1',
		timestamp: 1,
		tabId: 'tab-c',
		type: 'message',
		text: 'next',
	};

	it('starts the next item in the client that drains the queue', async () => {
		vi.useFakeTimers();
		try {
			seedAgent({ executionQueue: [queued] });
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			registerTurnInterruptDeps({
				cancelPendingSynopsis: vi.fn(),
				processQueuedItem,
				ownsQueue: () => true,
			});

			await interruptTurn('agent-1');
			await vi.runAllTimersAsync();

			expect(agent().executionQueue).toEqual([]);
			expect(processQueuedItem).toHaveBeenCalledWith('agent-1', queued);
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves the item queued for the owner in a browser client', async () => {
		// The owning desktop renderer's exit listener starts it. Taking it out here
		// either lost it or would send it twice.
		vi.useFakeTimers();
		try {
			seedAgent({ executionQueue: [queued] });
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			registerTurnInterruptDeps({
				cancelPendingSynopsis: vi.fn(),
				processQueuedItem,
				ownsQueue: () => false,
			});

			await interruptTurn('agent-1');
			await vi.runAllTimersAsync();

			expect(agent().executionQueue).toEqual([queued]);
			expect(processQueuedItem).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('interruptTurn: whole agent', () => {
	it("signals the active tab first, then every other busy tab, never the bare '-ai' id", async () => {
		seedAgent({ activeTabId: 'tab-c' });

		const result = await interruptTurn('agent-1');

		const signalled = processApi.interrupt.mock.calls.map(([id]) => id);
		expect(signalled[0]).toBe('agent-1-ai-tab-c');
		expect(signalled).toEqual(expect.arrayContaining(['agent-1-ai-tab-a', 'agent-1-ai-tab-b']));
		expect(signalled).not.toContain('agent-1-ai');
		expect(crossAgentApi.cancel).toHaveBeenCalledWith('agent-1', undefined);
		expect(result).toMatchObject({ success: true, tabId: null, wasBusy: true });
		expect(result.stoppedTabIds.sort()).toEqual(['tab-a', 'tab-b']);
		expect(agent().state).toBe('idle');
	});
});

describe('interruptTurn: nothing to stop', () => {
	it('answers wasBusy: false and writes nothing', async () => {
		seedAgent({
			state: 'idle',
			busySource: undefined,
			aiTabs: [createMockAITab({ id: 'tab-a', state: 'idle' })],
		});
		const before = agent();

		const result = await interruptTurn('agent-1');

		expect(result).toEqual({
			success: true,
			sessionId: 'agent-1',
			tabId: null,
			wasBusy: false,
			interrupted: false,
			stoppedTabIds: [],
			exited: false,
		});
		expect(processApi.interrupt).not.toHaveBeenCalled();
		expect(agent()).toBe(before);
	});

	it('counts a pending retry on an idle tab as something to stop', async () => {
		seedAgent({ aiTabs: [createMockAITab({ id: 'tab-a', state: 'idle' })] });
		vi.mocked(stopRetriesForAgent).mockReturnValueOnce(1);

		const result = await interruptTurn('agent-1', { tabId: 'tab-a' });

		expect(result).toMatchObject({ success: true, wasBusy: true, stoppedTabIds: [] });
	});
});

describe('interruptTurn: a signal that fails', () => {
	it('reports SIGNAL_FAILED to a remote caller and settles nothing', async () => {
		seedAgent();
		processApi.interrupt.mockRejectedValueOnce(new Error('EPERM'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await interruptTurn('agent-1', { tabId: 'tab-b' });

		expect(result).toMatchObject({
			success: false,
			code: 'SIGNAL_FAILED',
			error: 'EPERM',
			tabId: 'tab-b',
			wasBusy: true,
		});
		expect(processApi.kill).not.toHaveBeenCalled();
		expect(tab('tab-b').state).toBe('busy');
	});

	it('force-kills when the desktop confirms, then settles the tab', async () => {
		seedAgent();
		processApi.interrupt.mockRejectedValueOnce(new Error('EPERM'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await interruptTurn('agent-1', {
			tabId: 'tab-b',
			confirmForceKill: () => true,
		});

		expect(processApi.kill).toHaveBeenCalledWith('agent-1-ai-tab-b');
		expect(result).toMatchObject({ success: true, interrupted: true, stoppedTabIds: ['tab-b'] });
		expect(tab('tab-b').state).toBe('idle');
		expect(tab('tab-b').logs.at(-1)?.text).toBe('Process forcefully terminated');
	});
});
