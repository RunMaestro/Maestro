/**
 * Tests for src/renderer/services/autoTurn.ts: the renderer's side of a turn
 * sent on the Auto model.
 *
 * What these lock down: a routing never fails or stalls a send, a queued
 * message is routed when it is queued and never again, the answer is written
 * onto the tab the turn took, and a tier target that cannot be used stops the
 * launch by name.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import {
	ROUTE_BRIDGE_GRACE_MS,
	recentExchange,
	requestTurnRoute,
	resetAutoTurnForTests,
	routeQueuedAutoItem,
	settleAutoTurn,
	turnSpawnSettings,
} from '../../../renderer/services/autoTurn';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { codifyTurnSettings } from '../../../renderer/utils/providerTabSessions';
import { captureException } from '../../../renderer/utils/sentry';
import { MODEL_ROUTING_TIMEOUT_MS } from '../../../shared/local-models/model-routing-task';
import type { RouteTurnResult } from '../../../shared/local-models/model-routing-task';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AITab, LogEntry, QueuedItem, Session } from '../../../renderer/types';

const routeTurn = () => vi.mocked(window.maestro.localModels.routeTurn);

const DECISION: RouteTurnResult = {
	tier: 'medium',
	effort: 'low',
	engine: { id: 'embedding-router', label: 'Embedding router (Gemma)', calibrated: false },
	latencyMs: 31,
};
const STAMP = {
	tier: 'medium',
	effort: 'low',
	engine: 'Embedding router (Gemma)',
	calibrated: false,
};
const OFF: RouteTurnResult = { skipped: 'off', detail: 'Model routing is off.', latencyMs: 0 };

const entry = (source: LogEntry['source'], text: string, timestamp = 1): LogEntry =>
	({ id: `${source}-${timestamp}-${text.length}`, timestamp, source, text }) as LogEntry;

/** Seed one agent on the Auto model with one tab, and mark that tab as running a turn. */
function seed(options: { tab?: Partial<AITab>; session?: Partial<Session>; take?: boolean } = {}) {
	const tab = createMockAITab({ id: 'tab-1', ...options.tab });
	const session = createMockSession({
		id: 'agent-1',
		toolType: 'claude-code',
		customModel: 'auto',
		customEffort: 'high',
		aiTabs: [tab],
		activeTabId: tab.id,
		executionQueue: [],
		...options.session,
	});
	// The busy-write: the turn takes the tab with a pending stamp.
	const taken =
		options.take === false
			? session
			: {
					...session,
					aiTabs: session.aiTabs.map((t) =>
						t.id === tab.id
							? { ...t, state: 'busy' as const, ...codifyTurnSettings(t, session) }
							: t
					),
				};
	useSessionStore.setState({ sessions: [taken], activeSessionId: taken.id });
	return taken;
}

const liveTab = () => useSessionStore.getState().sessions[0].aiTabs[0];
const liveQueue = () => useSessionStore.getState().sessions[0].executionQueue;

const queuedItem = (overrides: Partial<QueuedItem> = {}): QueuedItem => ({
	id: 'item-1',
	timestamp: 1,
	tabId: 'tab-1',
	type: 'message',
	text: 'rename the helper',
	turnSettings: { model: 'auto', effort: 'high' },
	...overrides,
});

beforeEach(() => {
	resetAutoTurnForTests();
	routeTurn().mockReset();
	routeTurn().mockResolvedValue(DECISION);
	vi.mocked(captureException).mockClear();
	useSettingsStore.setState({ harnessTierDefaults: {}, localModelEndpoints: [] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('recentExchange', () => {
	it('is the last answer and the user message before it', () => {
		const tab = createMockAITab({
			logs: [
				entry('user', 'what does formatDate do?', 1),
				entry('thinking', 'reading the file', 2),
				entry('stdout', 'It formats a date.', 3),
			],
		});
		expect(recentExchange(tab)).toEqual({
			user: 'what does formatDate do?',
			assistant: 'It formats a date.',
		});
	});

	it('never takes the message being sent, whose bubble is already in the log', () => {
		const tab = createMockAITab({
			logs: [
				entry('user', 'first question', 1),
				entry('stdout', 'first answer', 2),
				entry('user', 'do it', 3),
			],
		});
		expect(recentExchange(tab)).toEqual({ user: 'first question', assistant: 'first answer' });
	});

	it('is nothing before the agent has answered anything', () => {
		expect(recentExchange(createMockAITab({ logs: [entry('user', 'hello', 1)] }))).toBeUndefined();
		expect(recentExchange(undefined)).toBeUndefined();
	});

	it('skips tool, system and error entries when it looks for the answer', () => {
		const tab = createMockAITab({
			logs: [
				entry('user', 'q', 1),
				entry('stdout', 'the answer', 2),
				entry('tool', 'Read file', 3),
				entry('system', 'Session resumed', 4),
				entry('error', 'spawn failed', 5),
			],
		});
		expect(recentExchange(tab)?.assistant).toBe('the answer');
	});
});

describe('requestTurnRoute', () => {
	it('asks about the prompt, with who the turn is for and the exchange before it', async () => {
		const session = seed({
			tab: { logs: [entry('user', 'q', 1), entry('stdout', 'a', 2)] },
		});
		const stamp = await requestTurnRoute({
			sessionId: session.id,
			tab: session.aiTabs[0],
			prompt: 'do it',
		});

		expect(stamp).toEqual(STAMP);
		expect(routeTurn()).toHaveBeenCalledWith({
			prompt: 'do it',
			recent: { user: 'q', assistant: 'a' },
			agentId: 'agent-1',
			tabId: 'tab-1',
		});
	});

	it('passes a patient timeout through for a turn nobody is typing at', async () => {
		await requestTurnRoute({ sessionId: 'agent-1', prompt: 'p', timeoutMs: 5000 });
		expect(routeTurn()).toHaveBeenCalledWith({ prompt: 'p', agentId: 'agent-1', timeoutMs: 5000 });
	});

	it('answers a skip as a stamp that says why', async () => {
		routeTurn().mockResolvedValue(OFF);
		expect(await requestTurnRoute({ sessionId: 'agent-1', prompt: 'p' })).toEqual({
			skipped: 'off',
			detail: 'Model routing is off.',
		});
	});

	it('never rejects: a request that fails is no decision, and is reported', async () => {
		routeTurn().mockRejectedValue(
			new Error("Error invoking remote method 'x': Error: bad request")
		);
		const stamp = await requestTurnRoute({ sessionId: 'agent-1', prompt: 'p' });

		expect(stamp).toMatchObject({ skipped: 'unavailable' });
		expect('detail' in stamp && stamp.detail).toContain('could not be asked');
		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it('stops waiting when the bridge never delivers an answer', async () => {
		vi.useFakeTimers();
		routeTurn().mockReturnValue(new Promise(() => {}));
		const pending = requestTurnRoute({ sessionId: 'agent-1', prompt: 'p' });

		await vi.advanceTimersByTimeAsync(MODEL_ROUTING_TIMEOUT_MS + ROUTE_BRIDGE_GRACE_MS);

		expect(await pending).toMatchObject({ skipped: 'unavailable' });
	});
});

describe('settleAutoTurn', () => {
	it('asks the router, writes the answer onto the tab, and returns the launch', async () => {
		seed();
		expect(liveTab().turnAuto).toEqual({ status: 'pending' });

		const launch = await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' });

		expect(launch).toEqual({
			model: 'sonnet',
			effort: 'low',
			route: STAMP,
			runOn: { type: 'provider' },
		});
		expect(liveTab()).toMatchObject({
			turnModel: 'sonnet',
			turnEffort: 'low',
			turnAuto: { status: 'routed', route: STAMP },
		});
		expect(routeTurn()).toHaveBeenCalledTimes(1);
		expect(routeTurn().mock.calls[0][0]).toMatchObject({ prompt: 'go', agentId: 'agent-1' });
	});

	it('is null for a turn on a named model, and asks nothing', async () => {
		seed({ session: { customModel: 'opus' } });
		expect(await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' })).toBeNull();
		expect(routeTurn()).not.toHaveBeenCalled();
	});

	it('is null when the agent or the tab is gone', async () => {
		seed();
		expect(await settleAutoTurn({ sessionId: 'nobody', tabId: 'tab-1', prompt: 'go' })).toBeNull();
		expect(await settleAutoTurn({ sessionId: 'agent-1', tabId: 'gone', prompt: 'go' })).toBeNull();
	});

	it('rule 2: with the router off the turn launches on the agent default', async () => {
		routeTurn().mockResolvedValue(OFF);
		seed();

		const launch = await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' });

		expect(launch).toEqual({
			effort: 'high',
			route: { skipped: 'off', detail: 'Model routing is off.' },
			runOn: { type: 'provider' },
		});
		expect(liveTab().turnAuto?.status).toBe('router-off');
		expect(liveTab().turnModel).toBeUndefined();
	});

	it('rule 1: a warm session keeps its model, whatever tier the router chose', async () => {
		seed({
			tab: {
				agentSessionId: 'claude-abc',
				turnProvider: 'claude-code',
				turnModel: 'haiku',
				logs: [entry('stdout', 'done', Date.now() - 20_000)],
			},
		});
		routeTurn().mockResolvedValue({ ...DECISION, tier: 'high' });

		const launch = await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' });

		expect(launch).toMatchObject({ model: 'haiku', effort: 'low' });
		expect(liveTab().turnAuto).toMatchObject({ status: 'routed', hold: { model: 'haiku' } });
	});

	it('asks nothing for a turn that took the tab with its answer already', async () => {
		const session = seed({ take: false });
		useSessionStore.setState({
			sessions: [
				{
					...session,
					aiTabs: session.aiTabs.map((t) => ({ ...t, ...codifyTurnSettings(t, session, STAMP) })),
				},
			],
		});

		const launch = await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' });

		expect(launch).toEqual({
			model: 'sonnet',
			effort: 'low',
			route: STAMP,
			runOn: { type: 'provider' },
		});
		expect(routeTurn()).not.toHaveBeenCalled();
	});

	it('throws, naming the target, when the tier the router chose cannot be used', async () => {
		seed({
			session: {
				toolType: 'factory-droid',
				tierTargets: { medium: { type: 'source', endpointId: 'ep-x', model: 'qwen3' } },
			},
		});

		await expect(
			settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' })
		).rejects.toThrow(/This agent's "medium" tier target/);
		expect(liveTab().turnAuto?.refusal).toMatch(/tier target/);
	});

	it('settles a tab that was closed mid-turn where it lives now, as an orphan', async () => {
		const session = seed();
		useSessionStore.setState({
			sessions: [{ ...session, aiTabs: [], orphanedThinkingTabs: session.aiTabs }],
		});

		const launch = await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' });

		expect(launch).toMatchObject({ model: 'sonnet' });
		expect(useSessionStore.getState().sessions[0].orphanedThinkingTabs?.[0].turnAuto?.status).toBe(
			'routed'
		);
	});

	it('still returns the launch when the tab vanished while the router was out', async () => {
		seed();
		routeTurn().mockImplementation(async () => {
			useSessionStore.setState({ sessions: [] });
			return DECISION;
		});

		expect(await settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'go' })).toEqual({
			model: 'sonnet',
			effort: 'low',
			route: STAMP,
			runOn: { type: 'provider' },
		});
	});
});

describe('routeQueuedAutoItem: a queued message is routed when it is queued', () => {
	it('writes the answer onto the item while it waits', async () => {
		const session = seed({ take: false });
		const item = queuedItem();
		useSessionStore.setState({ sessions: [{ ...session, executionQueue: [item] }] });

		routeQueuedAutoItem('agent-1', item);
		expect(routeTurn()).toHaveBeenCalledTimes(1);
		expect(routeTurn().mock.calls[0][0]).toMatchObject({
			prompt: 'rename the helper',
			agentId: 'agent-1',
			tabId: 'tab-1',
		});

		await vi.waitFor(() => expect(liveQueue()[0].turnSettings?.route).toEqual(STAMP));
		expect(liveQueue()[0].turnSettings).toEqual({ model: 'auto', effort: 'high', route: STAMP });
	});

	it('does nothing for an item on a named model, a routed one, or one with no text', () => {
		seed({ take: false });
		routeQueuedAutoItem('agent-1', queuedItem({ turnSettings: { model: 'opus' } }));
		routeQueuedAutoItem('agent-1', queuedItem({ turnSettings: { model: 'auto', route: STAMP } }));
		routeQueuedAutoItem('agent-1', queuedItem({ type: 'command', text: undefined, command: '/x' }));
		routeQueuedAutoItem('agent-1', queuedItem({ text: '   ' }));
		routeQueuedAutoItem('agent-1', queuedItem({ turnSettings: undefined }));
		expect(routeTurn()).not.toHaveBeenCalled();
	});

	it('asks once for one item, however many times it is called', () => {
		seed({ take: false });
		const item = queuedItem();
		routeQueuedAutoItem('agent-1', item);
		routeQueuedAutoItem('agent-1', item);
		expect(routeTurn()).toHaveBeenCalledTimes(1);
	});

	it('does not write an answer onto an item whose text was edited meanwhile', async () => {
		const session = seed({ take: false });
		const item = queuedItem();
		useSessionStore.setState({ sessions: [{ ...session, executionQueue: [item] }] });
		let answer: (result: RouteTurnResult) => void = () => {};
		routeTurn().mockReturnValue(new Promise((resolve) => (answer = resolve)));

		routeQueuedAutoItem('agent-1', item);
		useSessionStore.setState({
			sessions: [{ ...session, executionQueue: [{ ...item, text: 'rewrite the module' }] }],
		});
		answer(DECISION);
		await Promise.resolve();
		await Promise.resolve();

		expect(liveQueue()[0].turnSettings?.route).toBeUndefined();
	});

	it('a drain inside the window waits on the same routing instead of asking twice', async () => {
		seed();
		let answer: (result: RouteTurnResult) => void = () => {};
		routeTurn().mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const item = queuedItem();

		routeQueuedAutoItem('agent-1', item);
		const settling = settleAutoTurn({
			sessionId: 'agent-1',
			tabId: 'tab-1',
			prompt: item.text!,
			itemId: item.id,
		});
		answer(DECISION);

		expect(await settling).toMatchObject({ model: 'sonnet', effort: 'low' });
		expect(routeTurn()).toHaveBeenCalledTimes(1);
	});

	it('a drain of an edited item asks about the words it has now', async () => {
		seed();
		let answer: (result: RouteTurnResult) => void = () => {};
		routeTurn().mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const item = queuedItem();

		routeQueuedAutoItem('agent-1', item);
		const settling = settleAutoTurn({
			sessionId: 'agent-1',
			tabId: 'tab-1',
			prompt: 'rewrite the module',
			itemId: item.id,
		});
		answer(DECISION);
		await settling;

		expect(routeTurn()).toHaveBeenCalledTimes(2);
		expect(routeTurn().mock.calls[1][0]).toMatchObject({ prompt: 'rewrite the module' });
	});
});

describe('turnSpawnSettings', () => {
	it("passes the caller's own model and effort for a turn that was not sent on Auto", () => {
		expect(turnSpawnSettings(null, { model: 'opus', effort: 'high' })).toEqual({
			sessionCustomModel: 'opus',
			sessionCustomEffort: 'high',
		});
	});

	it("passes the settled Auto turn's, and the place only when Auto decided one", () => {
		const runOn = { type: 'source' as const, endpointId: 'ep', model: 'qwen3' };
		expect(turnSpawnSettings({ model: 'sonnet', effort: 'low' }, { model: 'auto' })).toEqual({
			sessionCustomModel: 'sonnet',
			sessionCustomEffort: 'low',
		});
		expect(turnSpawnSettings({ model: 'qwen3', runOn }, { model: 'auto' })).toEqual({
			sessionCustomModel: 'qwen3',
			sessionCustomEffort: undefined,
			runOnOverride: runOn,
		});
	});

	it('never passes the word auto: no decision is no model at all', () => {
		expect(turnSpawnSettings({}, { model: 'auto', effort: 'high' })).toEqual({
			sessionCustomModel: undefined,
			sessionCustomEffort: undefined,
		});
	});
});

it('rejects a late router answer after a new turn takes the same tab', async () => {
	seed();
	let answer!: (value: RouteTurnResult) => void;
	routeTurn().mockReturnValue(
		new Promise((resolve) => {
			answer = resolve;
		})
	);
	const pending = settleAutoTurn({ sessionId: 'agent-1', tabId: 'tab-1', prompt: 'old turn' });
	const owner = useSessionStore.getState().sessions[0];
	useSessionStore.setState({
		sessions: [
			{
				...owner,
				aiTabs: owner.aiTabs.map((tab) => ({ ...tab, ...codifyTurnSettings(tab, owner) })),
			},
		],
	});
	const freshStamp = liveTab().turnAuto;
	answer(DECISION);
	await expect(pending).rejects.toThrow('pending turn changed');
	expect(liveTab().turnAuto).toBe(freshStamp);
});

it('passes a captured provider Run on target for a named model', () => {
	expect(turnSpawnSettings(null, { model: 'opus', runOn: { type: 'provider' } })).toEqual({
		sessionCustomModel: 'opus',
		sessionCustomEffort: undefined,
		runOnOverride: { type: 'provider' },
	});
});
