/**
 * @file quickChatRouter.test.ts
 * @description The side-effecting half of Quick Chat routing: gathering the
 * candidates (open tabs, and closed conversations from History), the model call
 * for a close call and what happens when it gives no answer, and reopening a
 * closed conversation as a background tab. The decision itself is tested in
 * quickChatRouting.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockAITab, createMockSession, resetStores } from '../../helpers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	ROUTE_MODEL_TIMEOUT_MS,
	reopenClosedConversation,
	resetQuickChatRouterForTests,
	routeQuickChatMessage,
	type RouteContext,
} from '../../../renderer/services/quickChatRouter';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import type { NativeSessionBinding } from '../../../shared/maestro-lib/agents/providerSwap';
import { SessionResumeRefusedError } from '../../../renderer/services/resumableSession';

vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));
import { captureException } from '../../../renderer/utils/sentry';

const getAllPaginated = vi.fn();
const groomContext = vi.fn();

const said = (text: string): LogEntry => ({ id: text, timestamp: 1, source: 'user', text });

function tab(id: string, patch: Partial<AITab> = {}): AITab {
	return createMockAITab({ id, ...patch });
}

function agentWith(aiTabs: AITab[], patch: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 'agent',
		aiTabs,
		activeTabId: aiTabs[0]?.id ?? '',
		unifiedTabOrder: aiTabs.map((t) => ({ type: 'ai' as const, id: t.id })),
		...patch,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const amazonTab = () =>
	tab('amazon', { name: 'Amazon Delivery', logs: [said('where is my amazon package')] });
const buildTab = () =>
	tab('build', { name: 'CI Build', logs: [said('why does the windows build fail')] });

const nativeBinding = {
	version: 1,
	state: 'bound',
	provider: 'grok',
	nativeSessionId: 's-tax',
	accountRef: 'fixture-account-a',
	host: { kind: 'local', identity: 'fixture-host-a' },
	cwd: '/test/project',
} as const satisfies NativeSessionBinding;

const noChat: RouteContext = { currentTabId: null, ownedTabIds: new Set() };

/** One USER history entry of a past conversation. */
function entry(agentSessionId: string | undefined, summary: string, patch = {}) {
	return {
		id: `${agentSessionId}-${summary}`,
		type: 'USER',
		timestamp: 1000,
		summary,
		agentSessionId,
		projectPath: '/test/project',
		...patch,
	};
}

function history(entries: unknown[]) {
	getAllPaginated.mockResolvedValue({ entries, total: entries.length, hasMore: false });
}

beforeEach(() => {
	resetStores(useSessionStore, useSettingsStore);
	resetQuickChatRouterForTests();
	vi.mocked(captureException).mockClear();
	getAllPaginated.mockReset();
	groomContext.mockReset();
	history([]);
	(window.maestro as unknown as { history: unknown }).history = { getAllPaginated };
	(window.maestro as unknown as { context: unknown }).context = { groomContext };
	vi.mocked(window.maestro.prompts.get).mockResolvedValue({
		success: true,
		content: '{{CONVERSATIONS}}\n---\n{{MESSAGE}}',
	});
});

describe('routeQuickChatMessage', () => {
	it('invalidates History cache when the same agent changes provider or native slot', async () => {
		const session = agentWith([buildTab()]);
		await routeQuickChatMessage(session, 'one', noChat);
		await routeQuickChatMessage(
			{ ...session, aiTabs: [{ ...session.aiTabs[0], tabProvider: 'codex' }] },
			'two',
			noChat
		);
		await routeQuickChatMessage({ ...session, toolType: 'codex' }, 'three', noChat);
		expect(getAllPaginated).toHaveBeenCalledTimes(3);
	});
	it('uses the kept tab provider configuration for ambiguous model routing', async () => {
		groomContext.mockResolvedValue('1');
		const session = agentWith(
			[
				tab('delivery', {
					name: 'Amazon Delivery',
					logs: [said('amazon package')],
					tabProvider: 'codex',
				}),
				tab('returns', { name: 'Amazon Returns', logs: [said('amazon package')] }),
			],
			{
				customPath: '/claude',
				providerOverrides: {
					codex: { customPath: '/codex', customEnvVars: { CODEX_HOME: '/account' } },
				},
			}
		);
		await routeQuickChatMessage(session, 'amazon package', {
			currentTabId: 'delivery',
			ownedTabIds: new Set(),
		});
		expect(groomContext).toHaveBeenCalledWith(
			'/test/project',
			'codex',
			expect.any(String),
			expect.objectContaining({ customPath: '/codex', customEnvVars: { CODEX_HOME: '/account' } })
		);
	});
	it('keeps new-chat model routing on the agent default', async () => {
		groomContext.mockResolvedValue('new');
		const session = agentWith([
			tab('delivery', {
				name: 'Amazon Delivery',
				logs: [said('amazon package')],
				tabProvider: 'codex',
			}),
			tab('returns', { name: 'Amazon Returns', logs: [said('amazon package')] }),
		]);
		await routeQuickChatMessage(session, 'amazon package', noChat);
		expect(groomContext).toHaveBeenCalledWith(
			'/test/project',
			'claude-code',
			expect.any(String),
			expect.any(Object)
		);
	});
	it('routes to the open tab that clearly matches, without a model call', async () => {
		const session = agentWith([buildTab(), amazonTab()]);
		expect(await routeQuickChatMessage(session, 'any news on my amazon package?', noChat)).toEqual({
			kind: 'open',
			tabId: 'amazon',
		});
		expect(groomContext).not.toHaveBeenCalled();
	});

	it('starts a new tab when nothing resembles the message', async () => {
		const session = agentWith([buildTab(), amazonTab()]);
		expect(await routeQuickChatMessage(session, 'how do I center a div in CSS?', noChat)).toEqual({
			kind: 'new',
		});
		expect(groomContext).not.toHaveBeenCalled();
	});

	it('leaves out hidden tabs, except the ones the chat created', async () => {
		const hidden = tab('consult', { hidden: true, logs: [said('amazon package refund policy')] });
		const session = agentWith([buildTab(), hidden]);
		expect(await routeQuickChatMessage(session, 'amazon package refund', noChat)).toEqual({
			kind: 'new',
		});
		expect(
			await routeQuickChatMessage(session, 'amazon package refund', {
				currentTabId: null,
				ownedTabIds: new Set(['consult']),
			})
		).toEqual({ kind: 'open', tabId: 'consult' });
	});

	it('leaves out a busy tab, except the chat own, and never reopens its conversation', async () => {
		history([entry('s-amazon', 'Tracked the amazon package refund')]);
		const busy = tab('amazon', {
			state: 'busy',
			agentSessionId: 's-amazon',
			logs: [said('amazon package refund policy')],
		});
		const session = agentWith([buildTab(), busy]);
		expect(await routeQuickChatMessage(session, 'amazon package refund', noChat)).toEqual({
			kind: 'new',
		});
		expect(
			await routeQuickChatMessage(session, 'amazon package refund', {
				currentTabId: 'amazon',
				ownedTabIds: new Set(),
			})
		).toEqual({ kind: 'open', tabId: 'amazon' });
		expect(
			await routeQuickChatMessage(session, 'amazon package refund', {
				currentTabId: null,
				ownedTabIds: new Set(['amazon']),
			})
		).toEqual({ kind: 'open', tabId: 'amazon' });
	});

	it('leaves out a tab running an inline wizard', async () => {
		const wizard = tab('wizard', {
			logs: [said('amazon package refund policy')],
			wizardState: { isActive: true } as AITab['wizardState'],
		});
		const session = agentWith([buildTab(), wizard]);
		expect(await routeQuickChatMessage(session, 'amazon package refund', noChat)).toEqual({
			kind: 'new',
		});
	});

	it('offers conversations closed in the last two weeks, read from History', async () => {
		history([
			entry('s-tax', 'Explained the home office deduction', { sessionName: 'Tax Questions' }),
			entry('s-tax', 'Worked out quarterly estimated payments', { timestamp: 500 }),
			entry('s-other', 'Renamed the parser module'),
			entry(undefined, 'An entry with no provider session'),
		]);
		const session = agentWith([buildTab()]);

		expect(await routeQuickChatMessage(session, 'home office deduction limits?', noChat)).toEqual({
			kind: 'closed',
			provider: 'claude-code',
			agentSessionId: 's-tax',
			name: 'Tax Questions',
		});
		expect(getAllPaginated).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'agent',
				lookbackHours: 14 * 24,
				// Auto Run and Cue runs are not conversations the user was having.
				types: ['USER'],
			})
		);
	});

	it('reaches a conversation through its tab when it still has one, never beside it', async () => {
		history([entry('s-amazon', 'Tracked the amazon package to the porch')]);
		const session = agentWith([
			buildTab(),
			tab('amazon', { agentSessionId: 's-amazon', logs: [said('where is my amazon package')] }),
		]);
		expect(await routeQuickChatMessage(session, 'amazon package again', noChat)).toEqual({
			kind: 'open',
			tabId: 'amazon',
		});
	});

	it("does not treat a recorded session-id label as the conversation's name", async () => {
		history([
			entry('0a1b2c3d-1111-2222-3333-444455556666', 'Explained the home office deduction', {
				sessionName: '0A1B2C3D',
			}),
		]);
		const session = agentWith([buildTab()]);
		expect(await routeQuickChatMessage(session, 'home office deduction', noChat)).toMatchObject({
			kind: 'closed',
			name: null,
		});
	});

	it('reads History once for sends made back to back', async () => {
		const session = agentWith([buildTab()]);
		await routeQuickChatMessage(session, 'one', noChat);
		await routeQuickChatMessage(session, 'two', noChat);
		expect(getAllPaginated).toHaveBeenCalledTimes(1);
	});

	it('still routes among open tabs when History cannot be read, and reports it', async () => {
		getAllPaginated.mockRejectedValue(new Error('disk'));
		const session = agentWith([buildTab(), amazonTab()]);
		expect(await routeQuickChatMessage(session, 'amazon package status', noChat)).toEqual({
			kind: 'open',
			tabId: 'amazon',
		});
		expect(captureException).toHaveBeenCalled();
	});

	it.each([
		{ ownerAgentId: 'other', nativeSessionBinding: nativeBinding },
		{ ownerAgentId: 'agent', nativeSessionBinding: { ...nativeBinding, accountRef: 'account-b' } },
		{
			ownerAgentId: 'agent',
			nativeSessionBinding: { ...nativeBinding, host: { kind: 'ssh', identity: 'host-b' } },
		},
		{ ownerAgentId: 'agent', nativeSessionBinding: undefined },
	])('keeps a closed ID collision separate from live scoped history: %j', async (scope) => {
		history([
			entry('s-tax', 'parser grammar compiler', {
				sessionId: 'agent',
				nativeSessionBinding: nativeBinding,
			}),
			entry('s-tax', 'home office deduction', {
				sessionId: scope.ownerAgentId,
				nativeSessionBinding: scope.nativeSessionBinding,
			}),
		]);
		const session = agentWith(
			[tab('live', { hidden: true, agentSessionId: 's-tax', nativeSessionBinding: nativeBinding })],
			{ toolType: 'grok' }
		);
		const target = await routeQuickChatMessage(session, 'home office deduction', noChat);
		expect(target).toEqual({ kind: 'closed', agentSessionId: 's-tax', name: null, ...scope });
		if (target.kind === 'closed' && target.nativeSessionBinding) {
			expect(target.nativeSessionBinding).not.toBe(scope.nativeSessionBinding);
		}
		expect(groomContext).not.toHaveBeenCalled();
	});

	it.each<Partial<Session>>([
		{ toolType: 'codex' },
		{ customEnvVars: { GROK_HOME: '/fixture/account-b' } },
		{ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } },
	])('invalidates cached candidates after selection changes: %j', async (patch) => {
		const session = agentWith([], { toolType: 'grok' });
		history([
			entry('s-tax', 'home office deduction', {
				sessionId: 'agent',
				nativeSessionBinding: nativeBinding,
			}),
		]);
		await routeQuickChatMessage(session, 'home office deduction', noChat);
		history([]);
		expect(
			await routeQuickChatMessage({ ...session, ...patch }, 'home office deduction', noChat)
		).toEqual({ kind: 'new' });
		expect(getAllPaginated).toHaveBeenCalledTimes(2);
	});

	describe('a close call', () => {
		const inAmazonChat: RouteContext = { currentTabId: 'amazon', ownedTabIds: new Set() };

		it('asks a cheap, tool-less model with a deadline', async () => {
			groomContext.mockResolvedValue('1');
			const session = agentWith([buildTab(), amazonTab()]);
			await routeQuickChatMessage(session, 'and when does it arrive?', inAmazonChat);

			const [projectRoot, agentType, prompt, options] = groomContext.mock.calls[0];
			expect(projectRoot).toBe('/test/project');
			expect(agentType).toBe('claude-code');
			expect(prompt).toContain('<conversation number="1" facts="CURRENT, open tab');
			expect(prompt).toContain('<title>Amazon Delivery</title>');
			expect(prompt).toContain('and when does it arrive?');
			expect(options).toMatchObject({
				cheapTurn: true,
				readOnly: true,
				disableTools: true,
				timeoutMs: ROUTE_MODEL_TIMEOUT_MS,
			});
		});

		it('follows the model to the conversation it names', async () => {
			groomContext.mockResolvedValue('1');
			const session = agentWith([buildTab(), amazonTab()]);
			expect(
				await routeQuickChatMessage(session, 'and when does it arrive?', inAmazonChat)
			).toEqual({ kind: 'open', tabId: 'amazon' });
		});

		it('starts a new tab when the model says the message is a new subject', async () => {
			groomContext.mockResolvedValue('NEW');
			const session = agentWith([buildTab(), amazonTab()]);
			expect(
				await routeQuickChatMessage(session, 'how do I center a div in CSS?', inAmazonChat)
			).toEqual({ kind: 'new' });
		});

		it('stays in the conversation in progress when the model gives no answer', async () => {
			groomContext.mockRejectedValue(new Error('Grooming timed out with no response'));
			const session = agentWith([buildTab(), amazonTab()]);
			expect(
				await routeQuickChatMessage(session, 'and when does it arrive?', inAmazonChat)
			).toEqual({ kind: 'open', tabId: 'amazon' });
			// An unavailable model is an ordinary outcome, not a crash report.
			expect(captureException).not.toHaveBeenCalled();
		});

		it('stays in the conversation in progress when the answer is not one it was offered', async () => {
			groomContext.mockResolvedValue('Conversation 7, I think');
			const session = agentWith([buildTab(), amazonTab()]);
			expect(
				await routeQuickChatMessage(session, 'and when does it arrive?', inAmazonChat)
			).toEqual({ kind: 'open', tabId: 'amazon' });
		});

		it('starts a new tab when the model gives no answer and no chat is in progress', async () => {
			groomContext.mockRejectedValue(new Error('unavailable'));
			const other = tab('returns', { name: 'Amazon Returns', logs: [said('amazon package')] });
			const session = agentWith([amazonTab(), other]);
			expect(await routeQuickChatMessage(session, 'amazon package', noChat)).toEqual({
				kind: 'new',
			});
		});

		it('starts a new tab when the routing prompt cannot be loaded', async () => {
			vi.mocked(window.maestro.prompts.get).mockResolvedValue({ success: false });
			const other = tab('returns', { name: 'Amazon Returns', logs: [said('amazon package')] });
			const session = agentWith([amazonTab(), other]);
			expect(await routeQuickChatMessage(session, 'amazon package', noChat)).toEqual({
				kind: 'new',
			});
			expect(groomContext).not.toHaveBeenCalled();
		});
	});
});

describe('reopenClosedConversation', () => {
	it('reads and deduplicates a deferred History conversation without native translation', async () => {
		const session = agentWith([], {
			toolType: 'codex',
			projectRoot: '/test/project',
			providerTranslationTabInventory: [
				{
					id: 'history:closed-source',
					agentSessionId: null,
					providerSessions: { 'claude-code': { agentSessionId: 'closed-source' } },
				},
			],
		});
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [{ type: 'user', content: 'preserved' }],
		} as any);
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});
		const id = await reopenClosedConversation(session.id, {
			agentSessionId: 'closed-source',
			name: 'Past conversation',
		});
		expect(id).toBeTruthy();
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/test/project',
			'closed-source',
			expect.any(Object),
			undefined
		);
		expect(useSessionStore.getState().sessions[0].aiTabs[0]).toMatchObject({
			agentSessionId: 'closed-source',
			tabProvider: 'claude-code',
			providerSessions: {},
		});
		expect(
			await reopenClosedConversation(session.id, { agentSessionId: 'closed-source', name: null })
		).toBe(id);
		expect(useSessionStore.getState().sessions[0].aiTabs).toHaveLength(1);
	});
	const transcript = {
		messages: [
			{
				type: 'user',
				content: 'what can I deduct?',
				timestamp: '2026-10-01T00:00:00Z',
				uuid: 'u1',
			},
			{
				type: 'assistant',
				content: 'The home office.',
				timestamp: '2026-10-01T00:00:01Z',
				uuid: 'a1',
			},
		],
		total: 2,
		hasMore: false,
	};

	beforeEach(() => {
		useSettingsStore.setState({ defaultSaveToHistory: true });
		vi.mocked(window.maestro.agentSessions.read).mockReset().mockResolvedValue(transcript);
	});

	it.each([false, true])(
		'deduplicates pinned native conversations including closed busy tabs (orphan=%s)',
		async (orphan) => {
			const target = tab('codex', {
				tabProvider: 'codex',
				agentSessionId: 'native',
				state: orphan ? 'busy' : 'idle',
			});
			agentWith(orphan ? [buildTab()] : [target], {
				orphanedThinkingTabs: orphan ? [target] : undefined,
			});
			expect(
				await reopenClosedConversation('agent', {
					provider: 'codex',
					agentSessionId: 'native',
					name: null,
				})
			).toBe(orphan ? null : 'codex');
			expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
				'codex',
				'/test/project',
				'native',
				expect.any(Object),
				undefined
			);
		}
	);
	it('preserves the explicit native owner through an awaited read and default change', async () => {
		const session = agentWith([buildTab()]);
		vi.mocked(window.maestro.agentSessions.read).mockImplementationOnce(async () => {
			useSessionStore.setState({ sessions: [{ ...session, toolType: 'opencode' }] });
			return transcript;
		});
		const id = await reopenClosedConversation('agent', {
			provider: 'codex',
			agentSessionId: 'native',
			name: 'Kept',
		});
		const reopened = useSessionStore.getState().sessions[0].aiTabs.find((tab) => tab.id === id);
		expect(reopened).toMatchObject({ tabProvider: 'codex', agentSessionId: 'native' });
		expect(reopened?.providerSessions?.codex).toBeUndefined();
	});
	describe('verified Grok reopen', () => {
		const conversation = {
			agentSessionId: 's-tax',
			name: 'Tax Questions',
			ownerAgentId: 'agent',
			nativeSessionBinding: nativeBinding,
		};
		const receipt = {
			...transcript,
			source: { provider: 'grok' as const, status: 'available' as const },
			nativeSessionBinding: nativeBinding,
		};

		beforeEach(() => {
			agentWith([buildTab()], { toolType: 'grok' });
			vi.mocked(window.maestro.agentSessions.read).mockResolvedValue(receipt);
		});

		it('forwards the recorded owner and immutable binding and persists verified ownership', async () => {
			const collision = tab('collision', {
				agentSessionId: 's-tax',
				nativeSessionBinding: { ...nativeBinding, accountRef: 'account-b' },
				logs: [said('retained history')],
			});
			useSessionStore.getState().updateSession('agent', { aiTabs: [buildTab(), collision] });
			const onCreated = vi.fn();
			const id = await reopenClosedConversation('agent', conversation, () => true, onCreated);
			expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
				'grok',
				'/test/project',
				's-tax',
				expect.objectContaining({ ownerAgentId: 'agent', nativeSessionBinding: nativeBinding }),
				undefined
			);
			const options = vi.mocked(window.maestro.agentSessions.read).mock.calls[0][3];
			expect(options?.nativeSessionBinding).not.toBe(nativeBinding);
			expect(useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === id)).toMatchObject({
				agentSessionId: 's-tax',
				nativeSessionBinding: nativeBinding,
				logs: [
					expect.objectContaining({ text: 'what can I deduct?' }),
					expect.objectContaining({ text: 'The home office.' }),
				],
			});
			expect(useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 'collision')).toBe(
				collision
			);
			expect(id).not.toBe('collision');
			expect(onCreated).toHaveBeenCalledExactlyOnceWith(id);
			expect(useSessionStore.getState().sessions[0].activeTabId).toBe('build');
		});

		it.each([
			{ ...receipt, source: undefined },
			{ ...receipt, source: { provider: 'grok' as const, status: 'partial' as const } },
			{ ...receipt, nativeSessionBinding: { ...nativeBinding, accountRef: 'account-b' } },
			{
				...receipt,
				nativeSessionBinding: {
					...nativeBinding,
					host: { kind: 'ssh' as const, identity: 'host-b' },
				},
			},
			{ ...receipt, messages: [], total: 0 },
		])(
			'refuses unverified or empty receipts without replacing retained tabs: %j',
			async (result) => {
				vi.mocked(window.maestro.agentSessions.read).mockResolvedValue(result);
				const before = useSessionStore.getState().sessions[0];
				const created = vi.fn();
				await expect(
					reopenClosedConversation('agent', conversation, () => true, created)
				).rejects.toBeInstanceOf(SessionResumeRefusedError);
				expect(useSessionStore.getState().sessions[0]).toBe(before);
				expect(created).not.toHaveBeenCalled();
			}
		);

		it.each([
			{ ...conversation, ownerAgentId: undefined },
			{ ...conversation, ownerAgentId: 'other' },
			{ ...conversation, nativeSessionBinding: undefined },
		])('refuses missing or foreign ownership before reading: %j', async (selected) => {
			const before = useSessionStore.getState().sessions[0];
			await expect(reopenClosedConversation('agent', selected)).rejects.toBeInstanceOf(
				SessionResumeRefusedError
			);
			expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0]).toBe(before);
		});

		it.each<Partial<Session>>([
			{ toolType: 'codex' },
			{ customEnvVars: { GROK_HOME: '/fixture/account-b' } },
			{ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } },
		])('rejects selection changes while the native read is pending: %j', async (patch) => {
			let resolve!: (value: typeof receipt) => void;
			const pending = new Promise<typeof receipt>((done) => {
				resolve = done;
			});
			vi.mocked(window.maestro.agentSessions.read).mockReturnValue(pending);
			const reopening = reopenClosedConversation('agent', conversation);
			useSessionStore.getState().updateSession('agent', patch);
			const changed = useSessionStore.getState().sessions[0];
			resolve(receipt);
			await expect(reopening).rejects.toBeInstanceOf(SessionResumeRefusedError);
			expect(useSessionStore.getState().sessions[0]).toBe(changed);
		});

		it.each<NativeSessionBinding | undefined>([
			undefined,
			{ version: 1, state: 'unknown', reason: 'legacy' },
		])(
			'routes unknown history to an honest refusal, preserving its live ID collision: %j',
			async (binding) => {
				const retained = tab('retained', {
					hidden: true,
					agentSessionId: 's-tax',
					nativeSessionBinding: nativeBinding,
					logs: [said('retained history')],
				});
				const session = agentWith([buildTab(), retained], { toolType: 'grok' });
				history([
					entry('s-tax', 'home office deduction', {
						sessionId: 'agent',
						nativeSessionBinding: binding,
					}),
				]);
				const target = await routeQuickChatMessage(session, 'home office deduction', noChat);
				expect(target).toMatchObject({ kind: 'closed', agentSessionId: 's-tax' });
				if (target.kind !== 'closed') throw new Error('Expected retained history candidate');
				const created = vi.fn();
				await expect(
					reopenClosedConversation('agent', target, () => true, created)
				).rejects.toBeInstanceOf(SessionResumeRefusedError);
				expect(useSessionStore.getState().sessions[0]).toBe(session);
				expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
				expect(created).not.toHaveBeenCalled();
			}
		);

		it.each<Partial<Session>>([
			{ toolType: 'codex' },
			{ customEnvVars: { GROK_HOME: '/fixture/account-b' } },
			{ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } },
		])('checks selection on fresh updater entry: %j', async (patch) => {
			const { setSessions, sessions } = useSessionStore.getState();
			const changed = { ...sessions[0], ...patch };
			const commit = vi.fn<typeof setSessions>((updater) => {
				// A selection write can land after the read resolves but before its commit.
				useSessionStore.setState({ sessions: [changed] });
				setSessions(updater);
			});
			useSessionStore.setState({ setSessions: commit });
			const created = vi.fn();
			await expect(
				reopenClosedConversation('agent', conversation, () => true, created)
			).rejects.toBeInstanceOf(SessionResumeRefusedError);
			expect(commit).toHaveBeenCalledTimes(1);
			expect(useSessionStore.getState().sessions[0]).toBe(changed);
			expect(created).not.toHaveBeenCalled();
		});

		it('checks cancellation at commit without creating or claiming a tab', async () => {
			const current = vi.fn().mockReturnValue(false);
			const created = vi.fn();
			const before = useSessionStore.getState().sessions[0];
			expect(await reopenClosedConversation('agent', conversation, current, created)).toBeNull();
			expect(current).toHaveBeenCalled();
			expect(created).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0]).toBe(before);
		});

		it.each(['concurrent', 'rebound', 'deleted', 'orphan', 'removed'])(
			'fences %s native tab changes at commit',
			async (change) => {
				const retained = tab('retained', {
					agentSessionId: 's-tax',
					nativeSessionBinding: nativeBinding,
					logs: [said('retained history')],
				});
				if (change === 'rebound' || change === 'deleted')
					useSessionStore.getState().updateSession('agent', { aiTabs: [retained] });
				let resolve!: (value: typeof receipt) => void;
				const pending = new Promise<typeof receipt>((done) => {
					resolve = done;
				});
				vi.mocked(window.maestro.agentSessions.read).mockReturnValue(pending);
				const created = vi.fn();
				const reopening = reopenClosedConversation('agent', conversation, () => true, created);
				if (change === 'removed') useSessionStore.getState().removeSession('agent');
				else if (change === 'deleted')
					useSessionStore.getState().updateSession('agent', { aiTabs: [buildTab()] });
				else
					useSessionStore.getState().updateSession(
						'agent',
						change === 'orphan'
							? { orphanedThinkingTabs: [retained] }
							: {
									aiTabs: [
										{
											...retained,
											nativeSessionBinding:
												change === 'rebound'
													? { ...nativeBinding, accountRef: 'account-b' }
													: nativeBinding,
										},
									],
								}
					);
				const after = useSessionStore.getState().sessions;
				resolve(receipt);
				if (change === 'concurrent') expect(await reopening).toBe('retained');
				else await expect(reopening).rejects.toBeInstanceOf(SessionResumeRefusedError);
				expect(useSessionStore.getState().sessions).toEqual(after);
				expect(created).not.toHaveBeenCalled();
			}
		);
	});

	it.each(['claude-code', 'codex'] as const)(
		'refuses a pending %s reopen after the agent switches to Grok',
		async (toolType) => {
			agentWith([buildTab()], { toolType });
			let resolve!: (value: typeof transcript) => void;
			vi.mocked(window.maestro.agentSessions.read).mockReturnValue(
				new Promise((done) => {
					resolve = done;
				})
			);
			const created = vi.fn();
			const reopening = reopenClosedConversation(
				'agent',
				{
					agentSessionId: 's-tax',
					name: 'Tax Questions',
				},
				() => true,
				created
			);
			useSessionStore.getState().updateSession('agent', { toolType: 'grok' });
			const changed = useSessionStore.getState().sessions[0];
			resolve(transcript);
			await expect(reopening).rejects.toBeInstanceOf(SessionResumeRefusedError);
			expect(useSessionStore.getState().sessions[0]).toBe(changed);
			expect(window.maestro.agentSessions.read).toHaveBeenCalledTimes(1);
			expect(vi.mocked(window.maestro.agentSessions.read).mock.calls[0][0]).toBe(toolType);
			expect(created).not.toHaveBeenCalled();
		}
	);

	it('does not attempt a foreign native resume for an unresolved migration History entry', async () => {
		agentWith([buildTab()], {
			providerTranslationHistoryMappings: [
				{ tabId: 'history:unmapped', sourceSessionId: 'unmapped', destinationSessionId: null },
			],
		});
		expect(
			await reopenClosedConversation('agent', { agentSessionId: 'unmapped', name: null })
		).toBeNull();
		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
	});
	it('brings the conversation back as a background tab, with its messages and name', async () => {
		agentWith([buildTab()]);
		const tabId = await reopenClosedConversation('agent', {
			agentSessionId: 's-tax',
			name: 'Tax Questions',
		});

		const session = useSessionStore.getState().sessions[0];
		const reopened = session.aiTabs.find((t) => t.id === tabId)!;
		expect(reopened).toMatchObject({ agentSessionId: 's-tax', name: 'Tax Questions' });
		expect(reopened.logs.map((l) => l.text)).toEqual(['what can I deduct?', 'The home office.']);
		// The user is in Quick Chat: the main window's view does not move.
		expect(session.activeTabId).toBe('build');
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/test/project',
			's-tax',
			expect.objectContaining({ offset: 0 }),
			undefined
		);
	});

	it('uses the tab the conversation already has rather than making a second', async () => {
		agentWith([buildTab(), tab('already', { agentSessionId: 's-tax' })]);
		expect(await reopenClosedConversation('agent', { agentSessionId: 's-tax', name: null })).toBe(
			'already'
		);
		expect(useSessionStore.getState().sessions[0].aiTabs).toHaveLength(2);
	});

	it('does not reopen a conversation still replying in a tab that was closed', async () => {
		// Reopened, used, and closed mid-reply while this one was being read. A
		// second tab would send a second turn into the same conversation at once.
		agentWith([buildTab()], {
			orphanedThinkingTabs: [tab('orphan', { agentSessionId: 's-tax', state: 'busy' })],
		});
		expect(
			await reopenClosedConversation('agent', { agentSessionId: 's-tax', name: null })
		).toBeNull();
		expect(useSessionStore.getState().sessions[0].aiTabs).toHaveLength(1);
	});

	it('gives up when the transcript has no messages left', async () => {
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [],
			total: 0,
			hasMore: false,
		});
		agentWith([buildTab()]);
		expect(
			await reopenClosedConversation('agent', { agentSessionId: 's-tax', name: null })
		).toBeNull();
		expect(useSessionStore.getState().sessions[0].aiTabs).toHaveLength(1);
	});

	it('gives up when the transcript cannot be read', async () => {
		vi.mocked(window.maestro.agentSessions.read).mockRejectedValue(new Error('ENOENT'));
		agentWith([buildTab()]);
		expect(
			await reopenClosedConversation('agent', { agentSessionId: 's-tax', name: null })
		).toBeNull();
	});

	it('gives up when the agent has no project root to read from', async () => {
		agentWith([buildTab()], { projectRoot: '' });
		expect(
			await reopenClosedConversation('agent', { agentSessionId: 's-tax', name: null })
		).toBeNull();
		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
	});
});
