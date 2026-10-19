/**
 * Tests for services/tabWindowIntents: the owner window's intent dispatcher
 * (Tab Windows, D2).
 *
 * The contract under test is the task's: every action a tab window sends runs
 * in the owner through the SAME function the owner's own UI calls, with the
 * same arguments, aimed at the popped tab the intent names. Each case below
 * names that function (a service mock, or a hook-instance handler), and the
 * refusals keep an intent from reaching an agent or tab this window cannot act
 * on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const services = vi.hoisted(() => ({
	setAiTabModel: vi.fn(() => true),
	setAiTabEffort: vi.fn(() => true),
	setAiTabPermissionMode: vi.fn(() => true),
	toggleAiTabReadOnlyMode: vi.fn(() => true),
	cycleAiTabShowThinking: vi.fn(() => true),
	setAiTabShowThinking: vi.fn(() => true),
	toggleAiTabSaveToHistory: vi.fn(() => true),
	toggleAiTabEnterToSend: vi.fn(() => true),
	setAiTabStarred: vi.fn(() => true),
	markAiTabUnread: vi.fn(() => true),
	removeQueuedItem: vi.fn(() => true),
	toggleQueuedItemPaused: vi.fn(() => true),
	mergeQueuedItemIntoAbove: vi.fn<() => string | null>(() => 'q0'),
	editQueuedItem: vi.fn(() => true),
	reorderQueuedItems: vi.fn(),
	renameTabInSession: vi.fn(),
	requestManualTabAutoName: vi.fn(() => true),
	snoozeTabWithMirror: vi.fn<() => object | null>(() => ({ id: 'snoozed' })),
	steerNewestQueuedMessage: vi.fn(() => Promise.resolve({ steered: true })),
	cancelShellCommand: vi.fn(() => Promise.resolve(true)),
	dispatchShellCommand: vi.fn(() => Promise.resolve()),
	jumpToAgent: vi.fn(() => true),
	loadEarlierTranscriptForTab: vi.fn(() => Promise.resolve()),
	retryNow: vi.fn(),
	cancelRetry: vi.fn(),
	openMaestroLink: vi.fn(() => true),
	openInMaestroBrowser: vi.fn(),
	captureException: vi.fn(),
}));

vi.mock('../../../renderer/services/aiTabActions', () => ({
	setAiTabModel: services.setAiTabModel,
	setAiTabEffort: services.setAiTabEffort,
	setAiTabPermissionMode: services.setAiTabPermissionMode,
	toggleAiTabReadOnlyMode: services.toggleAiTabReadOnlyMode,
	cycleAiTabShowThinking: services.cycleAiTabShowThinking,
	setAiTabShowThinking: services.setAiTabShowThinking,
	toggleAiTabSaveToHistory: services.toggleAiTabSaveToHistory,
	toggleAiTabEnterToSend: services.toggleAiTabEnterToSend,
	setAiTabStarred: services.setAiTabStarred,
	markAiTabUnread: services.markAiTabUnread,
}));
vi.mock('../../../renderer/services/queuedPrompt', () => ({
	removeQueuedItem: services.removeQueuedItem,
	toggleQueuedItemPaused: services.toggleQueuedItemPaused,
	mergeQueuedItemIntoAbove: services.mergeQueuedItemIntoAbove,
	editQueuedItem: services.editQueuedItem,
	reorderQueuedItems: services.reorderQueuedItems,
}));
vi.mock('../../../renderer/services/tabRename', () => ({
	renameTabInSession: services.renameTabInSession,
}));
vi.mock('../../../renderer/services/tabAutoNaming', () => ({
	requestManualTabAutoName: services.requestManualTabAutoName,
}));
vi.mock('../../../renderer/services/snoozeActions', () => ({
	snoozeTabWithMirror: services.snoozeTabWithMirror,
}));
vi.mock('../../../renderer/services/chatSteering', () => ({
	steerNewestQueuedMessage: services.steerNewestQueuedMessage,
}));
vi.mock('../../../renderer/services/shellCommand', () => ({
	cancelShellCommand: services.cancelShellCommand,
	dispatchShellCommand: services.dispatchShellCommand,
}));
vi.mock('../../../renderer/services/agentNavigation', () => ({
	jumpToAgent: services.jumpToAgent,
}));
vi.mock('../../../renderer/services/transcriptBackfill', () => ({
	loadEarlierTranscriptForTab: services.loadEarlierTranscriptForTab,
}));
vi.mock('../../../renderer/stores/retryStore', () => ({
	retryNow: services.retryNow,
	cancelRetry: services.cancelRetry,
}));
vi.mock('../../../renderer/utils/openMaestroLink', () => ({
	openMaestroLink: services.openMaestroLink,
}));
vi.mock('../../../renderer/utils/openUrl', () => ({
	openInMaestroBrowser: services.openInMaestroBrowser,
}));
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: services.captureException,
}));

const web = vi.hoisted(() => ({ value: false }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => web.value,
}));

import {
	dispatchTabWindowIntent,
	startTabWindowIntentDispatcher,
	type TabWindowOwnerHandlers,
} from '../../../renderer/services/tabWindowIntents';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { isTabViewedInTabWindow, useTabWindowStore } from '../../../renderer/stores/tabWindowStore';
import { useCoworkingApprovalStore } from '../../../renderer/stores/coworkingApprovalStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import type { QueuedItem, Session, TerminalTab } from '../../../renderer/types';
import type { BrowserTab } from '../../../shared/browserPage';
import type {
	TabWindowIntent,
	TabWindowIntentKind,
	TabWindowTabRef,
} from '../../../shared/tabWindowTypes';
import { TAB_WINDOW_INTENT_KINDS } from '../../../shared/tabWindowTypes';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import {
	createTabWindowOwnerHandlers,
	installTabWindowsApi,
	popOutTabsInStore,
} from '../../helpers/tabWindows';

const AGENT = 'agent-1';
const POPPED: TabWindowTabRef = { type: 'ai', id: 'popped' };
const FILE: TabWindowTabRef = { type: 'file', id: 'file-1' };
const TERMINAL: TabWindowTabRef = { type: 'terminal', id: 'term-1' };
const TARGET = { sessionId: AGENT, tabId: 'popped' };

function queued(id: string): QueuedItem {
	return { id, timestamp: 1, tabId: 'popped', type: 'message', text: `item ${id}` };
}

function agent(): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [
			createMockAITab({ id: 'popped', agentSessionId: 'claude-1', inputValue: 'old draft' }),
			createMockAITab({ id: 'home' }),
		],
		filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
		terminalTabs: [
			{
				id: 'term-1',
				name: null,
				shellType: 'zsh',
				pid: 1,
				cwd: '/',
				createdAt: 0,
				state: 'idle',
			} as TerminalTab,
		],
		activeTabId: 'home',
		executionQueue: [queued('q1'), queued('q2')],
	});
}

/** One intent for the popped AI tab (or `tabRef`). */
function intent<K extends TabWindowIntentKind>(
	kind: K,
	payload: Omit<Extract<TabWindowIntent, { kind: K }>, 'kind' | 'agentId' | 'tabRef'>,
	tabRef: TabWindowTabRef = POPPED
): TabWindowIntent {
	return { kind, agentId: AGENT, tabRef, ...payload } as TabWindowIntent;
}

let h: TabWindowOwnerHandlers;

beforeEach(() => {
	vi.clearAllMocks();
	web.value = false;
	useSessionStore.setState({ sessions: [agent()], activeSessionId: AGENT });
	useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
	popOutTabsInStore(AGENT, [POPPED, FILE, TERMINAL]);
	useTabWindowStore.setState({ viewedTabs: new Set() });
	h = createTabWindowOwnerHandlers();
});

afterEach(() => {
	useTabWindowStore.getState().setWindows([]);
});

describe('dispatchTabWindowIntent: every intent runs the function the owner UI runs', () => {
	// The composer (table A).
	it('send: the composer send path, aimed at the popped tab, with the draft it carried', () => {
		const outcome = dispatchTabWindowIntent(
			intent('send', {
				text: 'hello @Backend',
				images: ['data:image/png;base64,AA'],
				commandMode: 'off',
				mentionRoutingOverride: 'parallel',
				forceParallel: true,
				hold: false,
				steer: false,
			}),
			h
		);
		expect(outcome).toEqual({ handled: true });
		expect(h.processInput).toHaveBeenCalledWith('hello @Backend', {
			sessionId: AGENT,
			tabId: 'popped',
			images: ['data:image/png;base64,AA'],
			forceParallel: true,
			hold: false,
			steer: false,
			fromTabWindow: {
				composer: { commandMode: 'off', mentionRoutingOverride: 'parallel' },
			},
		});
	});

	it('send: a command line keeps its command mode, and no images means none', () => {
		dispatchTabWindowIntent(intent('send', { text: 'ls -la', commandMode: 'shell' }), h);
		expect(h.processInput).toHaveBeenCalledWith(
			'ls -la',
			expect.objectContaining({
				images: [],
				fromTabWindow: { composer: { commandMode: 'shell', mentionRoutingOverride: undefined } },
			})
		);
	});

	it('runShellCommand: the accepted AI command runs through the shell runner on the tab', () => {
		dispatchTabWindowIntent(
			intent('runShellCommand', { command: 'git status', request: 'status?' }),
			h
		);
		expect(services.dispatchShellCommand).toHaveBeenCalledWith({
			session: expect.objectContaining({ id: AGENT }),
			tabId: 'popped',
			command: 'git status',
			request: 'status?',
		});
	});

	it.each([
		['setModel', { model: 'opus' }, 'setAiTabModel', ['opus']],
		['setModel', { model: undefined }, 'setAiTabModel', [undefined]],
		['setEffort', { effort: 'high' }, 'setAiTabEffort', ['high']],
		['setPermissionMode', { mode: 'readonly' }, 'setAiTabPermissionMode', ['readonly']],
		['toggleReadOnly', {}, 'toggleAiTabReadOnlyMode', []],
		['setThinkingMode', { mode: 'cycle' }, 'cycleAiTabShowThinking', []],
		['setThinkingMode', { mode: 'sticky' }, 'setAiTabShowThinking', ['sticky']],
		['toggleSaveToHistory', {}, 'toggleAiTabSaveToHistory', []],
		['toggleEnterToSend', {}, 'toggleAiTabEnterToSend', []],
		['starTab', { starred: true }, 'setAiTabStarred', [true]],
		['markUnread', {}, 'markAiTabUnread', []],
	] as const)('%s %o: %s on the popped tab', (kind, payload, service, args) => {
		const outcome = dispatchTabWindowIntent(intent(kind, payload as never), h);
		expect(outcome).toEqual({ handled: true });
		expect(services[service]).toHaveBeenCalledWith(TARGET, ...args);
	});

	it('steerNewest: steers the newest queued message of the popped tab', () => {
		dispatchTabWindowIntent(intent('steerNewest', {}), h);
		expect(services.steerNewestQueuedMessage).toHaveBeenCalledWith(AGENT, 'popped');
	});

	it("interrupt: the owner's Stop, for the agent, with the popped tab as the stopped one", () => {
		dispatchTabWindowIntent(intent('interrupt', {}), h);
		expect(h.interruptAgent).toHaveBeenCalledWith({
			sessionId: AGENT,
			tabId: 'popped',
			mode: 'ai',
		});
	});

	it('stopWizardTurn, summarizeAndContinue, cancelSummarize, cancelMerge: the hook handlers', () => {
		dispatchTabWindowIntent(intent('stopWizardTurn', {}), h);
		dispatchTabWindowIntent(intent('summarizeAndContinue', {}), h);
		dispatchTabWindowIntent(intent('cancelSummarize', {}), h);
		dispatchTabWindowIntent(intent('cancelMerge', {}), h);
		expect(h.cancelWizardTurn).toHaveBeenCalledWith('popped');
		expect(h.summarizeAndContinue).toHaveBeenCalledWith('popped', AGENT);
		expect(h.cancelSummarize).toHaveBeenCalledWith('popped');
		expect(h.cancelMerge).toHaveBeenCalledWith('popped');
	});

	it('setDraft: writes the tab window draft back onto the tab', () => {
		dispatchTabWindowIntent(
			intent('setDraft', { inputValue: 'new draft', commandMode: 'shell', stagedImages: ['img'] }),
			h
		);
		const tab = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 'popped')!;
		expect(tab.inputValue).toBe('new draft');
		expect(tab.commandMode).toBe('shell');
		expect(tab.stagedImages).toEqual(['img']);
	});

	it('setDraft: a draft that already matches writes nothing', () => {
		const before = useSessionStore.getState().sessions;
		dispatchTabWindowIntent(
			intent('setDraft', { inputValue: 'old draft', commandMode: 'off', stagedImages: [] }),
			h
		);
		expect(useSessionStore.getState().sessions).toBe(before);
	});

	it("setDraft: leaves this window's composer alone while it drafts for another tab", () => {
		useComposerInputStore.getState().loadAiDraft('home', 'typed for home', 'off');
		dispatchTabWindowIntent(
			intent('setDraft', { inputValue: 'new draft', commandMode: 'off', stagedImages: [] }),
			h
		);
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValueTabId: 'home',
			aiValue: 'typed for home',
		});
	});

	it('setDraft after the tab docked: the composer showing the copy it loaded takes the newer draft', () => {
		// A closed tab window docks in main before its page sends the last draft,
		// so this window has shown the tab, with the copy it held, already.
		useComposerInputStore.getState().loadAiDraft('popped', 'old draft', 'off');
		dispatchTabWindowIntent(
			intent('setDraft', {
				inputValue: 'old draft, finished',
				commandMode: 'shell',
				stagedImages: [],
			}),
			h
		);
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValueTabId: 'popped',
			aiValue: 'old draft, finished',
			aiCommandMode: 'shell',
		});
		const tab = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 'popped')!;
		expect(tab.inputValue).toBe('old draft, finished');
	});

	it('setDraft after the tab docked: text typed here since the dock stays in the composer', () => {
		useComposerInputStore.getState().loadAiDraft('popped', 'old draft', 'off');
		useComposerInputStore.getState().setAiValue('old draft, typed here');
		dispatchTabWindowIntent(
			intent('setDraft', {
				inputValue: 'old draft, finished',
				commandMode: 'off',
				stagedImages: [],
			}),
			h
		);
		expect(useComposerInputStore.getState().aiValue).toBe('old draft, typed here');
	});

	// The queue (table B).
	it.each([
		['removeQueuedItem', 'removeQueuedItem'],
		['toggleQueuedItemPaused', 'toggleQueuedItemPaused'],
		['mergeQueuedItem', 'mergeQueuedItemIntoAbove'],
	] as const)("%s: the queue service the owner's queued card calls", (kind, service) => {
		expect(dispatchTabWindowIntent(intent(kind, { itemId: 'q2' }), h)).toEqual({ handled: true });
		expect(services[service]).toHaveBeenCalledWith(AGENT, 'q2');
	});

	it('editQueuedItem: rewrites the item with the edit the modal saved', () => {
		const patch = { text: 'edited', images: [], turnSettings: { model: 'sonnet' } };
		dispatchTabWindowIntent(intent('editQueuedItem', { itemId: 'q1', patch }), h);
		expect(services.editQueuedItem).toHaveBeenCalledWith(AGENT, 'q1', patch);
	});

	it("reorderQueuedItem: moves within the popped tab's own items", () => {
		dispatchTabWindowIntent(intent('reorderQueuedItem', { fromIndex: 1, toIndex: 0 }), h);
		expect(services.reorderQueuedItems).toHaveBeenCalledWith(AGENT, 1, 0, 'popped');
	});

	it('forceSendQueuedItem and steerQueuedItem: the queue handlers, with the agent', () => {
		dispatchTabWindowIntent(intent('forceSendQueuedItem', { itemId: 'q1' }), h);
		dispatchTabWindowIntent(intent('steerQueuedItem', { itemId: 'q2' }), h);
		expect(h.forceSendQueuedItem).toHaveBeenCalledWith(AGENT, 'q1');
		expect(h.steerQueuedItem).toHaveBeenCalledWith(AGENT, 'q2');
	});

	it('forceSendQueuedItem and steerQueuedItem refuse an item that already left the queue', () => {
		expect(dispatchTabWindowIntent(intent('forceSendQueuedItem', { itemId: 'gone' }), h)).toEqual({
			handled: false,
			reason: 'the item is not queued',
		});
		expect(dispatchTabWindowIntent(intent('steerQueuedItem', { itemId: 'gone' }), h).handled).toBe(
			false
		);
		expect(h.forceSendQueuedItem).not.toHaveBeenCalled();
		expect(h.steerQueuedItem).not.toHaveBeenCalled();
	});

	// The thinking pill (table C).
	it('stopAutoRun: the Auto Run stop, confirmed in the tab window', () => {
		dispatchTabWindowIntent(intent('stopAutoRun', {}), h);
		expect(h.stopBatchRun).toHaveBeenCalledWith(AGENT);
	});

	it('focusInOwner: jumps to the tab in this window, then raises it', () => {
		const home: TabWindowTabRef = { type: 'ai', id: 'home' };
		dispatchTabWindowIntent(intent('focusInOwner', { targetTabRef: home }), h);
		expect(services.jumpToAgent).toHaveBeenCalledWith(AGENT, { tabRef: home });
		expect(h.raiseWindow).toHaveBeenCalled();
	});

	it('focusInOwner on a popped tab leaves the raise to the tab window the jump focused', () => {
		dispatchTabWindowIntent(intent('focusInOwner', { targetTabRef: POPPED }), h);
		expect(services.jumpToAgent).toHaveBeenCalledWith(AGENT, { tabRef: POPPED });
		expect(h.raiseWindow).not.toHaveBeenCalled();
	});

	// The chip and its menu (table D).
	it('closeTab on an AI tab: the chip close path, for the agent', () => {
		dispatchTabWindowIntent(intent('closeTab', {}), h);
		expect(h.performTabClose).toHaveBeenCalledWith('popped', AGENT);
		expect(h.closeTabRefs).not.toHaveBeenCalled();
	});

	it.each([FILE, TERMINAL])('closeTab on a %o tab: the close that stops its process too', (ref) => {
		dispatchTabWindowIntent(intent('closeTab', {}, ref), h);
		expect(h.closeTabRefs).toHaveBeenCalledWith(AGENT, [ref]);
		expect(h.performTabClose).not.toHaveBeenCalled();
	});

	it('renameTab: the rename the modal runs, for any kind of tab', () => {
		dispatchTabWindowIntent(intent('renameTab', { name: 'Specs' }), h);
		dispatchTabWindowIntent(intent('renameTab', { name: 'notes.md' }, FILE), h);
		expect(services.renameTabInSession).toHaveBeenNthCalledWith(1, AGENT, 'popped', 'Specs');
		expect(services.renameTabInSession).toHaveBeenNthCalledWith(2, AGENT, 'file-1', 'notes.md');
	});

	it("autoNameTab: the rename modal's Auto", () => {
		dispatchTabWindowIntent(intent('autoNameTab', {}), h);
		expect(services.requestManualTabAutoName).toHaveBeenCalledWith(AGENT, 'popped');
	});

	it('snoozeTab: the snooze the modal runs, on the agent the intent names', () => {
		dispatchTabWindowIntent(
			intent('snoozeTab', { wakeAt: 5000, note: 'later', wakePrompt: 'continue' }),
			h
		);
		expect(services.snoozeTabWithMirror).toHaveBeenCalledWith(
			'popped',
			5000,
			{ note: 'later', wakePrompt: 'continue' },
			{ sessionId: AGENT }
		);
	});

	it("reorderTabs: writes the tab window's own order to the registry", async () => {
		const api = installTabWindowsApi();
		const reorder = vi.fn().mockResolvedValue({ reordered: true, windowId: 'tw-1' });
		(window.maestro as unknown as { tabWindows: Record<string, unknown> }).tabWindows.reorder =
			reorder;
		try {
			dispatchTabWindowIntent(intent('reorderTabs', { tabRefs: [FILE, POPPED, TERMINAL] }), h);
			expect(reorder).toHaveBeenCalledWith(AGENT, [FILE, POPPED, TERMINAL]);
		} finally {
			api.restore();
		}
	});

	it('closeTabs: closes the popped tabs it names, never one of the owner own', () => {
		const home: TabWindowTabRef = { type: 'ai', id: 'home' };
		dispatchTabWindowIntent(intent('closeTabs', { tabRefs: [FILE, home, TERMINAL] }), h);
		expect(h.closeTabRefs).toHaveBeenCalledWith(AGENT, [FILE, TERMINAL]);
	});

	// The transcript (table E).
	it('deleteLog and forkConversation: the transcript handlers, on the popped tab', () => {
		dispatchTabWindowIntent(intent('deleteLog', { logId: 'log-3' }), h);
		dispatchTabWindowIntent(intent('forkConversation', { logId: 'log-4' }), h);
		expect(h.deleteLog).toHaveBeenCalledWith('log-3', TARGET);
		expect(h.forkConversation).toHaveBeenCalledWith('log-4', TARGET);
	});

	it("replayMessage: the send path, from the tab window, without this window's composer", () => {
		dispatchTabWindowIntent(intent('replayMessage', { text: 'again', images: ['img'] }), h);
		expect(h.processInput).toHaveBeenCalledWith('again', {
			sessionId: AGENT,
			tabId: 'popped',
			images: ['img'],
			fromTabWindow: {},
		});
	});

	it('cancelShellCommand: stops the run this window started', () => {
		dispatchTabWindowIntent(intent('cancelShellCommand', { logId: 'shell-1' }), h);
		expect(services.cancelShellCommand).toHaveBeenCalledWith('shell-1');
	});

	it('retryNow and cancelRetry: the retry card actions, on the popped tab', () => {
		dispatchTabWindowIntent(intent('retryNow', {}), h);
		dispatchTabWindowIntent(intent('cancelRetry', {}), h);
		expect(services.retryNow).toHaveBeenCalledWith(AGENT, 'popped');
		expect(services.cancelRetry).toHaveBeenCalledWith(AGENT, 'popped');
	});

	it("recoverSession: the recovery card's Send", () => {
		dispatchTabWindowIntent(
			intent('recoverSession', { lastUserPrompt: 'redo', groomContext: true }),
			h
		);
		expect(h.recoverSession).toHaveBeenCalledWith({
			sessionId: AGENT,
			tabId: 'popped',
			lastUserPrompt: 'redo',
			groomContext: true,
		});
	});

	it('loadEarlierTranscript: the owner pages the history in', () => {
		dispatchTabWindowIntent(intent('loadEarlierTranscript', {}), h);
		expect(services.loadEarlierTranscriptForTab).toHaveBeenCalledWith(AGENT, 'popped');
	});

	it('setViewState: keeps the scroll position and feeds the unread rule', () => {
		dispatchTabWindowIntent(
			intent('setViewState', { scrollTop: 120, isAtBottom: true, viewed: true }),
			h
		);
		const tab = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 'popped')!;
		expect(tab.scrollTop).toBe(120);
		expect(tab.isAtBottom).toBe(true);
		expect(isTabViewedInTabWindow(AGENT, 'popped')).toBe(true);

		// Scrolled up (or the window hidden): no longer watched.
		dispatchTabWindowIntent(
			intent('setViewState', { scrollTop: 40, isAtBottom: false, viewed: true }),
			h
		);
		expect(isTabViewedInTabWindow(AGENT, 'popped')).toBe(false);
	});

	it('setViewState: watching the tail clears its unread mark', () => {
		useSessionStore.setState({
			sessions: [
				{
					...agent(),
					aiTabs: agent().aiTabs.map((t) => (t.id === 'popped' ? { ...t, hasUnread: true } : t)),
				},
			],
		});
		dispatchTabWindowIntent(
			intent('setViewState', { scrollTop: 0, isAtBottom: true, viewed: true }),
			h
		);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hasUnread).toBe(false);
	});

	it('codexFollowup: a send runs the send path on the tab; a prefill stays in the tab window', () => {
		dispatchTabWindowIntent(intent('codexFollowup', { prompt: 'next step', mode: 'send' }), h);
		expect(h.processInput).toHaveBeenCalledWith('next step', {
			sessionId: AGENT,
			tabId: 'popped',
			fromTabWindow: {},
		});
		expect(
			dispatchTabWindowIntent(intent('codexFollowup', { prompt: 'x', mode: 'prefill' }), h).handled
		).toBe(false);
	});

	it('openFileLink: shows the agent here, opens the link as the file click does, raises this window', () => {
		dispatchTabWindowIntent(intent('openFileLink', { path: 'src/app.ts' }), h);
		expect(h.showAgent).toHaveBeenCalledWith(AGENT);
		expect(h.openFileLink).toHaveBeenCalledWith('src/app.ts');
		expect(h.raiseWindow).toHaveBeenCalled();
	});

	it('navigate: opens the maestro:// link here and raises this window', () => {
		dispatchTabWindowIntent(intent('navigate', { deepLink: 'maestro://session/agent-2' }), h);
		expect(services.openMaestroLink).toHaveBeenCalledWith('maestro://session/agent-2');
		expect(h.raiseWindow).toHaveBeenCalled();
	});

	it("openUrlInMaestro: opens Maestro's browser for the agent, here", () => {
		dispatchTabWindowIntent(intent('openUrlInMaestro', { url: 'https://example.com' }), h);
		expect(h.showAgent).toHaveBeenCalledWith(AGENT);
		expect(services.openInMaestroBrowser).toHaveBeenCalledWith('https://example.com');
		expect(h.raiseWindow).toHaveBeenCalled();
	});

	it('clearAgentError: the error banner dismiss, on the popped tab', () => {
		dispatchTabWindowIntent(intent('clearAgentError', {}), h);
		expect(h.clearAgentError).toHaveBeenCalledWith(AGENT, 'popped');
	});

	it('coworkingApproval: settles the approval this window holds', () => {
		const resolve = vi.fn();
		useCoworkingApprovalStore.setState({
			queue: [{ id: 'ap-1', agentId: 'a', sessionId: AGENT, title: '', message: '', resolve }],
		});
		dispatchTabWindowIntent(intent('coworkingApproval', { requestId: 'ap-1', approved: true }), h);
		expect(resolve).toHaveBeenCalledWith(true);
	});

	it('requestSnapshot is the patch publisher one: nothing runs here', () => {
		expect(dispatchTabWindowIntent(intent('requestSnapshot', {}), h)).toEqual({ handled: true });
		for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
	});
});

describe('dispatchTabWindowIntent: refusals', () => {
	it('refuses an agent this window does not own (it was moved: its new owner runs it)', () => {
		const outcome = dispatchTabWindowIntent(intent('interrupt', {}), h, () => false);
		expect(outcome).toEqual({ handled: false, reason: 'this window does not own the agent' });
		expect(h.interruptAgent).not.toHaveBeenCalled();
	});

	it('refuses an agent the store no longer holds', () => {
		useSessionStore.setState({ sessions: [] });
		expect(dispatchTabWindowIntent(intent('interrupt', {}), h)).toEqual({
			handled: false,
			reason: 'the agent is gone',
		});
	});

	it('refuses a tab-scoped intent for a tab that is gone', () => {
		const gone: TabWindowTabRef = { type: 'ai', id: 'closed' };
		expect(dispatchTabWindowIntent(intent('setModel', { model: 'x' }, gone), h)).toEqual({
			handled: false,
			reason: 'the tab is gone',
		});
		expect(
			dispatchTabWindowIntent(intent('send', { text: 'hi', commandMode: 'off' }, gone), h).handled
		).toBe(false);
		expect(services.setAiTabModel).not.toHaveBeenCalled();
		expect(h.processInput).not.toHaveBeenCalled();
	});

	it.each([
		'exitWizard',
		'toggleWizardThinking',
		'toggleInputMode',
		'mergeInto',
		'sendToAgent',
	] as const)('refuses %s: an app-window flow a tab window does not offer', (kind) => {
		const payload =
			kind === 'mergeInto'
				? {
						targetSessionId: 'b',
						options: { createNewSession: false, groomContext: false, preserveTimestamps: false },
					}
				: kind === 'sendToAgent'
					? { targetSessionId: 'b', options: { groomContext: false, targetSessionId: 'b' } }
					: {};
		const outcome = dispatchTabWindowIntent(intent(kind, payload as never), h);
		expect(outcome.handled).toBe(false);
		for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
	});

	it('has a case for every intent kind (a new kind fails the type check until it has one)', () => {
		// One well-formed payload per kind; the record makes this list complete too.
		const payloads: Record<TabWindowIntentKind, object> = {
			send: { text: 'hi', commandMode: 'off' },
			runShellCommand: { command: 'ls', request: 'list' },
			setDraft: { inputValue: '', commandMode: 'off', stagedImages: [] },
			setModel: { model: 'm' },
			setEffort: { effort: 'e' },
			setPermissionMode: { mode: 'full' },
			toggleReadOnly: {},
			setThinkingMode: { mode: 'on' },
			toggleSaveToHistory: {},
			toggleEnterToSend: {},
			steerNewest: {},
			interrupt: {},
			stopWizardTurn: {},
			exitWizard: {},
			toggleWizardThinking: {},
			toggleInputMode: {},
			summarizeAndContinue: {},
			cancelSummarize: {},
			cancelMerge: {},
			removeQueuedItem: { itemId: 'q1' },
			toggleQueuedItemPaused: { itemId: 'q1' },
			mergeQueuedItem: { itemId: 'q2' },
			editQueuedItem: { itemId: 'q1', patch: { text: '', images: [], turnSettings: {} } },
			reorderQueuedItem: { fromIndex: 0, toIndex: 1 },
			forceSendQueuedItem: { itemId: 'q1' },
			steerQueuedItem: { itemId: 'q1' },
			stopAutoRun: {},
			focusInOwner: { targetTabRef: { type: 'ai', id: 'home' } },
			closeTab: {},
			renameTab: { name: 'n' },
			autoNameTab: {},
			starTab: { starred: false },
			markUnread: {},
			snoozeTab: { wakeAt: 1 },
			mergeInto: {
				targetSessionId: 'b',
				options: { createNewSession: false, groomContext: false, preserveTimestamps: false },
			},
			sendToAgent: { targetSessionId: 'b', options: { groomContext: false, targetSessionId: 'b' } },
			reorderTabs: { tabRefs: [POPPED] },
			closeTabs: { tabRefs: [FILE] },
			setFileTabState: { fields: { editMode: true } },
			setBrowserTabState: { fields: { url: 'https://x.test' } },
			deleteLog: { logId: 'l' },
			replayMessage: { text: 't' },
			forkConversation: { logId: 'l' },
			cancelShellCommand: { logId: 'l' },
			retryNow: {},
			cancelRetry: {},
			recoverSession: { lastUserPrompt: 'p', groomContext: false },
			loadEarlierTranscript: {},
			setViewState: { scrollTop: 0, isAtBottom: true, viewed: false },
			codexFollowup: { prompt: 'p', mode: 'send' },
			openFileLink: { path: 'a.ts' },
			navigate: { deepLink: 'maestro://session/x' },
			openUrlInMaestro: { url: 'https://x.test' },
			clearAgentError: {},
			coworkingApproval: { requestId: 'r', approved: false },
			requestSnapshot: {},
		};
		const api = installTabWindowsApi();
		(window.maestro as unknown as { tabWindows: Record<string, unknown> }).tabWindows.reorder = vi
			.fn()
			.mockResolvedValue({ reordered: true, windowId: 'tw-1' });
		try {
			expect(Object.keys(payloads).sort()).toEqual([...TAB_WINDOW_INTENT_KINDS].sort());
			for (const kind of TAB_WINDOW_INTENT_KINDS) {
				const outcome = dispatchTabWindowIntent(
					intent(kind, payloads[kind] as never),
					createTabWindowOwnerHandlers()
				);
				if (!outcome.handled) expect(outcome.reason).not.toMatch(/unknown intent/);
			}
		} finally {
			api.restore();
		}
	});
});

describe('dispatchTabWindowIntent: browser tab write-back (D5)', () => {
	const BROWSER: TabWindowTabRef = { type: 'browser', id: 'browser-1' };
	const browserTab = (overrides: Partial<BrowserTab> = {}): BrowserTab => ({
		id: 'browser-1',
		url: 'https://old.test/',
		title: 'Old',
		createdAt: 1,
		partition: `persist:maestro-browser-session-${AGENT}`,
		canGoBack: true,
		canGoForward: true,
		isLoading: true,
		favicon: 'https://old.test/favicon.ico',
		webContentsId: 7,
		...overrides,
	});
	const held = () => useSessionStore.getState().sessions[0].browserTabs?.[0];

	beforeEach(() => {
		useSessionStore.setState({
			sessions: [{ ...agent(), browserTabs: [browserTab()] }],
			activeSessionId: AGENT,
		});
		popOutTabsInStore(AGENT, [POPPED, FILE, TERMINAL, BROWSER]);
	});

	it('writes the page the tab window shows onto the owner copy, with no live guest state', () => {
		const outcome = dispatchTabWindowIntent(
			intent(
				'setBrowserTabState',
				{ fields: { url: 'https://new.test/page', title: 'New page', favicon: null } },
				BROWSER
			),
			h
		);

		expect(outcome).toEqual({ handled: true });
		// The owner has no webview for the tab: its copy is the one a dock reopens.
		expect(held()).toMatchObject({
			url: 'https://new.test/page',
			title: 'New page',
			favicon: null,
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
			webContentsId: undefined,
			remotePage: undefined,
		});
	});

	it('takes the agent visibility toggle, and nothing the tab window does not write back', () => {
		// An incognito tab keeps its own partition (persistence would replace it).
		const incognito = `maestro-ephemeral-${AGENT}-a1b2c3d4`;
		useSessionStore.setState({
			sessions: [
				{ ...agent(), browserTabs: [browserTab({ partition: incognito, ephemeral: true })] },
			],
			activeSessionId: AGENT,
		});
		dispatchTabWindowIntent(
			intent(
				'setBrowserTabState',
				{
					fields: {
						hiddenFromAgent: true,
						customTitle: 'Renamed',
						partition: 'persist:elsewhere',
					} as never,
				},
				BROWSER
			),
			h
		);

		expect(held()).toMatchObject({
			url: 'https://old.test/',
			hiddenFromAgent: true,
			partition: incognito,
			ephemeral: true,
		});
		expect(held()?.customTitle).toBeUndefined();
	});

	it('refuses a write for a docked tab: the owner webview shows it again', () => {
		popOutTabsInStore(AGENT, [POPPED]);
		const outcome = dispatchTabWindowIntent(
			intent('setBrowserTabState', { fields: { url: 'https://late.test/' } }, BROWSER),
			h
		);

		expect(outcome).toEqual({ handled: false, reason: 'the tab is not popped out' });
		expect(held()).toMatchObject({ url: 'https://old.test/', webContentsId: 7 });
	});

	it('refuses a write for a tab the owner no longer holds', () => {
		useSessionStore.setState({ sessions: [agent()], activeSessionId: AGENT });
		const outcome = dispatchTabWindowIntent(
			intent('setBrowserTabState', { fields: { url: 'https://x.test/' } }, BROWSER),
			h
		);
		expect(outcome).toEqual({ handled: false, reason: 'the tab is gone' });
	});
});

describe('startTabWindowIntentDispatcher', () => {
	it('runs every intent main relays, with the handlers current at that moment', () => {
		const api = installTabWindowsApi();
		let current = h;
		const stop = startTabWindowIntentDispatcher(() => current);
		try {
			api.emitIntent(intent('markUnread', {}));
			expect(services.markAiTabUnread).toHaveBeenCalledWith(TARGET);

			current = createTabWindowOwnerHandlers();
			api.emitIntent(intent('interrupt', {}));
			expect(current.interruptAgent).toHaveBeenCalled();
			expect(h.interruptAgent).not.toHaveBeenCalled();
		} finally {
			stop();
			api.restore();
		}
	});

	it('stops listening when stopped', () => {
		const api = installTabWindowsApi();
		const stop = startTabWindowIntentDispatcher(() => h);
		stop();
		api.emitIntent(intent('interrupt', {}));
		expect(h.interruptAgent).not.toHaveBeenCalled();
		api.restore();
	});

	it('honors ownership', () => {
		const api = installTabWindowsApi();
		const stop = startTabWindowIntentDispatcher(
			() => h,
			() => false
		);
		api.emitIntent(intent('interrupt', {}));
		expect(h.interruptAgent).not.toHaveBeenCalled();
		stop();
		api.restore();
	});

	it('reports an owner function that throws, and never throws into the IPC listener', () => {
		const api = installTabWindowsApi();
		const failing = {
			...h,
			performTabClose: vi.fn(() => {
				throw new Error('boom');
			}),
		};
		const stop = startTabWindowIntentDispatcher(() => failing);
		expect(() => api.emitIntent(intent('closeTab', {}))).not.toThrow();
		expect(services.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'boom' }),
			{ extra: { operation: 'tabWindowIntents.closeTab' } }
		);
		stop();
		api.restore();
	});

	it('reports a rejected owner promise', async () => {
		const api = installTabWindowsApi();
		const failing = { ...h, processInput: vi.fn(() => Promise.reject(new Error('spawn failed'))) };
		const stop = startTabWindowIntentDispatcher(() => failing);
		api.emitIntent(intent('send', { text: 'hi', commandMode: 'off' }));
		await Promise.resolve();
		await Promise.resolve();
		expect(services.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'spawn failed' }),
			{ extra: { operation: 'tabWindowIntents.send' } }
		);
		stop();
		api.restore();
	});

	it('is a no-op in the web-desktop build (TW-13)', () => {
		web.value = true;
		const api = installTabWindowsApi();
		const stop = startTabWindowIntentDispatcher(() => h);
		expect(api.onIntent).not.toHaveBeenCalled();
		stop();
		api.restore();
	});
});
