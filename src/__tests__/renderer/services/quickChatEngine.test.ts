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
import {
	DEFAULT_QUICK_CHAT_SETTINGS,
	type QuickChatMessage,
	type QuickChatRecent,
} from '../../../shared/quickChat';
import {
	noteSpawnCollision,
	resetSpawnCollisionsForTest,
} from '../../../renderer/utils/executionQueue';
import { resetPendingSteersForTests } from '../../../renderer/services/chatSteering';
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

// jsdom cannot draw: a preview is the image's name, so a test can tell them apart.
vi.mock('../../../renderer/utils/imageData', () => ({
	downscaleImageDataUrl: vi.fn(async (src: string) => `preview:${src}`),
}));

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

	it("routes only the chat's first message; a follow-up stays in that tab", async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValueOnce({ kind: 'open', tabId: 'b-main' });
		const first = await send('about the build');
		// Whatever the router would say about it, a follow-up is never routed.
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'new' });
		const second = await send('and when does it arrive?');

		expect(routeQuickChatMessage).toHaveBeenCalledTimes(1);
		expect(first.message.route!.tabId).toBe('b-main');
		expect(second.message.route).toMatchObject({ tabId: 'b-main', origin: 'open' });
		// It waits for the reply it follows, in the same tab.
		expect(sent().map((m) => m.route?.status)).toEqual(['running', 'queued']);
		expect(session('b').aiTabs).toHaveLength(1);
	});

	it('sends a message typed while the first is still being routed to the same tab', async () => {
		let found: (target: { kind: 'new' }) => void = () => {};
		vi.mocked(routeQuickChatMessage).mockReturnValue(new Promise((resolve) => (found = resolve)));
		await runQuickChatCommand({ type: 'send', text: 'one' });
		await runQuickChatCommand({ type: 'send', text: 'two' });
		found({ kind: 'new' });

		await vi.waitFor(() => expect(sent().every((m) => m.route?.tabId)).toBe(true));
		expect(routeQuickChatMessage).toHaveBeenCalledTimes(1);
		const [one, two] = sent();
		expect(two.route!.tabId).toBe(one.route!.tabId);
		expect(session('b').aiTabs).toHaveLength(2);
	});

	it("routes again when the chat's tab was closed", async () => {
		const first = await send('one');
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b'
						? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== first.message.route!.tabId) }
						: s
				),
		});
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		const second = await send('two');

		expect(routeQuickChatMessage).toHaveBeenCalledTimes(2);
		expect(second.message.route!.tabId).toBe('b-main');
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

	it('takes the conversation with it: the next message follows to the new tab', async () => {
		await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'moveToNewTab' });
		const movedTo = sent(result.snapshot.messages)[0].route!.tabId;
		const next = await send('and then?');
		expect(next.message.route!.tabId).toBe(movedTo);
	});

	it('defaults to the latest queued message', async () => {
		await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'moveToNewTab' });
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({ origin: 'new' });
	});

	it('refuses a message that already started a new tab of its own', async () => {
		const { message } = await send('hello');
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });
		expect(result.ok).toBe(false);
		expect(session('b').aiTabs).toHaveLength(2);
	});

	it('refuses when nothing is queued', async () => {
		expect((await runQuickChatCommand({ type: 'moveToNewTab' })).ok).toBe(false);
	});

	it('refuses a message still searching for a tab', async () => {
		vi.mocked(routeQuickChatMessage).mockReturnValue(new Promise(() => {}));
		await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: sent()[0].id });
		expect(result.ok).toBe(false);
		// Refusing opens no tab: the agent keeps only its own.
		expect(session('b').aiTabs).toHaveLength(1);
	});
});

describe('steer a queued message into the running reply', () => {
	/** Agent b on the interactive token source, where a running turn takes input. */
	function makeSteerable() {
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							claudeInteractive: { mode: 'interactive' as const, modeReason: 'auto' as const },
						}
					: s
			),
		});
	}

	async function queueBehindBusyMain() {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ state: 'busy' }));
		return send('actually, use the other file');
	}

	let steer: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		resetPendingSteersForTests();
		steer = vi.fn().mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });
		(window.maestro.process as { steer?: unknown }).steer = steer;
	});

	it('offers Steer on a queued message only when the running reply can take input', async () => {
		const { message } = await queueBehindBusyMain();
		// API token source: the turn takes nothing until it ends.
		expect(message.route).toMatchObject({ status: 'queued', canSteer: false });
		makeSteerable();
		expect(sent()[0].route).toMatchObject({ status: 'queued', canSteer: true });
	});

	it('hands the message to the running turn and takes it out of the queue', async () => {
		makeSteerable();
		const { message } = await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'steer', messageId: message.id });

		expect(result.ok).toBe(true);
		expect(steer).toHaveBeenCalledWith('b-ai-b-main', 'actually, use the other file');
		expect(session('b').executionQueue).toEqual([]);
		// Its bubble is in the tab now, so the reply in progress is its turn.
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({
			status: 'running',
			tabId: 'b-main',
		});
	});

	it('defaults to the latest steerable message', async () => {
		makeSteerable();
		await queueBehindBusyMain();
		expect((await runQuickChatCommand({ type: 'steer' })).ok).toBe(true);
		expect(steer).toHaveBeenCalledTimes(1);
	});

	it('refuses a message the running turn cannot take, and leaves it queued', async () => {
		const { message } = await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'steer', messageId: message.id });

		expect(result.ok).toBe(false);
		expect(steer).not.toHaveBeenCalled();
		expect(session('b').executionQueue).toHaveLength(1);
	});

	it('keeps the message queued when the agent refuses the steer', async () => {
		makeSteerable();
		steer.mockResolvedValue({
			type: 'steering',
			id: '',
			verdict: 'refused',
			detail: 'The editor is busy.',
		});
		const { message } = await queueBehindBusyMain();
		const result = await runQuickChatCommand({ type: 'steer', messageId: message.id });

		expect(result).toMatchObject({ ok: false, error: 'The editor is busy. It stays queued.' });
		expect(session('b').executionQueue).toHaveLength(1);
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({ status: 'queued' });
	});

	it('refuses a message that is not waiting in the queue', async () => {
		makeSteerable();
		const { message } = await send('hello');
		expect((await runQuickChatCommand({ type: 'steer', messageId: message.id })).ok).toBe(false);
		expect(steer).not.toHaveBeenCalled();
	});
});

describe('wrong tab (thumbs-down): move a message that already ran', () => {
	async function sendToMain(text = 'about the deploy') {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		return send(text);
	}

	it('stops the reply in the wrong tab and sends the message again in a new tab', async () => {
		const { message } = await sendToMain();
		expect(message.route).toMatchObject({ status: 'running', tabId: 'b-main', origin: 'open' });

		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });

		expect(result.ok).toBe(true);
		expect(window.maestro.process.interrupt).toHaveBeenCalledWith('b-ai-b-main');
		const moved = sent(result.snapshot.messages)[0];
		expect(moved.route).toMatchObject({ status: 'running', origin: 'new' });
		expect(moved.route!.tabId).not.toBe('b-main');
		expect(tab('b', moved.route!.tabId).logs[0]).toMatchObject({ text: 'about the deploy' });
		// What reached the old tab stays there: it is the user's own tab.
		expect(tab('b', 'b-main').logs[0]).toMatchObject({ text: 'about the deploy' });
	});

	it('sends a finished message again without interrupting anything', async () => {
		const { message } = await sendToMain();
		reply('b', 'b-main', 'an answer for the wrong tab');

		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });

		expect(result.ok).toBe(true);
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
		const moved = sent(result.snapshot.messages)[0];
		expect(moved.route).toMatchObject({ status: 'running', origin: 'new' });
		// The thread shows the new tab's reply, not the wrong tab's.
		expect(result.snapshot.messages.map((m) => m.text)).not.toContain(
			'an answer for the wrong tab'
		);
	});

	it('moves the chat: the next message follows to the new tab', async () => {
		const { message } = await sendToMain();
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });
		const movedTo = sent(result.snapshot.messages)[0].route!.tabId;
		reply('b', movedTo!, 'ok');
		const next = await send('and then?');
		expect(next.message.route!.tabId).toBe(movedTo);
	});

	it('leaves alone a turn the user started in the old tab afterwards', async () => {
		const { message } = await sendToMain();
		reply('b', 'b-main', 'done');
		patchTab('b', 'b-main', (t) => ({
			state: 'busy',
			logs: [...t.logs, { id: 'own', timestamp: 3, source: 'user', text: 'mine' } as LogEntry],
		}));
		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });
		expect(result.ok).toBe(true);
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
	});

	it('ends an automatic retry holding the message, so it never runs in both tabs', async () => {
		const { message } = await sendToMain('hi');
		holdForRetry('b-main', tab('b', 'b-main').logs[0].queuedItemId!);
		expect(sent()[0].route?.status).toBe('running');

		const result = await runQuickChatCommand({ type: 'moveToNewTab', messageId: message.id });

		expect(result.ok).toBe(true);
		expect(useRetryStore.getState().retries).toEqual({});
		const moved = sent(result.snapshot.messages)[0];
		expect(moved.route).toMatchObject({ origin: 'new' });
		// The held resend left the queue; only the moved message was queued, and it ran.
		expect(session('b').executionQueue.filter((i) => i.tabId === 'b-main')).toEqual([]);
	});
});

describe('new chat', () => {
	// The ended chat finishes out of sight, and the engine's store subscription
	// is what notices it has.
	let stopEngine: () => void = () => {};
	beforeEach(() => {
		stopEngine = startQuickChatEngine();
	});
	afterEach(() => stopEngine());

	it('deletes a finished ephemeral tab without putting it on the undo stack', async () => {
		const { message } = await send('hi');
		reply('b', message.route!.tabId!, 'hello');
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

	it('lets a reply in progress finish out of sight, then deletes its hidden tab', async () => {
		const { message } = await send('plan the trip');
		const tabId = message.route!.tabId!;
		expect(message.route!.status).toBe('running');
		const chatId = buildQuickChatSnapshot().chatId;

		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.messages).toEqual([]);
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
		expect(tab('b', tabId)).toMatchObject({ hidden: true, state: 'busy' });

		vi.mocked(window.maestro.quickChat.saveRecent).mockClear();
		reply('b', tabId, 'Here is the plan');
		await vi.waitFor(() => expect(session('b').aiTabs.some((t) => t.id === tabId)).toBe(false), {
			timeout: 3000,
		});
		// The finished reply reached the recent chats list before its tab went.
		const saved = vi.mocked(window.maestro.quickChat.saveRecent).mock.calls.at(-1)![0];
		expect(saved.id).toBe(chatId);
		expect(saved.turns[0].reply.map((m) => m.text)).toEqual(['Here is the plan']);
		expect(session('b').closedTabHistory).toEqual([]);
	});

	it('runs a new chat beside the old one still replying', async () => {
		const old = await send('old');
		await runQuickChatCommand({ type: 'new' });
		const fresh = await send('fresh');

		expect(fresh.message.route!.status).toBe('running');
		expect(sent().map((m) => m.text)).toEqual(['fresh']);
		const tabs = session('b').aiTabs.map((t) => t.id);
		expect(tabs).toContain(old.message.route!.tabId);
		expect(tabs).toContain(fresh.message.route!.tabId);
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
	});

	it('still delivers a message whose tab was being found', async () => {
		let found: (target: { kind: 'new' }) => void = () => {};
		vi.mocked(routeQuickChatMessage).mockReturnValue(new Promise((resolve) => (found = resolve)));
		await runQuickChatCommand({ type: 'send', text: 'hello' });
		await runQuickChatCommand({ type: 'new' });

		found({ kind: 'new' });
		await vi.waitFor(() => expect(useAgentStore.getState().processQueuedItem).toHaveBeenCalled());
		const added = session('b').aiTabs.find((t) => t.id !== 'b-main')!;
		expect(added).toMatchObject({ hidden: true, quickChat: true });
		// It went to the old chat, not the one now in the window.
		expect(buildQuickChatSnapshot().messages).toEqual([]);
	});

	it('brings back a chat still finishing, live, without touching its tab', async () => {
		const { message } = await send('plan the trip');
		const tabId = message.route!.tabId!;
		const chatId = buildQuickChatSnapshot().chatId!;
		await runQuickChatCommand({ type: 'new' });

		vi.mocked(window.maestro.quickChat.getRecent).mockClear();
		const result = await runQuickChatCommand({ type: 'recall', chatId });
		expect(result.ok).toBe(true);
		expect(window.maestro.quickChat.getRecent).not.toHaveBeenCalled();
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({ status: 'running', tabId });

		// Finishing no longer retires it: it is the chat in the window again.
		reply('b', tabId, 'Here is the plan');
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(tab('b', tabId)).toMatchObject({ hidden: true });
		expect(buildQuickChatSnapshot().messages.map((m) => m.text)).toEqual([
			'plan the trip',
			'Here is the plan',
		]);
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

describe('choosing the tab (setTab)', () => {
	it("lists the visible tabs and the chat's own, and says where the next message goes", async () => {
		const empty = buildQuickChatSnapshot();
		expect(empty.next).toEqual({ kind: 'auto' });
		expect(empty.tabs.map((t) => t.id)).toEqual(['b-main']);

		const { message } = await send('hi');
		const own = message.route!.tabId!;
		const snapshot = buildQuickChatSnapshot();
		// The chat's tab is hidden (ephemeral), and still listed: it is the chat's.
		expect(snapshot.tabs.map((t) => [t.id, t.inChat, t.busy])).toEqual([
			['b-main', false, false],
			[own, true, true],
		]);
		expect(snapshot.next).toMatchObject({ kind: 'tab', tabId: own, chosen: false });
	});

	it('sends the next message to the tab picked, without routing, and the chat stays there', async () => {
		const first = await send('one');
		vi.mocked(routeQuickChatMessage).mockClear();
		const picked = await runQuickChatCommand({
			type: 'setTab',
			choice: { kind: 'tab', tabId: 'b-main' },
		});
		expect(picked.snapshot.next).toMatchObject({ kind: 'tab', tabId: 'b-main', chosen: true });

		const second = await send('two');
		const third = await send('three');
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
		expect(first.message.route!.tabId).not.toBe('b-main');
		expect(second.message.route).toMatchObject({ tabId: 'b-main', origin: 'open' });
		expect(third.message.route!.tabId).toBe('b-main');
		expect(buildQuickChatSnapshot().next).toMatchObject({ tabId: 'b-main', chosen: false });
	});

	it('starts a new tab for the next message when asked, even mid-chat', async () => {
		const first = await send('one');
		await runQuickChatCommand({ type: 'setTab', choice: { kind: 'new' } });
		expect(buildQuickChatSnapshot().next).toEqual({ kind: 'new' });
		vi.mocked(routeQuickChatMessage).mockClear();

		const second = await send('two');
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
		expect(second.message.route).toMatchObject({ origin: 'new' });
		expect(second.message.route!.tabId).not.toBe(first.message.route!.tabId);
		// And the chat continues there.
		expect((await send('three')).message.route!.tabId).toBe(second.message.route!.tabId);
	});

	it('picks a tab before the first message, skipping the search', async () => {
		await runQuickChatCommand({ type: 'setTab', choice: { kind: 'tab', tabId: 'b-main' } });
		const { message } = await send('hi');
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
		expect(message.route!.tabId).toBe('b-main');
	});

	it('routes the next message again when asked to find any tab', async () => {
		await send('one');
		await runQuickChatCommand({ type: 'setTab', choice: { kind: 'auto' } });
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		const second = await send('two');
		expect(routeQuickChatMessage).toHaveBeenCalledTimes(2);
		expect(second.message.route!.tabId).toBe('b-main');
	});

	it('picking the tab the chat is in clears the choice', async () => {
		const { message } = await send('one');
		const result = await runQuickChatCommand({
			type: 'setTab',
			choice: { kind: 'tab', tabId: message.route!.tabId! },
		});
		expect(result.snapshot.next).toMatchObject({ chosen: false });
	});

	it("refuses a tab that is not open, or is hidden and not the chat's", async () => {
		patchTab('b', 'b-main', () => ({ hidden: true }));
		for (const tabId of ['nope', 'b-main']) {
			const result = await runQuickChatCommand({ type: 'setTab', choice: { kind: 'tab', tabId } });
			expect(result.ok).toBe(false);
		}
		expect(buildQuickChatSnapshot().next).toEqual({ kind: 'auto' });
	});

	it('fails the message when the chosen tab closed before it was sent', async () => {
		await runQuickChatCommand({ type: 'setTab', choice: { kind: 'tab', tabId: 'b-main' } });
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b' ? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== 'b-main') } : s
				),
		});
		const { snapshot } = await send('hi');
		expect(snapshot.messages.at(-1)).toMatchObject({
			role: 'error',
			text: 'The tab you chose for this message is no longer open',
		});
	});

	it('a new chat forgets the choice', async () => {
		await runQuickChatCommand({ type: 'setTab', choice: { kind: 'new' } });
		await runQuickChatCommand({ type: 'new' });
		expect(buildQuickChatSnapshot().next).toEqual({ kind: 'auto' });
	});
});

describe('images', () => {
	const shot = 'data:image/png;base64,AAAA';
	const other = 'data:image/png;base64,BBBB';

	async function sendWithImages(text: string, images: string[]) {
		const result = await runQuickChatCommand({ type: 'send', text, images });
		await vi.waitFor(() => {
			expect(sent().at(-1)?.route?.status).not.toBe('searching');
		});
		return { result, message: sent().at(-1)! };
	}

	it('sends the images with the message to its tab', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		const { result } = await sendWithImages('what is this error?', [shot, other]);
		expect(result.ok).toBe(true);
		expect(useAgentStore.getState().processQueuedItem).toHaveBeenCalledWith(
			'b',
			expect.objectContaining({
				tabId: 'b-main',
				text: 'what is this error?',
				images: [shot, other],
			}),
			expect.anything()
		);
	});

	it('shows previews of the images on the message, not the images', async () => {
		await sendWithImages('look', [shot, other]);
		await vi.waitFor(() => {
			expect(sent().at(-1)?.images).toEqual([`preview:${shot}`, `preview:${other}`]);
		});
	});

	it('leaves images off a message that has none', async () => {
		const { message } = await send('plain');
		expect(message.images).toBeUndefined();
	});

	it('starts a new tab for images with no text, without looking for one', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		const { result, message } = await sendWithImages('  ', [shot]);
		expect(result.ok).toBe(true);
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
		expect(message.route).toMatchObject({ origin: 'new' });
		expect(message.route!.tabId).not.toBe('b-main');
		expect(useAgentStore.getState().processQueuedItem).toHaveBeenCalledWith(
			'b',
			expect.objectContaining({ images: [shot] }),
			expect.anything()
		);
	});

	it('keeps a slash command sent with images a message, so the images reach the agent', async () => {
		registerDispatchDepsProvider(() => ({
			conductorProfile: '',
			customAICommands: [
				{ id: 'c', command: '/review', description: 'Review', prompt: 'Review it' },
			],
			speckitCommands: [],
			openspecCommands: [],
		}));
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		await sendWithImages('/review', [shot]);
		expect(useAgentStore.getState().processQueuedItem).toHaveBeenCalledWith(
			'b',
			expect.objectContaining({ type: 'message', text: '/review', images: [shot] }),
			expect.anything()
		);
	});

	it('still refuses a message with neither text nor images', async () => {
		const result = await runQuickChatCommand({ type: 'send', text: ' ', images: [] });
		expect(result).toMatchObject({ ok: false, error: 'Message cannot be empty' });
	});
});

describe('Default Tab setting', () => {
	it('starts a new chat in a new tab, without routing, when set to new', async () => {
		setQuickChatSettings({ defaultTab: 'new' });
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		expect(buildQuickChatSnapshot().next).toEqual({ kind: 'new' });

		const first = await send('one');
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
		expect(first.message.route).toMatchObject({ origin: 'new' });
		expect(first.message.route!.tabId).not.toBe('b-main');
		// Later messages follow the chat's tab, not the setting.
		expect((await send('two')).message.route!.tabId).toBe(first.message.route!.tabId);
	});

	it('starts a new tab again after the chat tab closes, when set to new', async () => {
		setQuickChatSettings({ defaultTab: 'new' });
		const first = await send('one');
		const closed = first.message.route!.tabId!;
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b' ? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== closed) } : s
				),
		});
		expect(buildQuickChatSnapshot().next).toEqual({ kind: 'new' });
		const second = await send('two');
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
		expect(second.message.route).toMatchObject({ origin: 'new' });
		expect(second.message.route!.tabId).not.toBe(closed);
	});

	it('still routes a message the user sends to any tab, when set to new', async () => {
		setQuickChatSettings({ defaultTab: 'new' });
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		await runQuickChatCommand({ type: 'setTab', choice: { kind: 'auto' } });
		expect(buildQuickChatSnapshot().next).toEqual({ kind: 'auto' });
		const { message } = await send('one');
		expect(routeQuickChatMessage).toHaveBeenCalledTimes(1);
		expect(message.route!.tabId).toBe('b-main');
	});

	it('routes the first message by default (Choose tab)', async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		const { message } = await send('one');
		expect(routeQuickChatMessage).toHaveBeenCalledTimes(1);
		expect(message.route).toMatchObject({ tabId: 'b-main', origin: 'open' });
	});
});

describe('thinking (setThinking)', () => {
	/** The agent reasons in a tab, then (optionally) answers. */
	function think(tabId: string, text: string): void {
		patchTab('b', tabId, (t) => ({
			logs: [...t.logs, { id: `th-${t.logs.length}`, timestamp: 2, source: 'thinking', text }],
		}));
	}

	it('is off by default and records nothing extra in the tab', async () => {
		const { message, snapshot } = await send('hi');
		expect(snapshot.thinking).toBe('off');
		expect(tab('b', message.route!.tabId).showThinking).toBe('off');
	});

	it('cycles off, on, sticky, off, and remembers the mode as a setting', async () => {
		const steps: string[] = [];
		for (let i = 0; i < 3; i++) {
			const result = await runQuickChatCommand({ type: 'setThinking', mode: 'cycle' });
			steps.push(result.snapshot.thinking);
		}
		expect(steps).toEqual(['on', 'sticky', 'off']);
		await runQuickChatCommand({ type: 'setThinking', mode: 'sticky' });
		expect(useSettingsStore.getState().quickChatSettings.thinking).toBe('sticky');
	});

	it('records reasoning in a tab it creates, and shows it while the reply runs', async () => {
		setQuickChatSettings({ thinking: 'on' });
		const { message } = await send('hi');
		const tabId = message.route!.tabId!;
		expect(tab('b', tabId).showThinking).toBe('on');

		think(tabId, 'Looking it up.');
		expect(buildQuickChatSnapshot().messages.map((m) => m.role)).toEqual(['user', 'thinking']);

		reply('b', tabId, 'Done.');
		expect(buildQuickChatSnapshot().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
	});

	it('keeps the reasoning above the answer when sticky', async () => {
		setQuickChatSettings({ thinking: 'sticky' });
		const { message } = await send('hi');
		const tabId = message.route!.tabId!;
		think(tabId, 'Looking it up.');
		reply('b', tabId, 'Done.');
		expect(buildQuickChatSnapshot().messages.map((m) => m.role)).toEqual([
			'user',
			'thinking',
			'assistant',
		]);
	});

	it('applies a change mid-chat to the tabs the chat already used', async () => {
		const { message } = await send('hi');
		await runQuickChatCommand({ type: 'setThinking', mode: 'sticky' });
		expect(tab('b', message.route!.tabId).showThinking).toBe('sticky');
	});

	it("raises the user's own tab to show thinking, but never lowers it", async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ showThinking: 'sticky' }));
		think('b-main', 'Earlier reasoning the user kept.');
		setQuickChatSettings({ thinking: 'on' });
		await send('hi');
		await runQuickChatCommand({ type: 'setThinking', mode: 'off' });

		// Lowering it would have deleted the reasoning already in the tab.
		expect(tab('b', 'b-main').showThinking).toBe('sticky');
		expect(tab('b', 'b-main').logs.some((l) => l.source === 'thinking')).toBe(true);

		patchTab('b', 'b-main', () => ({ showThinking: 'off' }));
		await runQuickChatCommand({ type: 'setThinking', mode: 'on' });
		expect(tab('b', 'b-main').showThinking).toBe('on');
	});

	it("hides the thinking in the window when off, even when the tab's chip keeps it", async () => {
		vi.mocked(routeQuickChatMessage).mockResolvedValue({ kind: 'open', tabId: 'b-main' });
		patchTab('b', 'b-main', () => ({ showThinking: 'sticky' }));
		await send('hi');
		think('b-main', 'Hidden from the window.');
		expect(buildQuickChatSnapshot().messages.map((m) => m.role)).toEqual(['user']);
	});

	it('rejects an unknown mode', async () => {
		const result = await runQuickChatCommand({
			type: 'setThinking',
			mode: 'loud' as unknown as 'on',
		});
		expect(result.ok).toBe(false);
		expect(useSettingsStore.getState().quickChatSettings.thinking).toBe('off');
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
		reply('b', message.route!.tabId!, 'hello');
		const result = await runQuickChatCommand({ type: 'setAgent', agentId: 'a' });
		expect(result.snapshot.agentId).toBe('a');
		expect(result.snapshot.tabId).toBeNull();
		expect(useSettingsStore.getState().quickChatSettings.agentId).toBe('a');
		expect(session('b').aiTabs.some((t) => t.id === message.route!.tabId)).toBe(false);
	});

	it('rejects an unknown agent', async () => {
		expect((await runQuickChatCommand({ type: 'setAgent', agentId: 'nope' })).ok).toBe(false);
	});

	it("lets the old chat's reply finish while the next message goes to the agent just chosen", async () => {
		const old = await send('old');
		await runQuickChatCommand({ type: 'setAgent', agentId: 'a' });
		await send('fresh');

		expect(sent().at(-1)?.route?.status).toBe('running');
		expect(buildQuickChatSnapshot().agentId).toBe('a');
		expect(session('a').aiTabs).toHaveLength(2);
		expect(tab('b', old.message.route!.tabId)).toMatchObject({ state: 'busy' });
		expect(window.maestro.process.interrupt).not.toHaveBeenCalled();
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
		await send('about lunch');
		// Queued behind the first reply, then moved to a tab of its own.
		expect((await runQuickChatCommand({ type: 'moveToNewTab' })).ok).toBe(true);
		const second = sent()[1];
		expect(second.route!.tabId).not.toBe('b-main');
		// The second message is answered first.
		reply('b', second.route!.tabId!, 'sandwich');
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

describe('recent chats', () => {
	/** Put a tab on an agent, the way reopening a closed conversation does. */
	function addTab(sessionId: string, added: AITab): void {
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === sessionId ? { ...s, aiTabs: [...s.aiTabs, added] } : s)),
		});
	}

	const recentOn = (overrides: Partial<QuickChatRecent> = {}): QuickChatRecent => ({
		id: 'chat-1',
		agentId: 'a',
		agentName: 'Agent a',
		persistent: true,
		createdAt: 1,
		updatedAt: 3,
		homeTabId: 'a-main',
		homeAgentSessionId: 'conv-a',
		homeTabName: 'Main',
		ownedTabIds: [],
		turns: [
			{
				id: 'turn-1',
				text: 'how is the build',
				timestamp: 1,
				phase: 'delivered',
				error: null,
				tabId: 'a-main',
				agentSessionId: 'conv-a',
				tabName: 'Main',
				origin: 'open',
				queuedItemId: 'q-1',
				reply: [{ id: 'old', role: 'assistant', text: 'old copy', timestamp: 2 }],
			},
		],
		...overrides,
	});

	it('saves a chat to the list as it leaves the window, with its thread and tab', async () => {
		const { message } = await send('plan the trip');
		const tabId = message.route!.tabId!;
		patchTab('b', tabId, () => ({ agentSessionId: 'conv-1' }));
		reply('b', tabId, 'Here is the plan');
		const chatId = buildQuickChatSnapshot().chatId;
		expect(chatId).toBeTruthy();

		vi.mocked(window.maestro.quickChat.saveRecent).mockClear();
		await runQuickChatCommand({ type: 'new' });
		const saved = vi.mocked(window.maestro.quickChat.saveRecent).mock.calls.at(-1)![0];
		expect(saved).toMatchObject({
			id: chatId,
			agentId: 'b',
			persistent: false,
			homeTabId: tabId,
			homeAgentSessionId: 'conv-1',
			ownedTabIds: [tabId],
		});
		expect(saved.turns[0]).toMatchObject({ text: 'plan the trip', tabId, origin: 'new' });
		expect(saved.turns[0].reply.map((m) => m.text)).toEqual(['Here is the plan']);
		expect(buildQuickChatSnapshot().chatId).toBeNull();
	});

	it('keeps the list current while a chat runs', async () => {
		vi.mocked(window.maestro.quickChat.saveRecent).mockClear();
		await runQuickChatCommand({ type: 'send', text: 'hello' });
		await vi.waitFor(() => expect(window.maestro.quickChat.saveRecent).toHaveBeenCalled(), {
			timeout: 3000,
		});
		expect(vi.mocked(window.maestro.quickChat.saveRecent).mock.calls.at(-1)![0]).toMatchObject({
			id: buildQuickChatSnapshot().chatId,
			turns: [{ text: 'hello' }],
		});
	});

	it("brings back an ephemeral chat, reopening its deleted tab as the chat's hidden own", async () => {
		const { message } = await send('plan the trip');
		const tabId = message.route!.tabId!;
		patchTab('b', tabId, () => ({ agentSessionId: 'conv-1' }));
		reply('b', tabId, 'Here is the plan');
		const chatId = buildQuickChatSnapshot().chatId!;
		await runQuickChatCommand({ type: 'new' });
		const saved = vi.mocked(window.maestro.quickChat.saveRecent).mock.calls.at(-1)![0];
		expect(session('b').aiTabs.some((t) => t.id === tabId)).toBe(false);

		vi.mocked(window.maestro.quickChat.getRecent).mockResolvedValueOnce(saved);
		vi.mocked(reopenClosedConversation).mockImplementation(async (sessionId) => {
			addTab(
				sessionId,
				createMockAITab({
					id: 'reopened',
					agentSessionId: 'conv-1',
					logs: [
						{ id: 'u', timestamp: 1, source: 'user', text: 'plan the trip' },
						{ id: 'o', timestamp: 2, source: 'stdout', text: 'Here is the plan' },
					] as LogEntry[],
				})
			);
			return 'reopened';
		});
		const result = await runQuickChatCommand({ type: 'recall', chatId });

		expect(result.ok).toBe(true);
		expect(reopenClosedConversation).toHaveBeenCalledWith('b', {
			agentSessionId: 'conv-1',
			name: saved.homeTabName,
		});
		expect(result.snapshot.chatId).toBe(chatId);
		expect(result.snapshot.messages.map((m) => m.text)).toEqual([
			'plan the trip',
			'Here is the plan',
		]);
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({
			status: 'done',
			tabId: 'reopened',
			tabOpen: true,
		});
		expect(result.snapshot.next).toMatchObject({ kind: 'tab', tabId: 'reopened' });
		expect(tab('b', 'reopened')).toMatchObject({ hidden: true, quickChat: true });

		// The next message continues the conversation where it was, unrouted.
		vi.mocked(routeQuickChatMessage).mockClear();
		const next = await send('and the hotel?');
		expect(next.message.route).toMatchObject({ tabId: 'reopened' });
		expect(routeQuickChatMessage).not.toHaveBeenCalled();
	});

	it("reuses a tab still open, reads its reply live, and moves Quick Chat to the chat's agent", async () => {
		patchTab('a', 'a-main', () => ({
			agentSessionId: 'conv-a',
			tabProvider: 'codex',
			logs: [
				{ id: 'card', timestamp: 1, source: 'user', text: 'how is the build', queuedItemId: 'q-1' },
				{ id: 'out', timestamp: 2, source: 'stdout', text: 'green' },
			] as LogEntry[],
		}));
		vi.mocked(window.maestro.quickChat.getRecent).mockResolvedValueOnce(recentOn());

		const result = await runQuickChatCommand({ type: 'recall', chatId: 'chat-1' });

		expect(result.ok).toBe(true);
		expect(reopenClosedConversation).not.toHaveBeenCalled();
		expect(result.snapshot).toMatchObject({ chatId: 'chat-1', agentId: 'a', persistent: true });
		expect(result.snapshot.agents.find((entry) => entry.id === 'a')?.provider).toBe('Codex');
		expect(useSettingsStore.getState().quickChatSettings.agentId).toBe('a');
		expect(result.snapshot.messages.map((m) => m.text)).toEqual(['how is the build', 'green']);
		expect(result.snapshot.next).toMatchObject({ kind: 'tab', tabId: 'a-main' });
	});

	it('shows the remembered reply when the conversation cannot be reopened', async () => {
		vi.mocked(window.maestro.quickChat.getRecent).mockResolvedValueOnce(
			recentOn({ homeTabId: 'gone', turns: [{ ...recentOn().turns[0], tabId: 'gone' }] })
		);
		const result = await runQuickChatCommand({ type: 'recall', chatId: 'chat-1' });
		expect(result.ok).toBe(true);
		expect(reopenClosedConversation).toHaveBeenCalled();
		expect(result.snapshot.messages.map((m) => m.text)).toEqual(['how is the build', 'old copy']);
		expect(sent(result.snapshot.messages)[0].route).toMatchObject({
			status: 'done',
			tabOpen: false,
		});
	});

	it('keeps the chat in progress when the recalled one cannot come back', async () => {
		await send('still here');
		vi.mocked(window.maestro.quickChat.getRecent).mockResolvedValueOnce(
			recentOn({ agentId: 'deleted', agentName: 'Old agent' })
		);
		const gone = await runQuickChatCommand({ type: 'recall', chatId: 'chat-1' });
		expect(gone).toMatchObject({ ok: false, error: expect.stringMatching(/Old agent.*no longer/) });

		const missing = await runQuickChatCommand({ type: 'recall', chatId: 'nope' });
		expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/no longer in/) });
		expect(sent(missing.snapshot.messages).map((m) => m.text)).toEqual(['still here']);
	});

	it('recalling the chat already in the window changes nothing', async () => {
		await send('hello');
		const chatId = buildQuickChatSnapshot().chatId!;
		vi.mocked(window.maestro.quickChat.getRecent).mockClear();
		const result = await runQuickChatCommand({ type: 'recall', chatId });
		expect(result.ok).toBe(true);
		expect(window.maestro.quickChat.getRecent).not.toHaveBeenCalled();
		expect(sent(result.snapshot.messages).map((m) => m.text)).toEqual(['hello']);
	});
});

describe('isQuickChatTab', () => {
	it('recognizes only tabs Quick Chat created', () => {
		expect(isQuickChatTab({ quickChat: true })).toBe(true);
		expect(isQuickChatTab({})).toBe(false);
		expect(isQuickChatTab(undefined)).toBe(false);
	});
});
