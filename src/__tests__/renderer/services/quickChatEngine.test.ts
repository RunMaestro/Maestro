/**
 * @file quickChatEngine.test.ts
 * @description The app-renderer half of Quick Chat: which agent a chat runs on,
 * how each message is delivered to the tab the router picked (run at once, or
 * queued behind a busy tab), what the window is told about it, and what each
 * window command does.
 *
 * The router is mocked: which tab a message belongs in is its own subject
 * (quickChatRouter.test.ts, quickChatRouting.test.ts). The queue is real, with
 * only the final spawn (`agentStore.processQueuedItem`) stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import {
	registerDispatchDepsProvider,
	useRetryStore,
	type RetryEntry,
} from '../../../renderer/stores/retryStore';
import {
	QUICK_CHAT_TAB_NAME,
	buildQuickChatSnapshot,
	isQuickChatTab,
	resetQuickChatEngineForTests,
	runQuickChatCommand,
	startQuickChatEngine,
} from '../../../renderer/services/quickChatEngine';
import { DEFAULT_QUICK_CHAT_SETTINGS, type QuickChatMessage } from '../../../shared/quickChat';
import {
	noteSpawnCollision,
	resetSpawnCollisionsForTest,
} from '../../../renderer/utils/executionQueue';
import type { AITab, LogEntry, Session } from '../../../renderer/types';

vi.mock('../../../renderer/services/agentNavigation', () => ({ jumpToAgent: vi.fn() }));
import { jumpToAgent } from '../../../renderer/services/agentNavigation';

vi.mock('../../../renderer/services/quickChatRouter', () => ({
	routeQuickChatMessage: vi.fn(),
	reopenClosedConversation: vi.fn(),
}));
import {
	reopenClosedConversation,
	routeQuickChatMessage,
} from '../../../renderer/services/quickChatRouter';

vi.mock('../../../renderer/services/tabAutoNaming', async (original) => ({
	...(await original<typeof import('../../../renderer/services/tabAutoNaming')>()),
	requestTabAutoName: vi.fn(),
}));
import { requestTabAutoName } from '../../../renderer/services/tabAutoNaming';

vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));
import { captureException } from '../../../renderer/utils/sentry';

function agent(id: string, overrides: Partial<Session> = {}): Session {
	const mainTab = createMockAITab({ id: `${id}-main` });
	return createMockSession({
		id,
		name: `Agent ${id}`,
		aiTabs: [mainTab],
		activeTabId: mainTab.id,
		unifiedTabOrder: [{ type: 'ai', id: mainTab.id }],
		executionQueue: [],
		...overrides,
	});
}

function session(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

function tab(sessionId: string, tabId: string | null): AITab {
	return session(sessionId).aiTabs.find((t) => t.id === tabId)!;
}

function patchTab(sessionId: string, tabId: string, patch: (tab: AITab) => Partial<AITab>): void {
	useSessionStore.setState({
		sessions: useSessionStore
			.getState()
			.sessions.map((s) =>
				s.id === sessionId
					? { ...s, aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, ...patch(t) } : t)) }
					: s
			),
	});
}

/** The agent writes `text` into a tab and finishes its turn. */
function reply(sessionId: string, tabId: string, text: string): void {
	patchTab(sessionId, tabId, (t) => ({
		state: 'idle',
		thinkingStartTime: undefined,
		logs: [...t.logs, { id: `out-${t.logs.length}`, timestamp: 2, source: 'stdout', text }],
	}));
}

function setQuickChatSettings(patch: Partial<typeof DEFAULT_QUICK_CHAT_SETTINGS>) {
	useSettingsStore.setState({
		quickChatSettings: { ...DEFAULT_QUICK_CHAT_SETTINGS, ...patch },
	});
}

/** The user messages of the thread, which carry the routes. */
function sent(messages: QuickChatMessage[] = buildQuickChatSnapshot().messages) {
	return messages.filter((m) => m.role === 'user');
}

/** Send a message and wait for a tab to be found for it. */
async function send(text: string) {
	const result = await runQuickChatCommand({ type: 'send', text });
	await vi.waitFor(() => {
		expect(sent().at(-1)?.route?.status).not.toBe('searching');
	});
	return { result, message: sent().at(-1)!, snapshot: buildQuickChatSnapshot() };
}

beforeEach(() => {
	resetQuickChatEngineForTests();
	useSessionStore.setState({ sessions: [agent('a'), agent('b')], activeSessionId: 'b' });
	setQuickChatSettings({});
	useSettingsStore.setState({ defaultSaveToHistory: true, automaticTabNamingEnabled: true });
	// The queue's last step is the spawn. Everything before it (the dequeue, the
	// card in the tab, the busy state) is the real code.
	registerDispatchDepsProvider(() => ({
		conductorProfile: '',
		customAICommands: [],
		speckitCommands: [],
		openspecCommands: [],
	}));
	useAgentStore.setState({ processQueuedItem: vi.fn().mockResolvedValue(true) });
	// The shared setup mock has no interrupt; the engine calls it on stop/new.
	(window.maestro.process as { interrupt?: unknown }).interrupt = vi.fn().mockResolvedValue(true);
	vi.mocked(jumpToAgent).mockClear();
	vi.mocked(requestTabAutoName).mockClear();
	vi.mocked(captureException).mockClear();
	vi.mocked(routeQuickChatMessage).mockReset().mockResolvedValue({ kind: 'new' });
	vi.mocked(reopenClosedConversation).mockReset().mockResolvedValue(null);
});

afterEach(() => {
	registerDispatchDepsProvider(null);
	useRetryStore.setState({ retries: {}, outages: {} });
	resetSpawnCollisionsForTest();
});

/**
 * Put a turn that already ran into an outage: the provider refused it, and an
 * automatic recovery parked its prompt at the head of the tab's queue until the
 * resend. `itemId` is the id its card in the tab carries.
 */
function holdForRetry(tabId: string, itemId: string): void {
	useSessionStore.setState({
		sessions: useSessionStore.getState().sessions.map((s) =>
			s.id === 'b'
				? {
						...s,
						executionQueue: [
							{ id: itemId, timestamp: 1, tabId, type: 'message' as const, text: 'hi' },
						],
					}
				: s
		),
	});
	patchTab('b', tabId, () => ({ state: 'idle' }));
	const entry: RetryEntry = {
		sessionId: 'b',
		tabId,
		key: `b:${tabId}`,
		outageId: 'outage-1',
		strategy: 'availability',
		mode: 'resend',
		status: 'scheduled',
		attempt: 0,
		startedAt: 1,
		nextRetryAt: Date.now() + 60_000,
		lastMessage: 'Overloaded',
		heldItemId: itemId,
	};
	useRetryStore.setState({ retries: { [entry.key]: entry } });
}

describe('agent resolution', () => {
	it('uses the configured agent', () => {
		setQuickChatSettings({ agentId: 'a' });
		expect(buildQuickChatSnapshot().agentId).toBe('a');
	});

	it('falls back to the active agent when none is configured or it is gone', () => {
		expect(buildQuickChatSnapshot().agentId).toBe('b');
		setQuickChatSettings({ agentId: 'deleted' });
		expect(buildQuickChatSnapshot().agentId).toBe('b');
	});

	it('never picks a terminal-only agent', () => {
		useSessionStore.setState({
			sessions: [agent('t', { toolType: 'terminal' }), agent('a')],
			activeSessionId: 't',
		});
		const snapshot = buildQuickChatSnapshot();
		expect(snapshot.agentId).toBe('a');
		expect(snapshot.agents.map((x) => x.id)).toEqual(['a']);
	});

	it('lists each agent with its group and provider for the picker', () => {
		useSessionStore.setState({
			sessions: [agent('a', { groupId: 'g1', toolType: 'codex' }), agent('b', { groupId: '' })],
			groups: [{ id: 'g1', name: 'Backend', emoji: '', collapsed: false }],
			activeSessionId: 'b',
		});
		expect(buildQuickChatSnapshot().agents).toEqual([
			{ id: 'a', name: 'Agent a', groupName: 'Backend', provider: 'Codex' },
			{ id: 'b', name: 'Agent b', groupName: undefined, provider: 'Claude Code' },
		]);
	});

	it('lists agents in Left Bar order and leaves worktree children out', () => {
		useSessionStore.setState({
			sessions: [
				agent('loose', { name: 'Loose', groupId: undefined }),
				agent('z', { name: 'Zed', groupId: 'g-alpha' }),
				agent('wt', { name: 'Zed: feature', groupId: 'g-alpha', parentSessionId: 'z' }),
				agent('m', { name: 'Mid', groupId: 'g-beta' }),
				agent('y', { name: 'Yak', groupId: 'g-alpha' }),
			],
			groups: [
				{ id: 'g-beta', name: 'Beta', emoji: '', collapsed: false },
				{ id: 'g-alpha', name: 'Alpha', emoji: '', collapsed: false },
			],
			activeSessionId: 'loose',
		});
		expect(buildQuickChatSnapshot().agents.map((x) => x.id)).toEqual(['y', 'z', 'm', 'loose']);
	});

	it('stays on its agent when the setting changes mid-chat', async () => {
		await send('one');
		setQuickChatSettings({ agentId: 'a' });
		expect(buildQuickChatSnapshot().agentId).toBe('b');
	});
});

describe('send', () => {
	it('shows the message as searching at once, before a tab is found', async () => {
		let found: (target: { kind: 'new' }) => void = () => {};
		vi.mocked(routeQuickChatMessage).mockReturnValue(new Promise((resolve) => (found = resolve)));

		const result = await runQuickChatCommand({ type: 'send', text: 'hello' });
		expect(result.ok).toBe(true);
		expect(sent(result.snapshot.messages)).toEqual([
			expect.objectContaining({
				text: 'hello',
				route: expect.objectContaining({ status: 'searching', tabId: null }),
			}),
		]);
		expect(result.snapshot.busy).toBe(true);
		expect(session('b').aiTabs).toHaveLength(1);

		found({ kind: 'new' });
		await vi.waitFor(() => expect(sent()[0].route?.status).toBe('running'));
	});

	it('starts a hidden tab in the background and runs the message in it', async () => {
		const { message, snapshot } = await send('hello');
		expect(message.route).toMatchObject({ status: 'running', origin: 'new', tabOpen: true });

		const created = tab('b', message.route!.tabId);
		expect(created).toMatchObject({
			quickChat: true,
			hidden: true,
			saveToHistory: true,
			state: 'busy',
		});
		expect(created.logs).toEqual([expect.objectContaining({ source: 'user', text: 'hello' })]);
		// The user's view did not move.
		expect(session('b').activeTabId).toBe('b-main');
		expect(snapshot.tabId).toBe(created.id);
		expect(useAgentStore.getState().processQueuedItem).toHaveBeenCalledWith(
			'b',
			expect.objectContaining({ tabId: created.id, text: 'hello' }),
			expect.anything()
		);
	});

	it('leaves the new tab unnamed and has it named from the message', async () => {
		const { message } = await send('what is the story with my amazon delivery?');
		expect(tab('b', message.route!.tabId).name).toBeNull();
		expect(message.route!.tabName).toBe('New tab');
		expect(requestTabAutoName).toHaveBeenCalledWith(
			expect.objectContaining({
				tabId: message.route!.tabId,
				prompt: expect.stringContaining('amazon delivery'),
			})
		);

		// The pill follows the name once the namer answers.
		patchTab('b', message.route!.tabId!, () => ({ name: 'Amazon Delivery' }));
		expect(sent()[0].route?.tabName).toBe('Amazon Delivery');
	});

	it('names the tab "Quick Chat" when automatic tab naming is off', async () => {
		useSettingsStore.setState({ automaticTabNamingEnabled: false });
		const { message } = await send('hello');
		expect(tab('b', message.route!.tabId).name).toBe(QUICK_CHAT_TAB_NAME);
	});

	it('honors the ephemeral-history setting on a hidden tab', async () => {
		setQuickChatSettings({ ephemeralHistory: false });
		const { message } = await send('hi');
		expect(tab('b', message.route!.tabId).saveToHistory).toBe(false);
	});

	it('creates a visible tab when new chats are kept', async () => {
		setQuickChatSettings({ persistent: true });
		const { message, snapshot } = await send('hi');
		expect(snapshot.persistent).toBe(true);
		expect(tab('b', message.route!.tabId).hidden).toBe(false);
	});

	it('sends to the open tab the router picked, without making a tab', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ name: 'Amazon Delivery' }));
		const { message } = await send('any update?');

		expect(session('b').aiTabs).toHaveLength(1);
		expect(message.route).toMatchObject({
			status: 'running',
			origin: 'open',
			tabId: 'b-main',
			tabName: 'Amazon Delivery',
		});
		expect(tab('b', 'b-main').logs.at(-1)).toMatchObject({ source: 'user', text: 'any update?' });
	});

	it('reopens the closed conversation the router picked', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({
			kind: 'closed',
			agentSessionId: 'old-session',
			name: 'Tax Questions',
		});
		vi.mocked(reopenClosedConversation).mockImplementation(async (sessionId) => {
			const reopened = createMockAITab({ id: 'reopened', name: 'Tax Questions' });
			useSessionStore.setState({
				sessions: useSessionStore
					.getState()
					.sessions.map((s) =>
						s.id === sessionId ? { ...s, aiTabs: [...s.aiTabs, reopened] } : s
					),
			});
			return reopened.id;
		});
		const { message } = await send('and the deduction?');

		expect(reopenClosedConversation).toHaveBeenCalledWith('b', {
			kind: 'closed',
			agentSessionId: 'old-session',
			name: 'Tax Questions',
		});
		expect(message.route).toMatchObject({
			status: 'running',
			origin: 'reopened',
			tabId: 'reopened',
			tabName: 'Tax Questions',
		});
	});

	it('starts a new tab when the closed conversation cannot be read anymore', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({
			kind: 'closed',
			agentSessionId: 'gone',
			name: null,
		});
		const { message } = await send('hello again');
		expect(message.route).toMatchObject({ status: 'running', origin: 'new' });
		expect(tab('b', message.route!.tabId).quickChat).toBe(true);
	});

	it('tells the router which tab the chat is in and which tabs are its own', async () => {
		const first = await send('one');
		await send('two');
		const context = vi.mocked(routeQuickChatMessage).mock.calls[1][2];
		expect(context.currentTabId).toBe(first.message.route!.tabId);
		expect([...context.ownedTabIds]).toEqual([first.message.route!.tabId]);
	});

	it('runs two messages sent back to back in two tabs at once', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValueOnce({ kind: 'open', tabId: 'b-main' });
		const first = await send('about the build');
		const second = await send('about lunch');

		expect(first.message.route!.tabId).toBe('b-main');
		expect(second.message.route!.tabId).not.toBe('b-main');
		expect(sent().map((m) => m.route?.status)).toEqual(['running', 'running']);
		// The second ran beside a busy tab on purpose, and its card says so.
		expect(tab('b', second.message.route!.tabId).logs[0]).toMatchObject({ forceParallel: true });
	});

	it('queues behind a tab that is mid-reply instead of running over it', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ state: 'busy', name: 'Build' }));
		const { message, snapshot } = await send('one more thing');

		expect(message.route).toMatchObject({ status: 'queued', tabId: 'b-main', tabName: 'Build' });
		expect(snapshot.busy).toBe(true);
		expect(session('b').executionQueue).toEqual([
			expect.objectContaining({ tabId: 'b-main', text: 'one more thing' }),
		]);
		expect(useAgentStore.getState().processQueuedItem).not.toHaveBeenCalled();
	});

	it('waits its turn behind a message already queued for the same idle tab', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							executionQueue: [
								{ id: 'earlier', timestamp: 1, tabId: 'b-main', type: 'message', text: 'first' },
							],
						}
					: s
			),
		});
		const { message } = await send('second');
		expect(message.route?.status).toBe('queued');
		expect(session('b').executionQueue.map((i) => i.text)).toEqual(['first', 'second']);
	});

	it('rejects an empty message', async () => {
		const result = await runQuickChatCommand({ type: 'send', text: '   ' });
		expect(result.ok).toBe(false);
		expect(result.snapshot.messages).toEqual([]);
	});

	it('marks the message failed, and reports it, when routing breaks', async () => {
		vi.mocked(routeQuickChatMessage).mockRejectedValue(new Error('boom'));
		const { snapshot } = await send('hello');

		expect(snapshot.messages).toEqual([
			expect.objectContaining({
				role: 'user',
				text: 'hello',
				route: expect.objectContaining({ status: 'failed' }),
			}),
			expect.objectContaining({ role: 'error', text: 'Could not send this message' }),
		]);
		expect(snapshot.busy).toBe(false);
		expect(captureException).toHaveBeenCalled();
	});
});

describe('a queued message runs when its own tab is free', () => {
	/** Agent b with a second tab that stays busy with unrelated work. */
	function withAnotherBusyTab() {
		const other = createMockAITab({ id: 'b-other', state: 'busy' });
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, aiTabs: [...s.aiTabs, other] } : s)),
		});
	}

	async function queueBehindBusyMain() {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ state: 'busy' }));
		return send('one more thing');
	}

	it("does not wait for the agent's other tabs, which the queue alone would", async () => {
		const stop = startQuickChatEngine();
		withAnotherBusyTab();
		await queueBehindBusyMain();

		// Its tab finishes. Another tab is still busy, so the agent's queue holds
		// every write-mode item; the chat's rule is per tab.
		patchTab('b', 'b-main', () => ({ state: 'idle' }));
		await vi.waitFor(() => expect(sent()[0].route?.status).toBe('running'));

		expect(session('b').executionQueue).toEqual([]);
		expect(tab('b', 'b-main').logs.at(-1)).toMatchObject({
			text: 'one more thing',
			forceParallel: true,
		});
		expect(tab('b', 'b-other').state).toBe('busy');
		stop();
	});

	it('still waits while its own tab is busy', async () => {
		const stop = startQuickChatEngine();
		withAnotherBusyTab();
		await queueBehindBusyMain();

		// Something else about the agent changes; its tab is still mid-reply.
		patchTab('b', 'b-other', () => ({ name: 'Renamed' }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sent()[0].route?.status).toBe('queued');
		expect(useAgentStore.getState().processQueuedItem).not.toHaveBeenCalled();
		stop();
	});

	it('backs off after a refused dispatch instead of retrying on every change', async () => {
		const stop = startQuickChatEngine();
		await queueBehindBusyMain();
		// The tab's previous process still owned its key, so the dispatch was
		// refused and the message went back in the queue, runnable.
		noteSpawnCollision(session('b').executionQueue[0].id);

		patchTab('b', 'b-main', () => ({ state: 'idle' }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session('b').executionQueue).toHaveLength(1);
		expect(useAgentStore.getState().processQueuedItem).not.toHaveBeenCalled();
		stop();
	});

	it('leaves a message the user paused in the queue', async () => {
		const stop = startQuickChatEngine();
		await queueBehindBusyMain();
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b'
						? { ...s, executionQueue: s.executionQueue.map((i) => ({ ...i, paused: true })) }
						: s
				),
		});
		patchTab('b', 'b-main', () => ({ state: 'idle' }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session('b').executionQueue).toHaveLength(1);
		expect(useAgentStore.getState().processQueuedItem).not.toHaveBeenCalled();
		stop();
	});
});

describe('move to a new tab', () => {
	async function queueBehindBusyMain() {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ state: 'busy' }));
		return send('one more thing');
	}

	it('takes a queued message out of the queue and runs it in a new tab', async () => {
		const { message } = await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });

		expect(result.ok).toBe(true);
		expect(session('b').executionQueue).toEqual([]);
		const moved = sent(result.snapshot.messages)[0];
		expect(moved.route).toMatchObject({ status: 'running', origin: 'new' });
		expect(moved.route!.tabId).not.toBe('b-main');
		expect(tab('b', moved.route!.tabId).logs[0]).toMatchObject({ text: 'one more thing' });
		// It never reached the tab it was waiting on.
		expect(tab('b', 'b-main').logs).toEqual([]);
	});

	it('defaults to the latest queued message', async () => {
		await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'moveToNewTab' });
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({ origin: 'new' });
	});

	it('refuses once the message has started, so it cannot run twice', async () => {
		const { message } = await send('hello');
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });
		expect(result.ok).toBe(false);
		expect(session('b').aiTabs).toHaveLength(2);
	});

	it('refuses when nothing is queued', async () => {
		expect((await runQuickChatCommand({ type: 'moveToNewTab' })).ok).toBe(false);
	});

	it('refuses a message an automatic retry is holding, which would run it twice', async () => {
		const { message } = await send('hi');
		const tabId = message.route!.tabId!;
		holdForRetry(tabId, tab('b', tabId).logs[0].queuedItemId!);

		// It sits in the queue, but it is not waiting: it already ran once.
		expect(sent()[0].route?.status).toBe('running');
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });
		expect(result.ok).toBe(false);
		expect(session('b').executionQueue).toHaveLength(1);
		expect(session('b').aiTabs).toHaveLength(2);
	});
});

describe('new chat', () => {
	it('deletes an ephemeral tab without putting it on the undo stack', async () => {
		const { message } = await send('hi');
		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.tabId).toBeNull();
		expect(result.snapshot.messages).toEqual([]);
		const b = session('b');
		expect(b.aiTabs.some((t) => t.id === message.route!.tabId)).toBe(false);
		expect(b.closedTabHistory).toEqual([]);
	});

	it('leaves a kept tab on the agent', async () => {
		setQuickChatSettings({ persistent: true });
		const { message } = await send('hi');
		await runQuickChatCommand({ type: 'new' });
		expect(session('b').aiTabs.some((t) => t.id === message.route!.tabId)).toBe(true);
	});

	it("never deletes the user's own tab a message was routed to", async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		await send('hi');
		await runQuickChatCommand({ type: 'new' });
		expect(session('b').aiTabs.map((t) => t.id)).toEqual(['b-main']);
	});

	it('resets a per-chat mode back to the setting', async () => {
		await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.persistent).toBe(false);
	});

	it('keeps a message sent while the old chat is still being cleaned up', async () => {
		const old = await send('old');
		// The old chat's tab is mid-reply, so ending it waits on an interrupt.
		let finishInterrupt: (ok: boolean) => void = () => {};
		vi.mocked(window.maestro.process.interrupt).mockReturnValue(
			new Promise((resolve) => (finishInterrupt = resolve))
		);
		const ending = runQuickChatCommand({ type: 'new' });
		await runQuickChatCommand({ type: 'send', text: 'fresh' });
		finishInterrupt(true);
		await ending;

		await vi.waitFor(() => expect(sent().at(-1)?.route?.status).toBe('running'));
		expect(sent().map((m) => m.text)).toEqual(['fresh']);
		// The old chat's tab is gone; the new chat's tab is not.
		const tabs = session('b').aiTabs.map((t) => t.id);
		expect(tabs).not.toContain(old.message.route!.tabId);
		expect(tabs).toContain(sent()[0].route!.tabId);
	});

	it('drops a message whose tab was still being found', async () => {
		let found: (target: { kind: 'new' }) => void = () => {};
		vi.mocked(routeQuickChatMessage).mockReturnValue(new Promise((resolve) => (found = resolve)));
		await runQuickChatCommand({ type: 'send', text: 'hello' });
		await runQuickChatCommand({ type: 'new' });

		found({ kind: 'new' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session('b').aiTabs).toHaveLength(1);
		expect(useAgentStore.getState().processQueuedItem).not.toHaveBeenCalled();
	});
});

describe('keep (setPersistent)', () => {
	it('reveals a hidden chat tab and switches it to the normal history rule', async () => {
		setQuickChatSettings({ ephemeralHistory: false });
		const { message } = await send('hi');
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		expect(result.snapshot.persistent).toBe(true);
		expect(tab('b', message.route!.tabId)).toMatchObject({ hidden: false, saveToHistory: true });
	});

	it('hides a kept tab again, moving the main window off it first', async () => {
		setQuickChatSettings({ persistent: true });
		const { message } = await send('hi');
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, activeTabId: message.route!.tabId! } : s)),
		});
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: false });
		expect(result.ok).toBe(true);
		expect(tab('b', message.route!.tabId).hidden).toBe(true);
		expect(session('b').activeTabId).toBe('b-main');
	});

	it('applies to the next tab when no chat has started', async () => {
		await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		const { message } = await send('hi');
		expect(tab('b', message.route!.tabId).hidden).toBe(false);
	});

	it("never hides the user's own tab a message was routed to", async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		await send('hi');
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: false });
		expect(result.ok).toBe(true);
		expect(tab('b', 'b-main').hidden).toBeFalsy();
	});
});

describe('reveal', () => {
	it('keeps the chat and jumps to its tab', async () => {
		const { message } = await send('hi');
		const result = await runQuickChatCommand({ type: 'reveal' });
		expect(result.ok).toBe(true);
		expect(result.snapshot.persistent).toBe(true);
		expect(tab('b', message.route!.tabId).hidden).toBe(false);
		expect(jumpToAgent).toHaveBeenCalledWith('b', { tabId: message.route!.tabId });
	});

	it('jumps to the tab a given message went to', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValueOnce({ kind: 'open', tabId: 'b-main' });
		const first = await send('about the build');
		await send('about lunch');

		const result = await runQuickChatCommand({ type: 'reveal', messageId: first.message.id });
		expect(result.ok).toBe(true);
		expect(jumpToAgent).toHaveBeenCalledWith('b', { tabId: 'b-main' });
		// Opening the user's own tab does not turn the chat into a kept one.
		expect(result.snapshot.persistent).toBe(false);
	});

	it('fails before the first message', async () => {
		expect((await runQuickChatCommand({ type: 'reveal' })).ok).toBe(false);
	});

	it('fails for a tab that was closed', async () => {
		const { message } = await send('hi');
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b' ? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== message.route!.tabId) } : s
				),
		});
		const result = await runQuickChatCommand({ type: 'reveal', messageId: message.id });
		expect(result.ok).toBe(false);
		expect(jumpToAgent).not.toHaveBeenCalled();
	});
});

describe('stop', () => {
	it('interrupts the tab answering one of its messages', async () => {
		const { message } = await send('hi');
		await runQuickChatCommand({ type: 'stop' });
		expect(window.maestro.process.interrupt).toHaveBeenCalledWith(`b-ai-${message.route!.tabId}`);
	});

	it('still reports the chat when a reply had already ended by itself', async () => {
		await send('hi');
		vi.mocked(window.maestro.process.interrupt).mockRejectedValue(new Error('no such process'));
		const result = await runQuickChatCommand({ type: 'stop' });
		expect(result.ok).toBe(true);
		expect(sent(result.snapshot.messages)).toHaveLength(1);
	});

	it('withdraws a queued message and leaves the reply it waited on alone', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ state: 'busy' }));
		await send('one more thing');

		const result = await runQuickChatCommand({ type: 'stop' });
		expect(session('b').executionQueue).toEqual([]);
		expect(sent(result.snapshot.messages)[0].route?.status).toBe('cancelled');
		expect(result.snapshot.busy).toBe(false);
		// That tab is busy with a turn this chat did not send.
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
	});

	it('ends the automatic retry of a refused message, so it is not resent later', async () => {
		const { message } = await send('hi');
		const tabId = message.route!.tabId!;
		holdForRetry(tabId, tab('b', tabId).logs[0].queuedItemId!);

		const result = await runQuickChatCommand({ type: 'stop' });
		expect(useRetryStore.getState().retries).toEqual({});
		expect(session('b').executionQueue).toEqual([]);
		expect(sent(result.snapshot.messages)[0].route?.status).toBe('cancelled');
		expect(result.snapshot.busy).toBe(false);
	});

	it('does not interrupt a tab whose reply to the chat already finished', async () => {
		const { message } = await send('hi');
		reply('b', message.route!.tabId!, 'done');
		// The user then started something of their own in that tab.
		patchTab('b', message.route!.tabId!, (t) => ({
			state: 'busy',
			logs: [...t.logs, { id: 'own', timestamp: 3, source: 'user', text: 'mine' } as LogEntry],
		}));
		await runQuickChatCommand({ type: 'stop' });
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
	});
});

describe('setAgent', () => {
	it('ends the chat and saves the new agent', async () => {
		const { message } = await send('hi');
		const result = await runQuickChatCommand({ type: 'setAgent', agentId: 'a' });
		expect(result.snapshot.agentId).toBe('a');
		expect(result.snapshot.tabId).toBeNull();
		expect(useSettingsStore.getState().quickChatSettings.agentId).toBe('a');
		expect(session('b').aiTabs.some((t) => t.id === message.route!.tabId)).toBe(false);
	});

	it('rejects an unknown agent', async () => {
		expect((await runQuickChatCommand({ type: 'setAgent', agentId: 'nope' })).ok).toBe(false);
	});

	it('sends a message typed during the switch to the agent just chosen', async () => {
		await send('old');
		let finishInterrupt: (ok: boolean) => void = () => {};
		vi.mocked(window.maestro.process.interrupt).mockReturnValue(
			new Promise((resolve) => (finishInterrupt = resolve))
		);
		const switching = runQuickChatCommand({ type: 'setAgent', agentId: 'a' });
		await runQuickChatCommand({ type: 'send', text: 'fresh' });
		finishInterrupt(true);
		await switching;

		await vi.waitFor(() => expect(sent().at(-1)?.route?.status).toBe('running'));
		expect(buildQuickChatSnapshot().agentId).toBe('a');
		expect(session('a').aiTabs).toHaveLength(2);
	});
});

describe('snapshot', () => {
	it('reads each reply from its own tab, under its own message', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValueOnce({ kind: 'open', tabId: 'b-main' });
		// The tab already held a conversation; none of it belongs to the thread.
		patchTab('b', 'b-main', () => ({
			logs: [
				{ id: 'old-1', timestamp: 1, source: 'user', text: 'earlier question' },
				{ id: 'old-2', timestamp: 1, source: 'stdout', text: 'earlier answer' },
			] as LogEntry[],
		}));
		const first = await send('about the build');
		const second = await send('about lunch');
		// The second message is answered first.
		reply('b', second.message.route!.tabId!, 'sandwich');
		reply('b', 'b-main', 'it passed');

		const snapshot = buildQuickChatSnapshot();
		expect(snapshot.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
			'user:about the build',
			'assistant:it passed',
			'user:about lunch',
			'assistant:sandwich',
		]);
		expect(sent(snapshot.messages).map((m) => m.route?.status)).toEqual(['done', 'done']);
		expect(snapshot.busy).toBe(false);
		expect(first.message.id).toBe(snapshot.messages[0].id);
	});

	it('ends a reply at the next thing the user sent to that tab', async () => {
		const { message } = await send('hi');
		reply('b', message.route!.tabId!, 'hello');
		patchTab('b', message.route!.tabId!, (t) => ({
			logs: [
				...t.logs,
				{ id: 'own', timestamp: 3, source: 'user', text: 'typed in the main window' },
				{ id: 'own-out', timestamp: 4, source: 'stdout', text: 'not part of the chat' },
			] as LogEntry[],
		}));
		expect(buildQuickChatSnapshot().messages.map((m) => m.text)).toEqual(['hi', 'hello']);
	});

	it('reports the running reply and when it started', async () => {
		const { message } = await send('hi');
		patchTab('b', message.route!.tabId!, () => ({ thinkingStartTime: 42 }));
		const snapshot = buildQuickChatSnapshot();
		expect(snapshot.busy).toBe(true);
		expect(snapshot.busySince).toBe(42);
		expect(sent(snapshot.messages)[0].route).toMatchObject({ status: 'running', since: 42 });
	});

	it("falls back to the agent's start time when the busy tab carries none", async () => {
		const { message } = await send('hi');
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, thinkingStartTime: 77 } : s)),
		});
		patchTab('b', message.route!.tabId!, () => ({ thinkingStartTime: undefined }));
		expect(buildQuickChatSnapshot().busySince).toBe(77);
	});

	it("does not borrow the agent's start time while another tab is busy too", async () => {
		const { message } = await send('hi');
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, thinkingStartTime: 77 } : s)),
		});
		patchTab('b', message.route!.tabId!, () => ({ thinkingStartTime: undefined }));
		patchTab('b', 'b-main', () => ({ state: 'busy', thinkingStartTime: 50 }));
		expect(buildQuickChatSnapshot().busySince).toBeNull();
	});

	it('keeps the thread whole after its tab is closed', async () => {
		const { message } = await send('hi');
		reply('b', message.route!.tabId!, 'hello');
		patchTab('b', message.route!.tabId!, () => ({ name: 'Greeting' }));
		buildQuickChatSnapshot();
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b' ? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== message.route!.tabId) } : s
				),
		});

		const snapshot = buildQuickChatSnapshot();
		expect(snapshot.tabId).toBeNull();
		expect(snapshot.messages.map((m) => m.text)).toEqual(['hi', 'hello']);
		expect(sent(snapshot.messages)[0].route).toMatchObject({
			status: 'done',
			tabName: 'Greeting',
			tabOpen: false,
		});
	});

	it('shows a message someone removed from the queue as cancelled', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ state: 'busy' }));
		await send('one more thing');
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, executionQueue: [] } : s)),
		});
		patchTab('b', 'b-main', () => ({ state: 'idle' }));
		expect(sent()[0].route?.status).toBe('cancelled');
	});
});

describe('snapshot streaming', () => {
	afterEach(() => vi.useRealTimers());

	async function startOwningEngine() {
		vi.useFakeTimers();
		let handler: ((command: { type: 'sync' }) => unknown) | undefined;
		vi.mocked(window.maestro.quickChat.onCommand).mockImplementationOnce((cb) => {
			handler = cb as typeof handler;
			return () => {};
		});
		const stop = startQuickChatEngine();
		// Only a window that has received a command streams snapshots.
		await handler?.({ type: 'sync' });
		vi.mocked(window.maestro.quickChat.pushSnapshot).mockClear();
		return stop;
	}

	it('re-pushes the picker list when Show Hidden changes in the main window', async () => {
		useSessionStore.setState({
			sessions: [agent('a'), agent('h', { groupId: 'hid' })],
			groups: [{ id: 'hid', name: 'Hidden', emoji: '', collapsed: false, hidden: true }],
			activeSessionId: 'a',
		});
		useSettingsStore.setState({ showHiddenGroups: false });
		const stop = await startOwningEngine();

		useSettingsStore.setState({ showHiddenGroups: true });
		vi.advanceTimersByTime(500);
		const pushed = vi.mocked(window.maestro.quickChat.pushSnapshot).mock.calls.at(-1)?.[0];
		expect(pushed?.agents.map((x) => x.id)).toEqual(['h', 'a']);
		stop();
	});

	it('re-pushes when the active agent changes', async () => {
		const stop = await startOwningEngine();
		useSessionStore.setState({ activeSessionId: 'a' });
		vi.advanceTimersByTime(500);
		expect(window.maestro.quickChat.pushSnapshot).toHaveBeenCalled();
		stop();
	});

	it('pushes when a search ends without touching the store', async () => {
		// A failed search changes only the engine's own state: no store write
		// would ever announce it.
		let failSearch: (error: Error) => void = () => {};
		vi.mocked(routeQuickChatMessage).mockReturnValue(
			new Promise((_resolve, reject) => (failSearch = reject))
		);
		const stop = await startOwningEngine();
		await runQuickChatCommand({ type: 'send', text: 'hello' });
		vi.mocked(window.maestro.quickChat.pushSnapshot).mockClear();

		failSearch(new Error('boom'));
		await vi.advanceTimersByTimeAsync(500);
		const pushed = vi.mocked(window.maestro.quickChat.pushSnapshot).mock.calls.at(-1)?.[0];
		expect(sent(pushed?.messages)[0].route?.status).toBe('failed');
		stop();
	});
});

describe('isQuickChatTab', () => {
	it('recognizes only tabs Quick Chat created', () => {
		expect(isQuickChatTab({ quickChat: true })).toBe(true);
		expect(isQuickChatTab({})).toBe(false);
		expect(isQuickChatTab(undefined)).toBe(false);
	});
});
