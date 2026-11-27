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
import { AGENT_MODES, createMockSession, createModeSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { QueuedItem, Session } from '../../../renderer/types';
import { TURN_CANCELED_NOTE } from '../../../shared/maestro-lib/store/transcript';

vi.mock('../../../renderer/stores/retryStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/retryStore')>()),
	stopRetriesForAgent: vi.fn(() => 0),
	cancelContextCompaction: vi.fn(() => 0),
}));
vi.mock('../../../renderer/services/crossAgentHandoff', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/services/crossAgentHandoff')>()),
	dropMentionHandoffs: vi.fn(),
}));
vi.mock('../../../renderer/services/hostedQueuedTurn', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../renderer/services/hostedQueuedTurn')>();
	return {
		...actual,
		dropStoppedHostStartMentions: vi.fn(actual.dropStoppedHostStartMentions),
		settleStoppedHostStartMentions: vi.fn(actual.settleStoppedHostStartMentions),
	};
});
vi.mock('../../../renderer/services/peerMirror', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/services/peerMirror')>()),
	interruptMirroredAgent: vi.fn(async () => undefined),
}));

import { interruptTurn, registerTurnInterruptDeps } from '../../../renderer/services/turnInterrupt';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { cancelContextCompaction, stopRetriesForAgent } from '../../../renderer/stores/retryStore';
import { dropMentionHandoffs } from '../../../renderer/services/crossAgentHandoff';
import { interruptMirroredAgent } from '../../../renderer/services/peerMirror';
import {
	dropStoppedHostStartMentions,
	settleStoppedHostStartMentions,
} from '../../../renderer/services/hostedQueuedTurn';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useCrossAgentInFlightStore } from '../../../renderer/stores/crossAgentInFlightStore';

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

	it('writes the line on a tab whose consult Stop ended before that tab starts its next message (CodeRabbit on #2154)', async () => {
		vi.useFakeTimers();
		try {
			seedAgent({ executionQueue: [queued] });
			crossAgentApi.cancel.mockResolvedValue({ canceled: 1 });
			useCrossAgentInFlightStore.setState({ requests: {} });
			useCrossAgentInFlightStore.getState().start({
				requestId: 'r-c',
				sourceSessionId: 'agent-1',
				sourceTabId: 'tab-c',
				targetSessionId: 'backend',
				targetAgentName: 'Backend',
				startedAt: 1,
			});
			registerTurnInterruptDeps({
				cancelPendingSynopsis: vi.fn(),
				processQueuedItem: vi.fn().mockResolvedValue(undefined),
				ownsQueue: () => true,
			});

			await interruptTurn('agent-1');
			await vi.runAllTimersAsync();

			const texts = tab('tab-c').logs.map((l) => l.text);
			expect(texts.filter((text) => text === TURN_CANCELED_NOTE)).toHaveLength(1);
			expect(tab('tab-c').state).toBe('busy');
		} finally {
			useCrossAgentInFlightStore.setState({ requests: {} });
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

describe('interruptTurn: an Auto Run task turn, which runs on no tab', () => {
	afterEach(() => {
		useSettingsStore.setState({ federationHostedAgents: false });
		useBatchStore.setState({ batchRunStates: {} } as never);
	});

	it('stops the running Auto Run turn and reports it in every mode', async () => {
		useSettingsStore.setState({ federationHostedAgents: true });
		const results = [];
		for (const mode of AGENT_MODES) {
			vi.clearAllMocks();
			processApi.interrupt.mockResolvedValue(true);
			crossAgentApi.cancel.mockResolvedValue({ canceled: 0 });
			// A goal run's iteration: the agent's tabs are idle and its turn is `-batch-`.
			processApi.getActiveProcesses.mockResolvedValue([
				{ sessionId: 'agent-1-batch-1700', isTerminal: false },
			]);
			useBatchStore.setState({
				batchRunStates: { 'agent-1': { isRunning: true, isStopping: true } },
			} as never);
			const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession(mode);
			seedAgent({
				state: 'idle',
				busySource: undefined,
				aiTabs: [createMockAITab({ id: 'tab-a', state: 'idle' })],
				sshRemoteId,
				sessionSshRemoteConfig,
				liftedTo,
			});

			results.push(await interruptTurn('agent-1'));

			if (mode === 'hosted') {
				// The host runs the Auto Run: the stop goes there.
				expect(interruptMirroredAgent).toHaveBeenCalledWith('box', 'h1', undefined);
			} else {
				expect(processApi.interrupt.mock.calls.map(([id]) => id)).toContain('agent-1-batch-1700');
			}
		}
		const [local, ssh, hosted] = results;
		expect(local).toEqual({
			success: true,
			sessionId: 'agent-1',
			tabId: null,
			wasBusy: true,
			interrupted: true,
			stoppedTabIds: [],
			exited: false,
		});
		expect(ssh).toEqual(local);
		expect(hosted).toEqual(local);
	});

	it('leaves the Auto Run turn alone when the stop names one tab', async () => {
		processApi.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'agent-1-batch-1700', isTerminal: false },
		]);
		seedAgent({ aiTabs: [createMockAITab({ id: 'tab-a', state: 'idle' })] });

		const result = await interruptTurn('agent-1', { tabId: 'tab-a' });

		expect(result.wasBusy).toBe(false);
		expect(processApi.interrupt).not.toHaveBeenCalled();
	});
});

describe('interruptTurn: mode parity (local, SSH, hosted)', () => {
	afterEach(() => {
		useSettingsStore.setState({ federationHostedAgents: false });
	});

	it('answers the same Stop in every mode; only the transport differs', async () => {
		useSettingsStore.setState({ federationHostedAgents: true });
		const results = [];
		for (const mode of AGENT_MODES) {
			vi.clearAllMocks();
			processApi.interrupt.mockResolvedValue(true);
			processApi.getActiveProcesses.mockResolvedValue([]);
			crossAgentApi.cancel.mockResolvedValue({ canceled: 0 });
			const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession(mode);
			seedAgent({ sshRemoteId, sessionSshRemoteConfig, liftedTo });

			results.push(await interruptTurn('agent-1'));

			if (mode === 'hosted') {
				// The host runs the turn: Stop goes there, and its transcript ends on the same
				// note (`buildTurnTranscript`, record-turn.test.ts).
				expect(interruptMirroredAgent).toHaveBeenCalledWith('box', 'h1', undefined);
				expect(processApi.interrupt).not.toHaveBeenCalled();
			} else {
				expect(processApi.interrupt.mock.calls.map(([id]) => id)).toEqual([
					'agent-1-ai-tab-a',
					'agent-1-ai-tab-b',
				]);
				expect(interruptMirroredAgent).not.toHaveBeenCalled();
				expect(tab('tab-a').logs.at(-1)?.text).toBe(TURN_CANCELED_NOTE);
			}
		}
		const [local, ssh, hosted] = results;
		expect(local).toEqual({
			success: true,
			sessionId: 'agent-1',
			tabId: null,
			wasBusy: true,
			interrupted: true,
			stoppedTabIds: ['tab-a', 'tab-b'],
			exited: false,
		});
		expect(ssh).toEqual(local);
		expect(hosted).toEqual(local);
	});

	// Parity M7: a hosted agent's `@mentions` run on this machine, so Stop ends them here as it
	// does for a local agent: the consults, and the hand-off armed for the turn.
	it.each(AGENT_MODES)("%s: Stop ends the turn's consults and drops its hand-off", async (mode) => {
		useSettingsStore.setState({ federationHostedAgents: true });
		vi.clearAllMocks();
		processApi.interrupt.mockResolvedValue(true);
		processApi.getActiveProcesses.mockResolvedValue([]);
		crossAgentApi.cancel.mockResolvedValue({ canceled: 1 });
		const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession(mode);
		seedAgent({ sshRemoteId, sessionSshRemoteConfig, liftedTo });

		const result = await interruptTurn('agent-1', { tabId: 'tab-a' });

		expect(crossAgentApi.cancel).toHaveBeenCalledWith('agent-1', 'tab-a');
		expect(dropMentionHandoffs).toHaveBeenCalledWith('agent-1', 'tab-a');
		// Before any await: a host update meanwhile cannot release the stopped hand-off.
		if (mode === 'hosted') {
			expect(vi.mocked(dropMentionHandoffs).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(interruptMirroredAgent).mock.invocationCallOrder[0]
			);
		}
		expect(result).toMatchObject({ success: true, wasBusy: true, interrupted: true });
	});

	// Parity M25: a consult Stop may have ended waits for the host's answer to the Stop, because a
	// start the host reported before it ran before the host stopped anything.
	it.each([
		['answers', async () => undefined],
		['fails', async () => Promise.reject(new Error('link down'))],
	] as const)(
		'hosted: Stop settles the consults it left waiting only once the host %s (M25)',
		async (_outcome, answer) => {
			useSettingsStore.setState({ federationHostedAgents: true });
			vi.clearAllMocks();
			crossAgentApi.cancel.mockResolvedValue({ canceled: 0 });
			let settledBeforeAnswer = true;
			vi.mocked(interruptMirroredAgent).mockImplementationOnce(async () => {
				settledBeforeAnswer = vi.mocked(settleStoppedHostStartMentions).mock.calls.length > 0;
				return answer();
			});
			const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession('hosted');
			seedAgent({ sshRemoteId, sessionSshRemoteConfig, liftedTo });

			await interruptTurn('agent-1', { tabId: 'tab-a' }).catch(() => undefined);

			expect(dropStoppedHostStartMentions).toHaveBeenCalledWith('agent-1', ['tab-a']);
			expect(vi.mocked(dropStoppedHostStartMentions).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(interruptMirroredAgent).mock.invocationCallOrder[0]
			);
			expect(settledBeforeAnswer).toBe(false);
			// The settle is this Stop's own: the token its drop handed back.
			expect(settleStoppedHostStartMentions).toHaveBeenCalledWith(
				vi.mocked(dropStoppedHostStartMentions).mock.results[0].value
			);
		}
	);

	// Parity M21: Stop during a consult whose tab runs no turn (a mention consulting before its
	// turn, or a tab held for the reply) ends on the same "Canceled by user" line in every mode.
	it.each(AGENT_MODES)(
		'%s: Stop during a consult ends the tab on the same "Canceled by user" line (M21)',
		async (mode) => {
			useSettingsStore.setState({ federationHostedAgents: true });
			vi.clearAllMocks();
			processApi.interrupt.mockResolvedValue(true);
			processApi.getActiveProcesses.mockResolvedValue([]);
			crossAgentApi.cancel.mockResolvedValue({ canceled: 1 });
			const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession(mode);
			const seeded = seedAgent({ sshRemoteId, sessionSshRemoteConfig, liftedTo });
			useSessionStore.setState({
				sessions: [
					{
						...seeded,
						state: 'idle',
						busySource: undefined,
						aiTabs: seeded.aiTabs.map((t) => ({ ...t, state: 'idle' as const })),
					},
				],
			} as any);

			const result = await interruptTurn('agent-1', { tabId: 'tab-a' });

			expect(result).toMatchObject({ success: true, wasBusy: true });
			expect(tab('tab-a').state).toBe('idle');
			expect(tab('tab-a').logs.filter((l) => l.text === TURN_CANCELED_NOTE)).toHaveLength(1);
			expect(tab('tab-a').logs.at(-1)?.text).toBe(TURN_CANCELED_NOTE);
		}
	);

	// Parity M21 (review of #2154): the line goes on the tab whose consult Stop ended, not on the
	// active tab, through the same settle in every mode.
	it.each(AGENT_MODES)(
		'%s: a whole-agent Stop writes "Canceled by user" on the tab whose consult it ended (M21)',
		async (mode) => {
			useSettingsStore.setState({ federationHostedAgents: true });
			vi.clearAllMocks();
			processApi.interrupt.mockResolvedValue(true);
			processApi.getActiveProcesses.mockResolvedValue([]);
			crossAgentApi.cancel.mockResolvedValue({ canceled: 1 });
			const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession(mode);
			const seeded = seedAgent({ sshRemoteId, sessionSshRemoteConfig, liftedTo });
			useSessionStore.setState({
				sessions: [
					{
						...seeded,
						state: 'idle',
						busySource: undefined,
						aiTabs: seeded.aiTabs.map((t) => ({ ...t, state: 'idle' as const })),
					},
				],
			} as any);
			useCrossAgentInFlightStore.setState({ requests: {} });
			useCrossAgentInFlightStore.getState().start({
				requestId: 'r1',
				sourceSessionId: 'agent-1',
				sourceTabId: 'tab-c',
				targetSessionId: 'backend',
				targetAgentName: 'Backend',
				startedAt: 1,
			});

			const result = await interruptTurn('agent-1');

			expect(result).toMatchObject({ success: true, wasBusy: true });
			const notes = (id: string) => tab(id).logs.filter((l) => l.text === TURN_CANCELED_NOTE);
			expect(notes('tab-c')).toHaveLength(1);
			expect(tab('tab-c').logs.at(-1)?.text).toBe(TURN_CANCELED_NOTE);
			expect(tab('tab-c').state).toBe('idle');
			expect(notes('tab-a')).toHaveLength(0);
			useCrossAgentInFlightStore.setState({ requests: {} });
		}
	);

	it('hosted: a tab whose turn the host stopped gets no second line here (the host writes it) (M21)', async () => {
		useSettingsStore.setState({ federationHostedAgents: true });
		crossAgentApi.cancel.mockResolvedValue({ canceled: 1 });
		const { sshRemoteId, sessionSshRemoteConfig, liftedTo } = createModeSession('hosted');
		seedAgent({ sshRemoteId, sessionSshRemoteConfig, liftedTo });

		await interruptTurn('agent-1', { tabId: 'tab-a' });

		expect(interruptMirroredAgent).toHaveBeenCalled();
		expect(tab('tab-a').logs.some((l) => l.text === TURN_CANCELED_NOTE)).toBe(false);
	});
});
