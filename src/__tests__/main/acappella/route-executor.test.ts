/**
 * @file route-executor.test.ts
 *
 * Unit tests for the dispatch executor: building the agent roster out of the
 * persisted sessions, and turning each of the three tab actions into the
 * `remote:*` operations the renderer already implements.
 *
 * The renderer round trip is behind `VoiceRendererBridge`, so a fake bridge
 * drives the whole suite: no Electron window, no store, no timers. The one
 * exception is the bridge's own section, which asserts the exact channel names
 * and argument ORDER - a shifted argument there is invisible at the type level
 * and would silently deliver a response channel into a `force` flag.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => !!win,
}));
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));

import { requestFromRenderer } from '../../../main/web-server/callbacks/remoteRequest';
import {
	buildAgentRoster,
	createRendererVoiceBridge,
	createVoiceRouteExecutor,
	type CommandReceipt,
	type FocusTabResult,
	type NewTabWithPromptResult,
	type VoiceRendererBridge,
} from '../../../main/acappella/dispatch/route-executor';
import { VoiceDispatchError } from '../../../main/acappella/voice-session-service';
import type { VoiceScope } from '../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import type { StoredSession } from '../../../main/stores/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
	return createMockSession(overrides as never) as unknown as StoredSession;
}

/** Two agents: Backend with two tabs, Frontend with one. */
function makeSessions(): StoredSession[] {
	return [
		makeSession({
			id: 'agent-backend',
			name: 'Backend',
			toolType: 'claude-code',
			cwd: '/repo/api',
			activeTabId: 'tab-auth',
			aiTabs: [
				createMockAITab({
					id: 'tab-auth',
					name: 'Auth Refactor',
					createdAt: 1_000,
					logs: [{ id: 'l1', timestamp: 4_000, source: 'stdout', text: 'hi' }] as never,
				}),
				createMockAITab({ id: 'tab-migrations', name: 'DB Migrations', createdAt: 9_000 }),
			],
		}),
		makeSession({
			id: 'agent-frontend',
			name: 'Frontend',
			toolType: 'codex',
			cwd: '/repo/web',
			activeTabId: 'tab-ui',
			aiTabs: [createMockAITab({ id: 'tab-ui', name: 'Sidebar', createdAt: 2_000 })],
		}),
	];
}

type FakeBridge = {
	[K in keyof VoiceRendererBridge]: MockedFunction<VoiceRendererBridge[K]>;
};

function makeBridge(overrides: Partial<FakeBridge> = {}): FakeBridge {
	return {
		selectSession: vi.fn<VoiceRendererBridge['selectSession']>(),
		renameTab: vi.fn<VoiceRendererBridge['renameTab']>(),
		newTab: vi.fn<VoiceRendererBridge['newTab']>(async () => 'tab-created'),
		newTabWithPrompt: vi.fn<VoiceRendererBridge['newTabWithPrompt']>(
			async (): Promise<NewTabWithPromptResult> => ({ success: true, tabId: 'tab-created' })
		),
		executeCommand: vi.fn<VoiceRendererBridge['executeCommand']>(
			async (): Promise<CommandReceipt> => ({ accepted: true })
		),
		focusTab: vi.fn<VoiceRendererBridge['focusTab']>(
			async (_agentSessionId, tabId): Promise<FocusTabResult> => ({
				ok: true,
				tabId,
				action: 'focused',
			})
		),
		...overrides,
	};
}

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'agent-backend' },
		tabAction: 'current',
		prompt: 'refactor the auth middleware',
		confidence: 0.8,
		...overrides,
	};
}

const CONDUCTOR_SCOPE: VoiceScope = { kind: 'conductor' };

/** Bind an executor over a fixed session list. */
function makeExecutor(options: {
	bridge: VoiceRendererBridge;
	sessions?: StoredSession[];
	activeSessionId?: string | null;
}) {
	return createVoiceRouteExecutor({
		bridge: options.bridge,
		getSessions: () => options.sessions ?? makeSessions(),
		getActiveSessionId: () => options.activeSessionId ?? null,
	});
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

describe('buildAgentRoster', () => {
	it('compacts sessions into agents with their AI tabs', () => {
		const roster = buildAgentRoster(makeSessions());

		expect(roster).toHaveLength(2);
		expect(roster[0]).toMatchObject({
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo/api',
		});
		expect(roster[0].tabs.map((tab) => tab.id)).toEqual(['tab-auth', 'tab-migrations']);
		expect(roster[1].tabs[0]).toMatchObject({
			id: 'tab-ui',
			name: 'Sidebar',
			lastActiveAt: 2_000,
			state: 'open',
		});
	});

	it('dates a tab by its last log, not just its creation', () => {
		const [backend] = buildAgentRoster(makeSessions());

		// tab-auth was created at 1000 but last spoke at 4000.
		expect(backend.tabs[0].lastActiveAt).toBe(4_000);
		expect(backend.tabs[1].lastActiveAt).toBe(9_000);
	});

	it('omits hidden consult tabs and reports an unnamed tab as null', () => {
		const roster = buildAgentRoster([
			makeSession({
				id: 'agent-1',
				aiTabs: [
					createMockAITab({ id: 'tab-visible', name: null, createdAt: 1 }),
					createMockAITab({ id: 'tab-consult', name: 'Consult', hidden: true }),
				],
			}),
		]);

		expect(roster[0].tabs).toHaveLength(1);
		expect(roster[0].tabs[0]).toMatchObject({ id: 'tab-visible', name: null, lastActiveAt: 1 });
	});

	it('survives a session with no tabs at all', () => {
		const roster = buildAgentRoster([makeSession({ id: 'agent-1', aiTabs: undefined })]);

		expect(roster[0].tabs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Tab actions
// ---------------------------------------------------------------------------

describe('executeRouteDecision - current', () => {
	let bridge: FakeBridge;

	beforeEach(() => {
		bridge = makeBridge();
	});

	it('focuses the active tab and delivers the prompt', async () => {
		const execute = makeExecutor({ bridge });

		const result = await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });

		expect(bridge.selectSession).toHaveBeenCalledWith('agent-backend', 'tab-auth');
		expect(bridge.executeCommand).toHaveBeenCalledWith(
			'agent-backend',
			'tab-auth',
			'refactor the auth middleware'
		);
		expect(result).toEqual({
			agentSessionId: 'agent-backend',
			agentName: 'Backend',
			tabId: 'tab-auth',
			tabName: 'Auth Refactor',
			action: 'focused',
			promptSent: true,
		});
	});

	it('falls back to the most recently active tab when activeTabId is stale', async () => {
		const sessions = makeSessions();
		sessions[0].activeTabId = 'tab-closed-yesterday';
		const execute = makeExecutor({ bridge, sessions });

		const result = await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });

		expect(result.tabId).toBe('tab-migrations');
		expect(result.action).toBe('focused');
	});

	it('creates a tab when the agent has none, and says so', async () => {
		const sessions = [makeSession({ id: 'agent-backend', name: 'Backend', aiTabs: [] })];
		const execute = makeExecutor({ bridge, sessions });

		const result = await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });

		expect(bridge.newTabWithPrompt).toHaveBeenCalledWith(
			'agent-backend',
			'refactor the auth middleware'
		);
		expect(result).toMatchObject({ tabId: 'tab-created', action: 'created', promptSent: true });
	});

	it('treats a rejected delivery receipt as a dispatch failure', async () => {
		bridge.executeCommand.mockResolvedValue({ accepted: false, reason: 'session-busy' });
		const execute = makeExecutor({ bridge });

		await expect(execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE })).rejects.toThrow(
			VoiceDispatchError
		);
	});
});

describe('executeRouteDecision - new', () => {
	it('opens a tab with the prompt in one operation and names it', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		const result = await execute(makeDecision({ tabAction: 'new', tabName: 'Auth Refactor' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(bridge.newTabWithPrompt).toHaveBeenCalledWith(
			'agent-backend',
			'refactor the auth middleware'
		);
		expect(bridge.renameTab).toHaveBeenCalledWith('agent-backend', 'tab-created', 'Auth Refactor');
		expect(bridge.executeCommand).not.toHaveBeenCalled();
		expect(result).toEqual({
			agentSessionId: 'agent-backend',
			agentName: 'Backend',
			tabId: 'tab-created',
			tabName: 'Auth Refactor',
			action: 'created',
			promptSent: true,
		});
	});

	it('opens an empty tab without dispatching when there is no prompt', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		const result = await execute(makeDecision({ tabAction: 'new', prompt: '   ' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(bridge.newTab).toHaveBeenCalledWith('agent-backend');
		expect(bridge.newTabWithPrompt).not.toHaveBeenCalled();
		expect(result).toMatchObject({ action: 'created', promptSent: false });
	});

	it('fails the dispatch when the renderer does not create the tab', async () => {
		const bridge = makeBridge({
			newTabWithPrompt: vi.fn<VoiceRendererBridge['newTabWithPrompt']>(async () => ({
				success: false,
			})),
		});
		const execute = makeExecutor({ bridge });

		await expect(
			execute(makeDecision({ tabAction: 'new' }), { roster: [], scope: CONDUCTOR_SCOPE })
		).rejects.toThrow(VoiceDispatchError);
	});
});

describe('executeRouteDecision - recall', () => {
	it('returns to the named tab', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		const result = await execute(makeDecision({ tabAction: 'recall', tabId: 'tab-migrations' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		// A REQUEST, not a fire-and-forget send: the renderer is the only side that
		// can tell a focus from a wake from a reopen.
		expect(bridge.focusTab).toHaveBeenCalledWith('agent-backend', 'tab-migrations');
		expect(result).toMatchObject({
			tabId: 'tab-migrations',
			tabName: 'DB Migrations',
			action: 'recalled',
			promptSent: true,
		});
	});

	it('fails rather than guessing when the recalled tab is gone', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		await expect(
			execute(makeDecision({ tabAction: 'recall', tabId: 'tab-closed' }), {
				roster: [],
				scope: CONDUCTOR_SCOPE,
			})
		).rejects.toThrow(/no longer open/);
		expect(bridge.focusTab).not.toHaveBeenCalled();
		expect(bridge.executeCommand).not.toHaveBeenCalled();
	});

	it('fails when a recall arrives with no tab id', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		await expect(
			execute(makeDecision({ tabAction: 'recall' }), { roster: [], scope: CONDUCTOR_SCOPE })
		).rejects.toThrow(VoiceDispatchError);
	});

	it('lands on the tab the renderer actually landed on', async () => {
		// Waking a snooze whose conversation is already open focuses the copy that
		// exists rather than restoring a duplicate.
		const bridge = makeBridge({
			focusTab: vi.fn<VoiceRendererBridge['focusTab']>(async () => ({
				ok: true,
				tabId: 'tab-auth',
				action: 'woke',
			})),
		});
		const execute = makeExecutor({ bridge });

		const result = await execute(makeDecision({ tabAction: 'recall', tabId: 'tab-migrations' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(result.tabId).toBe('tab-auth');
		expect(bridge.executeCommand).toHaveBeenCalledWith(
			'agent-backend',
			'tab-auth',
			'refactor the auth middleware'
		);
	});

	it('fails rather than announcing a recall the renderer did not perform', async () => {
		const bridge = makeBridge({
			focusTab: vi.fn<VoiceRendererBridge['focusTab']>(async () => ({
				ok: false,
				reason: 'renderer-timeout',
			})),
		});
		const execute = makeExecutor({ bridge });

		await expect(
			execute(makeDecision({ tabAction: 'recall', tabId: 'tab-migrations' }), {
				roster: [],
				scope: CONDUCTOR_SCOPE,
			})
		).rejects.toThrow(/renderer-timeout/);
		expect(bridge.executeCommand).not.toHaveBeenCalled();
	});

	it('wakes a snoozed tab rather than treating it as gone', async () => {
		const sessions = makeSessions();
		sessions[0].snoozedTabs = [
			{
				id: 'snooze-1',
				tab: createMockAITab({ id: 'tab-spike', name: 'Rate Limit Spike', createdAt: 5 }),
				unifiedIndex: 0,
				snoozedAt: 1,
				wakeAt: 999_999,
			},
		];
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, sessions });

		const result = await execute(makeDecision({ tabAction: 'recall', tabId: 'tab-spike' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(bridge.focusTab).toHaveBeenCalledWith('agent-backend', 'tab-spike');
		expect(result.action).toBe('recalled');
	});
});

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

describe('executeRouteDecision - current', () => {
	it('never treats a snoozed or closed tab as the current one', async () => {
		// The roster lists them so recall can name them. "Carry on where we were"
		// landing on a tab the user put away last week would be the worst possible
		// reading of "current".
		const sessions = [
			makeSession({
				id: 'agent-backend',
				name: 'Backend',
				activeTabId: null,
				aiTabs: [createMockAITab({ id: 'tab-open', name: 'Open', createdAt: 1 })],
				snoozedTabs: [
					{
						id: 'snooze-1',
						tab: createMockAITab({ id: 'tab-snoozed', name: 'Snoozed', createdAt: 9_000 }),
						unifiedIndex: 0,
						snoozedAt: 1,
						wakeAt: 999_999,
					},
				],
			}),
		];
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, sessions });

		const result = await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });

		expect(result.tabId).toBe('tab-open');
	});
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('executeRouteDecision - idempotency', () => {
	it('replays an identical decision instead of opening a second tab', async () => {
		const bridge = makeBridge();
		const execute = createVoiceRouteExecutor({
			bridge,
			getSessions: () => makeSessions(),
			getActiveSessionId: () => null,
		});
		const decision = makeDecision({ tabAction: 'new', tabName: 'Auth Refactor' });

		const first = await execute(decision, { roster: [], scope: CONDUCTOR_SCOPE });
		const second = await execute(decision, { roster: [], scope: CONDUCTOR_SCOPE });

		expect(bridge.newTabWithPrompt).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it('treats a different prompt to the same tab as a new dispatch', async () => {
		const bridge = makeBridge();
		const execute = createVoiceRouteExecutor({
			bridge,
			getSessions: () => makeSessions(),
			getActiveSessionId: () => null,
		});

		await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });
		await execute(makeDecision({ prompt: 'and run the linter' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(bridge.executeCommand).toHaveBeenCalledTimes(2);
	});

	it('lets the replay window expire, because a repeat later is intent', async () => {
		const bridge = makeBridge();
		const execute = createVoiceRouteExecutor({
			bridge,
			getSessions: () => makeSessions(),
			getActiveSessionId: () => null,
			replayWindowMs: 0,
		});

		await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });
		await execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE });

		expect(bridge.executeCommand).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Clarifications
// ---------------------------------------------------------------------------

describe('executeRouteDecision - clarifications', () => {
	it('refuses to dispatch a question', async () => {
		// Reaching the executor with one means a caller skipped the guard, and
		// dispatching it would send the user their own half-finished request.
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		await expect(
			execute(makeDecision({ clarify: 'Backend or Frontend?' }), {
				roster: [],
				scope: CONDUCTOR_SCOPE,
			})
		).rejects.toThrow(/question, not a dispatch/);
		expect(bridge.executeCommand).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

describe('executeRouteDecision - target resolution', () => {
	it('fails when the targeted agent closed while the decision was in flight', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, sessions: [] });

		await expect(execute(makeDecision(), { roster: [], scope: CONDUCTOR_SCOPE })).rejects.toThrow(
			/no longer running/
		);
	});

	it('sends a conductor decision to the session scope agent', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, activeSessionId: 'agent-backend' });

		const result = await execute(makeDecision({ target: 'conductor' }), {
			roster: [],
			scope: { kind: 'agent', sessionId: 'agent-frontend' },
		});

		// The bound scope outranks whichever agent the desktop happens to show.
		expect(result.agentSessionId).toBe('agent-frontend');
	});

	it('falls back to the active desktop agent for an unscoped conductor decision', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, activeSessionId: 'agent-frontend' });

		const result = await execute(makeDecision({ target: 'conductor' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(result.agentSessionId).toBe('agent-frontend');
	});

	it('uses the only agent there is', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, sessions: [makeSessions()[1]] });

		const result = await execute(makeDecision({ target: 'conductor' }), {
			roster: [],
			scope: CONDUCTOR_SCOPE,
		});

		expect(result.agentSessionId).toBe('agent-frontend');
	});

	it('refuses to guess between several agents with nothing active', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge });

		await expect(
			execute(makeDecision({ target: 'conductor' }), { roster: [], scope: CONDUCTOR_SCOPE })
		).rejects.toThrow(VoiceDispatchError);
		expect(bridge.executeCommand).not.toHaveBeenCalled();
	});

	it('reports having no agents at all distinctly', async () => {
		const bridge = makeBridge();
		const execute = makeExecutor({ bridge, sessions: [] });

		await expect(
			execute(makeDecision({ target: 'conductor' }), { roster: [], scope: CONDUCTOR_SCOPE })
		).rejects.toThrow(/No agents are open/);
	});
});

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------

describe('createRendererVoiceBridge', () => {
	const send = vi.fn();
	const show = vi.fn();
	const win = {
		webContents: { send },
		isMinimized: () => false,
		restore: vi.fn(),
		show,
	} as never;

	beforeEach(() => {
		send.mockClear();
		vi.mocked(requestFromRenderer).mockReset();
	});

	it('focuses and renames over the existing remote channels', () => {
		const bridge = createRendererVoiceBridge(() => win);

		bridge.selectSession('agent-1', 'tab-1');
		bridge.renameTab('agent-1', 'tab-1', 'Auth Refactor');

		expect(send).toHaveBeenNthCalledWith(1, 'remote:selectSession', 'agent-1', 'tab-1');
		expect(send).toHaveBeenNthCalledWith(
			2,
			'remote:renameTab',
			'agent-1',
			'tab-1',
			'Auth Refactor'
		);
	});

	it('creates a tab with a prompt atomically, leaving room for the response channel', async () => {
		vi.mocked(requestFromRenderer).mockResolvedValue({ success: true, tabId: 'tab-9' });
		const bridge = createRendererVoiceBridge(() => win);

		const result = await bridge.newTabWithPrompt('agent-1', 'do the thing');

		expect(result).toEqual({ success: true, tabId: 'tab-9' });
		const [, channel, options] = vi.mocked(requestFromRenderer).mock.calls[0];
		expect(channel).toBe('remote:newAITabWithPrompt');
		// `background` is deliberately omitted so the response channel lands in
		// its slot AND the new tab takes focus.
		expect(options.args).toEqual(['agent-1', 'do the thing']);
	});

	it('sends a prompt with the full positional argument list', async () => {
		vi.mocked(requestFromRenderer).mockResolvedValue({ accepted: true });
		const bridge = createRendererVoiceBridge(() => win);

		await bridge.executeCommand('agent-1', 'tab-1', 'do the thing');

		const [, channel, options] = vi.mocked(requestFromRenderer).mock.calls[0];
		expect(channel).toBe('remote:executeCommand');
		expect(options.args).toEqual([
			'agent-1',
			'do the thing',
			'ai',
			'tab-1',
			false,
			undefined,
			false,
		]);
	});

	it('reads the tab id out of a new-tab reply', async () => {
		vi.mocked(requestFromRenderer).mockResolvedValue({ tabId: 'tab-3' });
		const bridge = createRendererVoiceBridge(() => win);

		await expect(bridge.newTab('agent-1')).resolves.toBe('tab-3');
	});

	it('classifies a missing renderer as a dispatch failure', () => {
		const bridge = createRendererVoiceBridge(() => null);

		expect(() => bridge.selectSession('agent-1')).toThrow(VoiceDispatchError);
	});

	it('asks the renderer to focus a tab and reads back what that took', async () => {
		vi.mocked(requestFromRenderer).mockResolvedValue({
			ok: true,
			tabId: 'tab-1',
			action: 'woke',
		});
		const bridge = createRendererVoiceBridge(() => win);

		const result = await bridge.focusTab('agent-1', 'tab-1');

		const [, channel, options] = vi.mocked(requestFromRenderer).mock.calls[0];
		expect(channel).toBe('remote:focusAiTab');
		expect(options.args).toEqual(['agent-1', 'tab-1']);
		expect(result).toEqual({ ok: true, tabId: 'tab-1', action: 'woke' });
	});

	it('treats a malformed focus reply as a failure rather than a success', async () => {
		vi.mocked(requestFromRenderer).mockResolvedValue({ ok: true });
		const bridge = createRendererVoiceBridge(() => win);

		await bridge.focusTab('agent-1', 'tab-1');

		// The parser runs inside `requestFromRenderer`, which is mocked here, so it
		// is exercised directly: a truthy-looking reply must not become an `ok`.
		const [, , options] = vi.mocked(requestFromRenderer).mock.calls[0];
		expect(options.parse!({ ok: 'yes' })).toMatchObject({ ok: false });
		expect(options.parse!('sure')).toMatchObject({ ok: false, reason: 'malformed-result' });
		expect(options.fallback).toMatchObject({ ok: false, reason: 'renderer-timeout' });
	});

	// -- Multi-window --------------------------------------------------------

	describe('multi-window', () => {
		function makeWindow(label: string) {
			return {
				label,
				webContents: { send: vi.fn() },
				isMinimized: () => false,
				restore: vi.fn(),
				show: vi.fn(),
			};
		}

		it('dispatches into the window that owns the agent, not whichever is main', () => {
			// Agent ownership is per window while `activeSessionId` is global, so
			// dispatching to "main" would activate an agent that window does not own.
			const main = makeWindow('main');
			const secondary = makeWindow('secondary');
			const bridge = createRendererVoiceBridge(
				() => main as never,
				(sessionId) => (sessionId === 'agent-2' ? (secondary as never) : null)
			);

			bridge.selectSession('agent-2', 'tab-1');

			expect(secondary.webContents.send).toHaveBeenCalledWith(
				'remote:selectSession',
				'agent-2',
				'tab-1'
			);
			expect(main.webContents.send).not.toHaveBeenCalled();
		});

		it('raises the owning window: a dispatch behind another window did nothing', () => {
			const secondary = makeWindow('secondary');
			secondary.isMinimized = () => true;
			const bridge = createRendererVoiceBridge(
				() => null,
				() => secondary as never
			);

			bridge.selectSession('agent-2', 'tab-1');

			expect(secondary.restore).toHaveBeenCalled();
			expect(secondary.show).toHaveBeenCalled();
		});

		it('falls back to the main window when no window claims the agent', () => {
			const main = makeWindow('main');
			const bridge = createRendererVoiceBridge(
				() => main as never,
				() => null
			);

			bridge.selectSession('agent-2', 'tab-1');

			expect(main.webContents.send).toHaveBeenCalled();
		});
	});
});
