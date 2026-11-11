import { agentCommandScope } from '../../../renderer/utils/agentCommands';
import { registerSessionPersistenceFlush } from '../../../renderer/services/sessionPersistenceFlush';
/**
 * Tests for src/renderer/services/queuedPrompt.ts
 *
 * The queue item a non-composer prompt becomes. Three of its fields are easy to
 * drop and each has a visible cost: `tabName` is what a closed tab's item falls
 * back to, `readOnlyMode` is what lets it bypass the parallel-execution guard,
 * and `turnSettings` is what keeps a queued turn on the model it was queued
 * with. The `@mention` flags must be STAMPED but not fired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

const planCrossAgentMentions = vi.fn();
vi.mock('../../../renderer/services/crossAgentMentions', async (importOriginal) => ({
	// The real `queuedMentionFields`: the fields a queued item carries are the
	// composer's own, so the test reads them through the same function.
	...(await importOriginal<typeof import('../../../renderer/services/crossAgentMentions')>()),
	planCrossAgentMentions: (...args: unknown[]) => planCrossAgentMentions(...args),
}));

import {
	buildQueuedMessageItem,
	enqueuePromptForTab,
	getQueuedCommandScopeRefusal,
	getQueuedCommandSelectionRefusal,
	getQueuedCommandSpawnSelection,
	mergeQueuedItemIntoAbove,
	removeQueuedItem,
	sendQueuedItemNow,
	setQueuedItemPaused,
	toggleQueuedItemPaused,
} from '../../../renderer/services/queuedPrompt';
import { registerDispatchDepsProvider } from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { QueuedItem, Session } from '../../../renderer/types';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { resetStores } from '../../helpers/resetStores';
import { fingerprintGrokSpawnSelection } from '../../../shared/grokSpawnSelection';
import { sha256Hex } from '../../../shared/maestro-lib/grok/host-seams';

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 'session-1',
		aiTabs: [
			createMockAITab({ id: 'a', name: 'Alpha' }),
			createMockAITab({ id: 'b', name: 'Bravo' }),
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a' },
			{ type: 'ai', id: 'b' },
		],
		activeTabId: 'a',
		executionQueue: [],
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

function currentQueue() {
	return useSessionStore.getState().sessions[0].executionQueue;
}

describe('buildQueuedMessageItem', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('builds a message item pinned to the given tab', () => {
		const session = seed();
		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[1],
			text: 'carry on',
		});

		expect(item.type).toBe('message');
		expect(item.tabId).toBe('b');
		expect(item.text).toBe('carry on');
		expect(item.tabName).toBe('Bravo');
		// Present, so a queue that drains after a model switch still runs under
		// what was selected when it was queued.
		expect(item.turnSettings).toBeDefined();
	});

	// A prompt another agent's `maestro-cli dispatch` queued carries the place in
	// the consult chain its turn takes; the spawn reads it off the item.
	it('carries a consult chain on the item when the caller was admitted to one', () => {
		const session = seed();
		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[1],
			text: 'take this over',
			consultChain: { chainId: 'chain-a', depth: 2 },
		});

		expect(item.consultChain).toEqual({ chainId: 'chain-a', depth: 2 });
	});

	it('leaves the consult chain off everything else', () => {
		const session = seed();
		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[1], text: 'carry on' });

		expect(item).not.toHaveProperty('consultChain');
	});

	it('marks an item queued from a read-only tab', () => {
		const session = seed({
			aiTabs: [createMockAITab({ id: 'a', name: 'Alpha', readOnlyMode: true })],
			unifiedTabOrder: [{ type: 'ai', id: 'a' }],
		});
		expect(
			buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'look only' }).readOnlyMode
		).toBe(true);
	});

	it('stamps the @mention intent without firing the consult', () => {
		planCrossAgentMentions.mockReturnValue({ targetSessionIds: ['other'], suppressLocal: true });
		const session = seed();

		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: '@Other look' });

		expect(item.crossAgentMention).toBe(true);
		expect(item.crossAgentOnly).toBe(true);
		// Planning only - dispatching is processQueuedItem's job at drain time.
		expect(planCrossAgentMentions).toHaveBeenCalledWith('@Other look', 'session-1', undefined);
		// No routing was picked, so the drain re-plans from the wording.
		expect(item.mentionRouting).toBeUndefined();
	});

	it('stamps a picked routing so the drain does not re-route it by wording', () => {
		planCrossAgentMentions.mockReturnValue({
			targetSessionIds: ['other'],
			routing: 'handoff',
			inferredRouting: 'parallel',
			routingSource: 'explicit',
			suppressLocal: false,
		});
		const session = seed();

		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[0],
			text: 'fix it, @Other too',
			mentionRouting: 'handoff',
		});

		expect(planCrossAgentMentions).toHaveBeenCalledWith(
			'fix it, @Other too',
			'session-1',
			'handoff'
		);
		expect(item).toMatchObject({
			crossAgentMention: true,
			crossAgentOnly: false,
			mentionRouting: 'handoff',
		});
	});

	it('leaves the mention flags off a message that mentions nobody', () => {
		const session = seed();
		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'plain' });
		expect(item.crossAgentMention).toBeUndefined();
		expect(item.crossAgentOnly).toBeUndefined();
	});

	it('queues a slash command with arguments and frozen turn settings', () => {
		const session = seed();
		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[1],
			text: ' /triage\tissue 123 ',
			slashCommand: true,
		});

		expect(item).toMatchObject({
			type: 'command',
			command: '/triage',
			commandArgs: 'issue 123',
			tabId: 'b',
			tabName: 'Bravo',
		});
		expect(item.turnSettings).toBeDefined();
		expect(item.text).toBeUndefined();
		expect(planCrossAgentMentions).not.toHaveBeenCalled();
	});
});

describe('enqueuePromptForTab', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('appends to the tail of the agent execution queue', () => {
		seed();
		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'first' });
		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'second' });

		expect(currentQueue().map((item) => item.text)).toEqual(['first', 'second']);
	});

	it('queues the consult chain with the prompt', () => {
		seed();
		enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'b',
			text: 'take this over',
			consultChain: { chainId: 'chain-a', depth: 2 },
		});

		expect(currentQueue()[0].consultChain).toEqual({ chainId: 'chain-a', depth: 2 });
	});

	it('carries a picked mention routing onto the queued item', () => {
		planCrossAgentMentions.mockReturnValue({
			targetSessionIds: ['other'],
			routing: 'consult-first',
			inferredRouting: 'parallel',
			routingSource: 'explicit',
			suppressLocal: true,
		});
		seed();
		enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'a',
			text: 'review, ask @Other',
			mentionRouting: 'consult-first',
		});

		expect(planCrossAgentMentions).toHaveBeenCalledWith(
			'review, ask @Other',
			'session-1',
			'consult-first'
		);
		expect(currentQueue()[0]).toMatchObject({
			mentionRouting: 'consult-first',
			crossAgentOnly: true,
		});
	});

	it('falls back to the active tab when the target tab is gone', () => {
		// Losing the prompt because a tab moved is worse than answering it in the
		// tab next door - the caller has already decided this agent gets asked.
		seed();
		const item = enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'vanished',
			text: 'still ask',
		});

		expect(item!.tabId).toBe('a');
		expect(currentQueue()).toHaveLength(1);
	});

	it('returns null and queues nothing for an unknown agent', () => {
		seed();
		expect(enqueuePromptForTab({ sessionId: 'ghost', tabId: 'a', text: 'nope' })).toBeNull();
		expect(currentQueue()).toHaveLength(0);
	});

	it('returns null when the agent has no AI tab to answer in', () => {
		seed({ aiTabs: [], unifiedTabOrder: [], activeTabId: undefined });
		expect(enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'nope' })).toBeNull();
		expect(currentQueue()).toHaveLength(0);
	});

	// A prompt queued for an agent on the Auto model is routed as it is queued,
	// like one the composer queues, and the answer rides on the item.
	it('routes a prompt queued for an agent set to the Auto model', async () => {
		const routeTurn = vi.mocked(window.maestro.localModels.routeTurn);
		routeTurn.mockResolvedValueOnce({
			tier: 'low',
			effort: 'low',
			engine: { id: 'embedding-router', label: 'Embedding router', calibrated: false },
			latencyMs: 12,
		});
		seed({ customModel: 'auto' });

		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'tidy up' });

		expect(item!.turnSettings).toMatchObject({
			provider: 'claude-code',
			model: 'auto',
			effort: undefined,
		});
		expect(routeTurn).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: 'tidy up', agentId: 'session-1', tabId: 'b' })
		);
		await vi.waitFor(() =>
			expect(currentQueue()[0].turnSettings?.route).toEqual({
				tier: 'low',
				effort: 'low',
				engine: 'Embedding router',
				calibrated: false,
			})
		);
	});

	it('asks the router nothing for an agent on a named model', () => {
		const routeTurn = vi.mocked(window.maestro.localModels.routeTurn);
		routeTurn.mockClear();
		seed({ customModel: 'opus' });

		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'carry on' });

		expect(routeTurn).not.toHaveBeenCalled();
	});
});

describe('enqueuePromptForTab with expandCommands', () => {
	const deps = {
		conductorProfile: '',
		customAICommands: [{ id: 'c', command: '/commit', description: 'Commit', prompt: 'do it' }],
		speckitCommands: [],
		openspecCommands: [],
	};

	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
		registerDispatchDepsProvider(() => deps as never);
	});
	afterEach(() => registerDispatchDepsProvider(null));

	it('expands discovered commands only for the addressed provider scope', () => {
		const session = seed({
			agentCommands: [{ command: '/codex-skill', description: 'Codex', prompt: 'Do Codex work' }],
		});
		session.aiTabs[1].tabProvider = 'codex';
		session.agentCommandsScope = agentCommandScope(session, session.aiTabs[1]);
		expect(
			enqueuePromptForTab({
				sessionId: session.id,
				tabId: 'a',
				text: '/codex-skill',
				expandCommands: true,
			})?.type
		).toBe('message');
		expect(
			enqueuePromptForTab({
				sessionId: session.id,
				tabId: 'b',
				text: '/codex-skill',
				expandCommands: true,
			})?.type
		).toBe('command');
	});

	it('queues a message that is exactly a slash command as that command', () => {
		seed();
		const item = enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'b',
			text: ' /commit ',
			slashCommand: false,
			expandCommands: true,
		});
		expect(item).toMatchObject({
			type: 'command',
			command: '/commit',
			commandDescription: 'Commit',
			tabId: 'b',
			tabName: 'Bravo',
		});
		expect(item?.text).toBeUndefined();
		expect(currentQueue()).toEqual([item]);
	});

	it.each([
		{ text: ' /commit\tissue 123 ', commandArgs: 'issue 123' },
		{ text: '/commit', commandArgs: '' },
	])(
		'preserves explicit Cue command arguments for "$text" with both options enabled',
		({ text, commandArgs }) => {
			seed();
			const item = enqueuePromptForTab({
				sessionId: 'session-1',
				tabId: 'b',
				text,
				slashCommand: true,
				expandCommands: true,
			});

			expect(item).toMatchObject({
				type: 'command',
				command: '/commit',
				commandArgs,
				tabId: 'b',
				tabName: 'Bravo',
			});
			expect(item?.turnSettings).toBeDefined();
			expect(item?.text).toBeUndefined();
			expect(currentQueue()).toEqual([item]);
			expect(planCrossAgentMentions).not.toHaveBeenCalled();
		}
	);

	it('leaves the same text a literal message for a caller that did not ask', () => {
		seed();
		expect(
			enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: '/commit' })
		).toMatchObject({ type: 'message', text: '/commit' });
	});

	it('leaves an unknown command, and a command inside a sentence, as messages', () => {
		seed();
		for (const text of ['/nope', 'please run /commit now', '/commit issue 123']) {
			expect(
				enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text, expandCommands: true })
			).toMatchObject({ type: 'message', text });
		}
	});
});

describe('removeQueuedItem', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('takes the item out and says it was there', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		expect(removeQueuedItem('session-1', item.id)).toBe(true);
		expect(currentQueue()).toEqual([]);
	});

	it('says no when the item already left the queue, so it is not sent twice', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		removeQueuedItem('session-1', item.id);
		expect(removeQueuedItem('session-1', item.id)).toBe(false);
		expect(removeQueuedItem('missing-session', item.id)).toBe(false);
	});
});

describe('setQueuedItemPaused / toggleQueuedItemPaused', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('holds and resumes, the card toggle and the CLI writing the same flag', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;

		expect(toggleQueuedItemPaused('session-1', item.id)).toBe(true);
		expect(currentQueue()[0].paused).toBe(true);
		expect(toggleQueuedItemPaused('session-1', item.id)).toBe(true);
		expect(currentQueue()[0].paused).toBeUndefined();

		expect(setQueuedItemPaused('session-1', item.id, true)).toBe(true);
		expect(setQueuedItemPaused('session-1', item.id, true)).toBe(true);
		expect(currentQueue()[0].paused).toBe(true);
		expect(setQueuedItemPaused('session-1', item.id, false)).toBe(true);
		expect(currentQueue()[0].paused).toBeUndefined();
	});

	it('says no for an item that is not queued', () => {
		seed();
		expect(toggleQueuedItemPaused('session-1', 'ghost')).toBe(false);
		expect(setQueuedItemPaused('missing-session', 'ghost', true)).toBe(false);
	});
});

describe('mergeQueuedItemIntoAbove', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('folds the item into the message above it and returns that id', () => {
		seed();
		const first = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'one' })!;
		const second = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'two' })!;
		expect(mergeQueuedItemIntoAbove('session-1', second.id)).toBe(first.id);
		expect(currentQueue()).toHaveLength(1);
		expect(currentQueue()[0]).toMatchObject({ id: first.id, text: 'one\n\ntwo' });
	});

	it('returns null and leaves the queue alone when nothing is above it', () => {
		seed();
		const only = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'one' })!;
		expect(mergeQueuedItemIntoAbove('session-1', only.id)).toBeNull();
		expect(currentQueue()).toHaveLength(1);
		expect(mergeQueuedItemIntoAbove('missing-session', only.id)).toBeNull();
	});
});

describe('sendQueuedItemNow', () => {
	it('keeps technical admission held across user resume and force send', () => {
		const held = {
			id: 'held',
			timestamp: 0,
			tabId: 'b',
			type: 'message' as const,
			text: 'hi',
			paused: true,
			pendingAdmissionId: 'dispatch-1',
		};
		seed({ executionQueue: [held] });
		const dispatch = vi.fn().mockResolvedValue(true);
		expect(setQueuedItemPaused('session-1', held.id, false)).toBe(true);
		expect(currentQueue()[0]).toMatchObject({ pendingAdmissionId: 'dispatch-1' });
		expect(sendQueuedItemNow('session-1', held.id, dispatch)).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(currentQueue()).toHaveLength(1);
	});
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	function setTabState(tabId: string, state: 'idle' | 'busy') {
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, state } : t)),
			})),
		});
	}

	it('dequeues the item, marks its tab running, and dispatches it', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		const dispatch = vi.fn().mockResolvedValue(true);

		expect(sendQueuedItemNow('session-1', item.id, dispatch)).toBe(true);
		expect(currentQueue()).toEqual([]);
		const target = useSessionStore.getState().sessions[0].aiTabs[1];
		expect(target.state).toBe('busy');
		expect(target.logs.at(-1)).toMatchObject({ source: 'user', text: 'hi', queuedItemId: item.id });
		expect(dispatch).toHaveBeenCalledWith('session-1', item);
	});

	it('never runs over a turn already in flight on the same tab', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		setTabState('b', 'busy');
		const dispatch = vi.fn().mockResolvedValue(true);

		expect(sendQueuedItemNow('session-1', item.id, dispatch)).toBe(false);
		expect(currentQueue()).toEqual([item]);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('stamps forceParallel when another tab of the agent is mid-turn', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		setTabState('a', 'busy');
		const dispatch = vi.fn().mockResolvedValue(true);

		sendQueuedItemNow('session-1', item.id, dispatch);
		expect(dispatch).toHaveBeenCalledWith('session-1', { ...item, forceParallel: true });
	});

	it('leaves the item queued when nothing could run it yet', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		// No dispatch deps are registered before the app's queue hook mounts.
		registerDispatchDepsProvider(null);
		expect(sendQueuedItemNow('session-1', item.id)).toBe(false);
		expect(currentQueue()).toEqual([item]);
	});

	it('owns a failed dispatch so it is not an unhandled rejection', async () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		const dispatch = vi.fn().mockRejectedValue(new Error('spawn failed'));
		expect(sendQueuedItemNow('session-1', item.id, dispatch)).toBe(true);
		await Promise.resolve();
	});
});

it('preserves a submitted provider capture across asynchronous queueing', () => {
	seed({ customModel: 'opus' });
	const settings = {
		provider: 'codex' as const,
		model: 'gpt-frozen',
		runOn: { type: 'provider' as const },
	};
	const item = enqueuePromptForTab({
		sessionId: 'session-1',
		tabId: 'b',
		text: 'keep this capture',
		turnSettings: settings,
	});
	expect(item?.turnSettings).toBe(settings);
});

describe('Grok command ownership receipts', () => {
	const commandOptions = {
		sessionId: 'session-1',
		tabId: 'b',
		text: '/review raw',
		slashCommand: true,
	};
	const providerConfig = {
		customPath: '/fixtures/bin/grok',
		customEnvVars: { GROK_HOME: '/fixtures/a' },
	};
	const remote = {
		id: 'remote-a',
		name: 'Fixture',
		host: 'a.invalid',
		port: 22,
		username: 'fixture',
		privateKeyPath: '',
		enabled: true,
	};

	beforeEach(() => {
		resetStores(useSessionStore, useSettingsStore);
		vi.stubGlobal('crypto', webcrypto);
		vi.mocked(window.maestro.agents.getConfig).mockReset().mockResolvedValue(providerConfig);
		vi.mocked(window.maestro.settings.get).mockReset().mockResolvedValue({});
		vi.mocked(window.maestro.sshRemote.getConfigs)
			.mockReset()
			.mockResolvedValue({ success: true, configs: [remote] });
		seed({ toolType: 'grok', sessionSshRemoteConfig: { enabled: true, remoteId: remote.id } });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		resetStores(useSessionStore, useSettingsStore);
	});

	it.each([
		['account', { customEnvVars: { GROK_HOME: '/fixtures/b' } }],
		['cwd', { cwd: '/fixtures/other' }],
		['executable', { customPath: '/fixtures/other/grok' }],
		['provider', { toolType: 'codex' }],
		['host', { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } }],
		['removed tab', { aiTabs: [createMockAITab({ id: 'a' })], activeTabId: 'a' }],
		['native identity', { aiTabs: [createMockAITab({ id: 'b', agentSessionId: 'other-native' })] }],
		['permission', { aiTabs: [createMockAITab({ id: 'b', permissionMode: 'readonly' })] }],
	] as [string, Partial<Session>][])(
		'refuses a queued %s change without retargeting',
		async (_label, patch) => {
			const item = enqueuePromptForTab(commandOptions)!;
			await expect(getQueuedCommandScopeRefusal('session-1', item)).resolves.toBeUndefined();
			useSessionStore.getState().updateSession('session-1', patch);
			expect(getQueuedCommandSelectionRefusal('session-1', item)).toContain('ownership');
			await expect(getQueuedCommandSpawnSelection('session-1', item)).resolves.toBeNull();
			expect(currentQueue()).toEqual([item]);
			expect(item.tabId).toBe('b');
		}
	);

	it.each(['spread', 'cloned scope', 'persisted', 'changed id', 'legacy'] as const)(
		'accepts only retained receipt identity: %s',
		async (kind) => {
			const item = enqueuePromptForTab(commandOptions)!;
			await expect(getQueuedCommandScopeRefusal('session-1', item)).resolves.toBeUndefined();
			const copy: QueuedItem =
				kind === 'persisted' ? JSON.parse(JSON.stringify(item)) : { ...item };
			if (kind === 'cloned scope') copy.commandScope = { ...item.commandScope! };
			if (kind === 'changed id') copy.id = 'another-item';
			if (kind === 'legacy') delete copy.commandScope;
			const refusal = await getQueuedCommandScopeRefusal('session-1', copy);
			if (kind === 'spread') expect(refusal).toBeUndefined();
			else expect(refusal).toContain('ownership');
		}
	);

	it.each([
		[
			'inherited account',
			{ ...providerConfig, customEnvVars: { GROK_HOME: '/fixtures/b' } },
			{},
			remote,
		],
		['executable', { ...providerConfig, customPath: '/fixtures/other/grok' }, {}, remote],
		['arguments', { ...providerConfig, customArgs: '--fixture' }, {}, remote],
		['absent environment', { customPath: providerConfig.customPath }, {}, remote],
		['empty environment', { ...providerConfig, customEnvVars: {} }, {}, remote],
		['blank environment', { ...providerConfig, customEnvVars: { GROK_HOME: ' ' } }, {}, remote],
		['global environment', providerConfig, { GROK_HOME: '/fixtures/b' }, remote],
		['same-ID host', providerConfig, {}, { ...remote, host: 'b.invalid' }],
		[
			'remote environment',
			providerConfig,
			{},
			{ ...remote, remoteEnv: { GROK_HOME: '/fixtures/b' } },
		],
	] as const)(
		'refuses changed %s and forwards only the original fingerprint',
		async (_label, config, env, endpoint) => {
			const item = enqueuePromptForTab(commandOptions)!;
			const captured = await getQueuedCommandSpawnSelection('session-1', item);
			expect(captured).toMatch(/^grok-spawn-selection-v1:[a-f0-9]{64}$/);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(config);
			vi.mocked(window.maestro.settings.get).mockResolvedValue(env);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [endpoint],
			});
			await expect(getQueuedCommandScopeRefusal('session-1', item)).resolves.toContain(
				'configuration'
			);
			await expect(getQueuedCommandSpawnSelection('session-1', item)).resolves.toBe(captured);
			expect(currentQueue()).toEqual([item]);
		}
	);

	it('matches main hashing while ignoring key order, model/effort and remote display changes', async () => {
		const config = {
			...providerConfig,
			customArgs: "$& $$ $` $'",
			customEnvVars: { GROK_HOME: '/fixtures/a', EMPTY: '', BLANK: ' ' },
		};
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(config);
		const item = enqueuePromptForTab(commandOptions)!;
		await expect(getQueuedCommandSpawnSelection('session-1', item)).resolves.toBe(
			fingerprintGrokSpawnSelection(
				{ providerConfig: config, shellEnvVars: {}, sshRemote: remote },
				sha256Hex
			)
		);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			...config,
			customEnvVars: { BLANK: ' ', EMPTY: '', GROK_HOME: '/fixtures/a' },
			model: 'other',
			effort: 'low',
		});
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ ...remote, name: 'Renamed' }],
		});
		useSessionStore
			.getState()
			.updateSession('session-1', { activeTabId: 'a', customModel: 'other', customEffort: 'low' });
		await expect(getQueuedCommandScopeRefusal('session-1', item)).resolves.toBeUndefined();
		expect(item.commandScope).toEqual({ provider: 'grok' });
		expect(JSON.stringify(item)).not.toContain('/fixtures/a');
		expect(JSON.stringify(item)).not.toContain('grok-spawn-selection-v1:');
	});

	it.each([
		'missing provider',
		'invalid global env',
		'missing remote',
		'disabled remote',
		'rejected read',
	] as const)('holds unavailable evidence: %s', async (kind) => {
		if (kind === 'missing provider')
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(undefined as never);
		if (kind === 'invalid global env')
			vi.mocked(window.maestro.settings.get).mockResolvedValue({ BAD: 7 });
		if (kind === 'missing remote')
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [],
			});
		if (kind === 'disabled remote')
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [{ ...remote, enabled: false }],
			});
		if (kind === 'rejected read')
			vi.mocked(window.maestro.agents.getConfig).mockRejectedValue(new Error('disconnected'));
		const item = enqueuePromptForTab(commandOptions)!;
		await expect(getQueuedCommandScopeRefusal('session-1', item)).resolves.toContain(
			'configuration'
		);
		await expect(getQueuedCommandSpawnSelection('session-1', item)).resolves.toBeNull();
	});

	it('bounds disconnected reads, clears deadlines and consumes a late rejection', async () => {
		vi.useFakeTimers();
		let rejectRead!: (reason: Error) => void;
		vi.mocked(window.maestro.agents.getConfig).mockReturnValue(
			new Promise((_, reject) => {
				rejectRead = reject;
			})
		);
		const item = enqueuePromptForTab(commandOptions)!;
		const pending = getQueuedCommandScopeRefusal('session-1', item);
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(pending).resolves.toContain('configuration');
		expect(vi.getTimerCount()).toBe(0);
		rejectRead(new Error('late disconnect'));
		await Promise.resolve();
		await expect(getQueuedCommandSpawnSelection('session-1', item)).resolves.toBeNull();
	});

	it('refuses a missing Grok tab instead of borrowing the active tab', () => {
		expect(enqueuePromptForTab({ ...commandOptions, tabId: 'gone' })).toBeNull();
		expect(currentQueue()).toEqual([]);
	});
});

describe('managed queue mutation persistence', () => {
	afterEach(() => registerSessionPersistenceFlush(null));
	it.each(['remove', 'pause'] as const)(
		'flushes %s through the registered persistence owner immediately',
		async (action) => {
			const session = seed();
			const item = {
				...buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'managed' }),
				pendingAdmissionId: 'dispatch',
			};
			seed({ executionQueue: [item] });
			const flush = vi.fn().mockResolvedValue(undefined);
			registerSessionPersistenceFlush(flush);
			if (action === 'remove') removeQueuedItem(session.id, item.id);
			else setQueuedItemPaused(session.id, item.id, true);
			expect(flush).toHaveBeenCalledOnce();
			expect(flush.mock.calls[0][0][0].executionQueue).toEqual(
				action === 'remove' ? [] : [{ ...item, paused: true }]
			);
		}
	);
});
