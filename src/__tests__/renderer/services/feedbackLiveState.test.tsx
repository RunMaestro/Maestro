// Source: src/__tests__/renderer/services/feedbackLiveState.test.ts
// Source: src/__tests__/renderer/services/agentDelegation.test.ts
// Source: src/__tests__/renderer/services/contextCompaction.test.ts
// Source: src/__tests__/renderer/services/contextTimelineHydration.test.tsx
// Source: src/__tests__/renderer/services/crossAgentConsultHold.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { createMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAutoRunResumeStore } from '../../../renderer/stores/autoRunResumeStore';
import { captureFeedbackLiveState } from '../../../renderer/services/feedbackLiveState';
import { installFeedbackLiveStateHook } from '../../../renderer/services/feedbackLiveState';
import { FEEDBACK_LIVE_STATE_GLOBAL } from '../../../shared/feedbackLiveState';
import { beforeEach } from 'vitest';
import { buildDelegationLogEntry } from '../../../renderer/services/agentDelegation';
import { recordAgentDelegation } from '../../../renderer/services/agentDelegation';
import { resolveDelegationSourceTab } from '../../../renderer/services/agentDelegation';
import { settleAgentDelegation } from '../../../renderer/services/agentDelegation';
import { isSelfContainedCard } from '../../../renderer/utils/logEntries';
import { createMockAITab } from '../../helpers/mockTab';
import type { AgentDelegationNotice } from '../../../shared/agentDelegation';
import { vi } from 'vitest';
import { buildContextCompactionLogEntry } from '../../../renderer/services/contextCompaction';
import { canCompactTabContext } from '../../../renderer/services/contextCompaction';
import { compactTabContext } from '../../../renderer/services/contextCompaction';
import { recordContextCompaction } from '../../../renderer/services/contextCompaction';
import { registerContextCompactionSpawner } from '../../../renderer/services/contextCompaction';
import { settleContextCompaction } from '../../../renderer/services/contextCompaction';
import { getTabContextCompactionBlocker } from '../../../renderer/services/contextCompaction';
import type { HiddenTurnSpawner } from '../../../renderer/services/contextCompaction';
import { getContextCompactCommand } from '../../../shared/contextCompaction';
import { getContextCompactionBlocker } from '../../../shared/contextCompaction';
import type { Session } from '../../../renderer/types';
import { renderHook } from '@testing-library/react';
import { useAgentUsageListener } from '../../../renderer/hooks/agent/internal/useAgentUsageListener';
import { useContextTimelineStore } from '../../../renderer/stores/contextTimelineStore';
import type { ContextTimelinePoint } from '../../../renderer/stores/contextTimelineStore';
import { hydrateContextTimeline } from '../../../renderer/services/contextTimelineHydration';
import { forgetContextTimelineCaptures } from '../../../renderer/services/contextTimelineHydration';
import { __resetContextTimelineHydrationForTests } from '../../../renderer/services/contextTimelineHydration';
import { __resetConfiguredContextWindowCacheForTests } from '../../../renderer/utils/contextWindowResolver';
import type { BatchedUpdater } from '../../../renderer/hooks/agent/internal/types';
import type { UsageStats } from '../../../shared/types';
import { CONSULT_INTERRUPTED_BY_RESTART } from '../../../renderer/services/crossAgentConsultHold';
import { buildConsultFirstContext } from '../../../renderer/services/crossAgentConsultHold';
import { buildConsultHoldItem } from '../../../renderer/services/crossAgentConsultHold';
import { buildConsultPendingNote } from '../../../renderer/services/crossAgentConsultHold';
import { buildConsultReplyContext } from '../../../renderer/services/crossAgentConsultHold';
import { consultHoldReleasedText } from '../../../renderer/services/crossAgentConsultHold';
import { formatConsultedAgentNames } from '../../../renderer/services/crossAgentConsultHold';
import { formatConsultReplies } from '../../../renderer/services/crossAgentConsultHold';
import { holdTurnForConsults } from '../../../renderer/services/crossAgentConsultHold';
import { interruptConsultHolds } from '../../../renderer/services/crossAgentConsultHold';
import { loadCrossAgentConsultPrompts } from '../../../renderer/services/crossAgentConsultHold';
import { resolveConsultTargets } from '../../../renderer/services/crossAgentConsultHold';
import { settleConsultHold } from '../../../renderer/services/crossAgentConsultHold';
import { settleConsultInQueue } from '../../../renderer/services/crossAgentConsultHold';
import { withConsultPendingNote } from '../../../renderer/services/crossAgentConsultHold';
import { withHandoffPendingNote } from '../../../renderer/services/crossAgentConsultHold';
import type { ConsultHoldTarget } from '../../../renderer/types';
import type { QueuedItem } from '../../../renderer/types';
describeSourceSuite('feedbackLiveState', () => {
	describe('captureFeedbackLiveState', () => {
		afterEach(() => {
			useSessionStore.setState({ sessions: [] });
			useAutoRunResumeStore.setState({ entries: {} });
		});

		it('details only notable agents and counts the rest', () => {
			const now = 1_000_000;
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'idle', name: 'Quiet', state: 'idle' }),
					createMockSession({
						id: 'limited',
						name: 'Busy Bee',
						state: 'error',
						agentErrorPaused: true,
						agentError: {
							type: 'rate_limited',
							message: 'usage limit reached',
							recoverable: true,
							agentId: 'claude-code',
							timestamp: now - 60_000,
							limitResetAt: now - 1_000,
						},
					}),
				],
			});
			useAutoRunResumeStore.setState({
				entries: {
					limited: {
						sessionId: 'limited',
						attempts: 2,
						maxAttempts: 5,
						nextResumeAt: now + 30_000,
						exhausted: false,
						lastMessage: 'x',
					},
				},
			});

			const state = captureFeedbackLiveState(now);
			expect(state.agentCount).toBe(2);
			expect(state.agents.map((a) => a.id)).toEqual(['limited']);
			const [agent] = state.agents;
			expect(agent.error).toMatchObject({
				type: 'rate_limited',
				limit: true,
				paused: true,
				ageMs: 60_000,
				limitResetInMs: -1_000,
			});
			expect(agent.autoResume).toEqual({
				attempts: 2,
				maxAttempts: 5,
				nextResumeInMs: 30_000,
				exhausted: false,
			});
		});

		it('installs and removes the global main evaluates', () => {
			const uninstall = installFeedbackLiveStateHook();
			const target = window as unknown as Record<string, unknown>;
			expect(typeof target[FEEDBACK_LIVE_STATE_GLOBAL]).toBe('function');
			uninstall();
			expect(target[FEEDBACK_LIVE_STATE_GLOBAL]).toBeUndefined();
		});
	});
});
describeSourceSuite('agentDelegation', () => {
	const proxmox = () =>
		createMockSession({ id: 'proxmox', name: '🖥 Proxmox', toolType: 'claude-code' });

	const maestro = () =>
		createMockSession({
			id: 'maestro',
			name: 'Maestro',
			aiTabs: [
				// Mid-turn: a delegation only counts while the stamped tab's turn runs.
				createMockAITab({ id: 'caller-tab', state: 'busy', logs: [] }),
				createMockAITab({ id: 'other-tab', state: 'busy', logs: [] }),
			],
			activeTabId: 'other-tab',
		});

	const notice = (overrides: Partial<AgentDelegationNotice> = {}): AgentDelegationNotice => ({
		kind: 'dispatch',
		fromSessionId: 'maestro',
		fromTabId: 'caller-tab',
		targetSessionId: 'proxmox',
		prompt: 'Fix the advisory recovery bug',
		...overrides,
	});

	const logsOf = (sessionId: string, tabId: string) =>
		useSessionStore
			.getState()
			.sessions.find((s) => s.id === sessionId)!
			.aiTabs.find((t) => t.id === tabId)!.logs;

	describe('resolveDelegationSourceTab', () => {
		it('uses the tab the spawn named', () => {
			expect(resolveDelegationSourceTab(maestro(), 'caller-tab')?.id).toBe('caller-tab');
		});

		it('refuses to guess another tab when the named one has closed', () => {
			expect(resolveDelegationSourceTab(maestro(), 'closed-tab')).toBeUndefined();
		});

		it('refuses to guess a tab when the spawn named none (a Cue run, a bare --from)', () => {
			expect(resolveDelegationSourceTab(maestro())).toBeUndefined();
		});

		it('ignores a stamp from a process that outlived its turn (the named tab is idle)', () => {
			const session = maestro();
			session.aiTabs[0] = { ...session.aiTabs[0], state: 'idle' };
			expect(resolveDelegationSourceTab(session, 'caller-tab')).toBeUndefined();
		});
	});

	describe('buildDelegationLogEntry', () => {
		it('builds a self-contained card with a one-line subject', () => {
			const entry = buildDelegationLogEntry(
				notice({ targetTabId: 'queued-tab', prompt: 'Fix the\n\n advisory   bug', queued: true }),
				proxmox()
			);
			expect(entry.delegation).toEqual({
				kind: 'dispatch',
				toSessionId: 'proxmox',
				toTabId: 'queued-tab',
				toAgentName: '🖥 Proxmox',
				toToolType: 'claude-code',
				subject: 'Fix the advisory bug',
				queued: true,
			});
			expect(entry.text).toBe('Delegated to 🖥 Proxmox: Fix the advisory bug');
			expect(isSelfContainedCard(entry)).toBe(true);
		});

		it('cuts a long prompt down to one line', () => {
			const entry = buildDelegationLogEntry(notice({ prompt: 'x'.repeat(500) }), proxmox());
			expect(entry.delegation!.subject.length).toBeLessThanOrEqual(120);
			expect(entry.delegation!.subject.endsWith('…')).toBe(true);
		});

		it('words an ask as a question', () => {
			const entry = buildDelegationLogEntry(
				notice({ kind: 'ask', prompt: 'Which branch?' }),
				proxmox()
			);
			expect(entry.text).toBe('Asked 🖥 Proxmox: Which branch?');
		});
	});

	describe('recordAgentDelegation / settleAgentDelegation', () => {
		beforeEach(() => {
			useSessionStore.setState({ sessions: [proxmox(), maestro()] } as never);
		});

		it('appends the pill to the delegating tab only', () => {
			const ref = recordAgentDelegation(notice());

			expect(ref).toEqual({
				sessionId: 'maestro',
				tabId: 'caller-tab',
				entryId: expect.any(String),
			});
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(1);
			expect(logsOf('maestro', 'caller-tab')[0].delegation?.toAgentName).toBe('🖥 Proxmox');
			expect(logsOf('maestro', 'other-tab')).toHaveLength(0);
		});

		it('records nothing when a leftover daemon dispatches from an idle tab', () => {
			const session = maestro();
			session.aiTabs[0] = { ...session.aiTabs[0], state: 'idle' };
			useSessionStore.setState({ sessions: [proxmox(), session] } as never);

			expect(
				recordAgentDelegation(notice({ targetSessionId: 'maestro', newTab: true }))
			).toBeNull();
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(0);
		});

		it('records nothing when the target or the caller is gone', () => {
			expect(recordAgentDelegation(notice({ targetSessionId: 'deleted' }))).toBeNull();
			expect(recordAgentDelegation(notice({ fromSessionId: 'deleted' }))).toBeNull();
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(0);
		});

		it('settles a pending ask pill in place', () => {
			const ref = recordAgentDelegation(notice({ kind: 'ask' }), { pending: true })!;
			expect(logsOf('maestro', 'caller-tab')[0].delegation?.status).toBe('pending');

			settleAgentDelegation(ref, { status: 'error', error: 'timed out', toTabId: 'consult-1' });

			expect(logsOf('maestro', 'caller-tab')).toHaveLength(1);
			expect(logsOf('maestro', 'caller-tab')[0].delegation).toMatchObject({
				status: 'error',
				error: 'timed out',
				toTabId: 'consult-1',
			});
		});

		it('settling is a no-op once the entry is gone', () => {
			const ref = recordAgentDelegation(notice({ kind: 'ask' }), { pending: true })!;
			useSessionStore.setState({ sessions: [proxmox(), maestro()] } as never);

			settleAgentDelegation(ref, { status: 'done' });

			expect(logsOf('maestro', 'caller-tab')).toHaveLength(0);
		});
	});
});
describeSourceSuite('contextCompaction', () => {
	const SESSION = 's1';
	const TAB = 't1';

	function seed(overrides: Partial<Session> = {}, agentSessionId: string | null = 'claude-abc') {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: SESSION,
					toolType: 'claude-code',
					cwd: '/repo',
					aiTabs: [createMockAITab({ id: TAB, agentSessionId })],
					activeTabId: TAB,
					...overrides,
				}),
			],
		} as never);
	}

	function logs() {
		return useSessionStore.getState().sessions[0].aiTabs[0].logs;
	}

	beforeEach(() => {
		seed();
	});

	afterEach(() => {
		registerContextCompactionSpawner(null);
	});

	describe('getContextCompactCommand', () => {
		it('names a command only for providers verified to honor it', () => {
			expect(getContextCompactCommand('claude-code')).toBe('/compact');
			expect(getContextCompactCommand('codex')).toBeUndefined();
			expect(getContextCompactCommand(undefined)).toBeUndefined();
		});
	});

	describe('canCompactTabContext', () => {
		it('needs a wired spawner, a provider command, and a session to resume', () => {
			expect(canCompactTabContext(SESSION, TAB)).toBe(false);

			registerContextCompactionSpawner(vi.fn<HiddenTurnSpawner>());
			expect(canCompactTabContext(SESSION, TAB)).toBe(true);
			expect(canCompactTabContext(SESSION, 'missing-tab')).toBe(false);
			expect(canCompactTabContext('missing-session', TAB)).toBe(false);

			seed({ toolType: 'codex' });
			expect(canCompactTabContext(SESSION, TAB)).toBe(false);

			seed({}, null);
			expect(canCompactTabContext(SESSION, TAB)).toBe(false);
		});
	});

	describe('compactTabContext', () => {
		it("resumes the tab's provider session with the compaction command, on the agent's own config", async () => {
			const spawner = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
			registerContextCompactionSpawner(spawner);
			seed({
				customModel: 'opus[1m]',
				customPath: '/usr/local/bin/claude',
				customEnvVars: { FOO: 'bar' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({ success: true });

			expect(spawner).toHaveBeenCalledTimes(1);
			const [sessionId, cwd, resumeId, prompt, toolType, config, options] = spawner.mock.calls[0];
			expect([sessionId, cwd, resumeId, prompt, toolType]).toEqual([
				SESSION,
				'/repo',
				'claude-abc',
				'/compact',
				'claude-code',
			]);
			expect(config).toMatchObject({
				customModel: 'opus[1m]',
				customPath: '/usr/local/bin/claude',
				customEnvVars: { FOO: 'bar' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			expect(options).toEqual({ keepTurnSettings: true, allowEmptyResponse: true });
		});

		it('reports a failed or thrown compaction instead of throwing', async () => {
			registerContextCompactionSpawner(
				vi
					.fn<HiddenTurnSpawner>()
					.mockResolvedValue({ success: false, error: 'Prompt is too long' })
			);
			await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({
				success: false,
				error: 'Prompt is too long',
			});

			registerContextCompactionSpawner(
				vi.fn<HiddenTurnSpawner>().mockRejectedValue(new Error('spawn refused'))
			);
			await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({
				success: false,
				error: 'spawn refused',
			});
		});

		it('fails without spawning when there is nothing to compact', async () => {
			const spawner = vi.fn<HiddenTurnSpawner>();
			registerContextCompactionSpawner(spawner);
			seed({}, null);

			expect((await compactTabContext(SESSION, TAB)).success).toBe(false);
			expect(spawner).not.toHaveBeenCalled();
		});
	});

	describe('the compaction pill', () => {
		it('is a self-contained card, so streamed output never appends to it', () => {
			expect(isSelfContainedCard(buildContextCompactionLogEntry('pending'))).toBe(true);
		});

		it('is appended pending and settled in place', () => {
			const before = logs().length;
			const ref = recordContextCompaction(SESSION, TAB)!;

			expect(logs()).toHaveLength(before + 1);
			expect(logs()[before].id).toBe(ref.entryId);
			expect(logs()[before].contextCompaction).toEqual({ status: 'pending' });

			settleContextCompaction(ref, { status: 'done' });
			expect(logs()).toHaveLength(before + 1);
			expect(logs()[before].contextCompaction).toEqual({ status: 'done' });

			// Already settled: a late outcome does not overwrite the first.
			settleContextCompaction(ref, { status: 'error', error: 'late' });
			expect(logs()[before].contextCompaction).toEqual({ status: 'done' });
		});

		it('records nothing for a tab that is gone', () => {
			expect(recordContextCompaction(SESSION, 'missing-tab')).toBeNull();
			expect(recordContextCompaction('missing-session', TAB)).toBeNull();
		});
	});

	/**
	 * Grok has no qualified native compaction operation, so
	 * the success branch of its context-limit recovery does not exist: the recovery
	 * is a visible required-feature blocker. These cases pin that a scripted Grok
	 * operation reporting success is never reached, never stands in for a
	 * compaction, and leaves the tab's native identity (resume ID, account root,
	 * host, model) and transcript exactly as they were. A future qualified operation
	 * replaces the blocker and must replace these cases with the success contract.
	 */
	describe('Grok context-limit recovery', () => {
		const GROK_NATIVE_ID = 'grok-native-session-7';
		const GROK_ACCOUNT_ENV = { GROK_HOME: '/accounts/grok-work' };
		const GROK_SSH = { enabled: true, remoteId: 'grok-host-1' };

		/** A Grok tab mid-conversation on a selected account, model and host. */
		function seedGrok(agentSessionId: string | null = GROK_NATIVE_ID) {
			seed(
				{
					toolType: 'grok',
					customModel: 'grok-4',
					customEnvVars: { ...GROK_ACCOUNT_ENV },
					sessionSshRemoteConfig: { ...GROK_SSH },
				},
				agentSessionId
			);
		}

		/**
		 * A scripted Grok operation that would report every outcome the recovery
		 * could mistake for a compaction: success, an empty success, a failure and a
		 * thrown refusal. None of them may be reached.
		 */
		function scriptedGrokOperations(): HiddenTurnSpawner[] {
			return [
				vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true }),
				vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true, response: '' } as never),
				vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: false, error: 'exit code 143' }),
				vi.fn<HiddenTurnSpawner>().mockRejectedValue(new Error('grok refused the operation')),
			];
		}

		it('names the gap as a required-feature blocker with its parity rows', () => {
			const blocker = getContextCompactionBlocker('grok');
			expect(blocker).toEqual({
				reason: 'required-feature',
				feature: 'grok-native-compaction',
				parityRows: ['S34', 'B03'],
				detail: expect.stringContaining('Grok has no qualified native compaction operation'),
			});
			// Never a guessed literal: Grok has no compaction command at all.
			expect(getContextCompactCommand('grok')).toBeUndefined();
			// A provider with a verified command is never blocked; an unlisted one is
			// simply unlisted, not a recorded blocker.
			expect(getContextCompactionBlocker('claude-code')).toBeUndefined();
			expect(getContextCompactionBlocker('codex')).toBeUndefined();
			expect(getContextCompactionBlocker(undefined)).toBeUndefined();
		});

		it("reads the blocker off the tab's own provider", () => {
			seedGrok();
			expect(getTabContextCompactionBlocker(SESSION, TAB)?.feature).toBe('grok-native-compaction');
			expect(getTabContextCompactionBlocker(SESSION, 'missing-tab')).toBeNull();
			expect(getTabContextCompactionBlocker('missing-session', TAB)).toBeNull();

			seed();
			expect(getTabContextCompactionBlocker(SESSION, TAB)).toBeNull();
		});

		it('is not compactable even with a spawner wired and a native session to resume', () => {
			registerContextCompactionSpawner(vi.fn<HiddenTurnSpawner>());
			seedGrok();
			expect(canCompactTabContext(SESSION, TAB)).toBe(false);
		});

		it('never runs a scripted Grok operation, whatever it would report', async () => {
			seedGrok();
			const blocker = getContextCompactionBlocker('grok')!;

			for (const operation of scriptedGrokOperations()) {
				registerContextCompactionSpawner(operation);
				await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({
					success: false,
					error: blocker.detail,
				});
				expect(operation).not.toHaveBeenCalled();
			}
		});

		it("leaves the tab's native identity and transcript untouched after the refusal", async () => {
			seedGrok();
			const before = useSessionStore.getState().sessions[0];
			const logCount = before.aiTabs[0].logs.length;
			registerContextCompactionSpawner(
				vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true })
			);

			expect((await compactTabContext(SESSION, TAB)).success).toBe(false);

			const after = useSessionStore.getState().sessions[0];
			expect(after.aiTabs[0].agentSessionId).toBe(GROK_NATIVE_ID);
			expect(after.customEnvVars).toEqual(GROK_ACCOUNT_ENV);
			expect(after.sessionSshRemoteConfig).toEqual(GROK_SSH);
			expect(after.customModel).toBe('grok-4');
			expect(after.toolType).toBe('grok');
			// No pill: nothing claims a compaction happened.
			expect(after.aiTabs[0].logs).toHaveLength(logCount);
			expect(after.aiTabs[0].logs.some((log) => log.contextCompaction)).toBe(false);
		});

		it('refuses the same way with no native session to resume', async () => {
			const operation = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
			registerContextCompactionSpawner(operation);
			seedGrok(null);

			const result = await compactTabContext(SESSION, TAB);
			expect(result).toEqual({
				success: false,
				error: getContextCompactionBlocker('grok')!.detail,
			});
			expect(operation).not.toHaveBeenCalled();
		});

		it('keeps the qualified provider on its own path beside a blocked one', async () => {
			const operation = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
			registerContextCompactionSpawner(operation);

			seedGrok();
			expect((await compactTabContext(SESSION, TAB)).success).toBe(false);
			expect(operation).not.toHaveBeenCalled();

			seed();
			await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({ success: true });
			expect(operation).toHaveBeenCalledTimes(1);
			expect(operation.mock.calls[0].slice(2, 5)).toEqual([
				'claude-abc',
				'/compact',
				'claude-code',
			]);
		});
	});
});
describeSourceSuite('contextTimelineHydration', () => {
	const SID = 'sess-1';
	const WINDOW = 200_000;

	let handler: ((sessionId: string, usage: UsageStats) => void) | undefined;

	const mockProcess = {
		onUsage: vi.fn((h: (sessionId: string, usage: UsageStats) => void) => {
			handler = h;
			return vi.fn();
		}),
	};

	const getCaptures = vi.fn();
	const clearCaptures = vi.fn();

	function makeBatched(): BatchedUpdater {
		return {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
		} as unknown as BatchedUpdater;
	}

	const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 50_000,
		outputTokens: 500,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.01,
		contextWindow: WINDOW,
		...overrides,
	});

	/**
	 * One instance of each of the four skip guards plus two recordable turns.
	 * `sessionId` varies so the synthetic-run guard has something to fire on.
	 */
	const STREAM: Array<{ sessionId: string; stats: UsageStats }> = [
		// Recordable.
		{ sessionId: `${SID}-ai-tab1`, stats: usage({ inputTokens: 50_000, captureSeq: 1 }) },
		// Guard 1: synthetic (Auto Run batch) run against the same agent.
		{
			sessionId: `${SID}-batch-1700000000000`,
			stats: usage({ inputTokens: 9_000, captureSeq: 2 }),
		},
		// Guard 2: output-only delta with no absolute snapshot.
		{
			sessionId: `${SID}-ai-tab1`,
			stats: usage({ inputTokens: 0, outputTokens: 300, captureSeq: 3 }),
		},
		// Guard 3: no-activity repeat.
		{
			sessionId: `${SID}-ai-tab1`,
			stats: usage({ inputTokens: 0, outputTokens: 0, captureSeq: 4 }),
		},
		// Guard 4: context-window correction replay.
		{
			sessionId: `${SID}-ai-tab1`,
			stats: usage({ inputTokens: 70_000, contextWindowCorrectionOnly: true, captureSeq: 5 }),
		},
		// Recordable.
		{ sessionId: `${SID}-ai-tab1`, stats: usage({ inputTokens: 120_000, captureSeq: 6 }) },
	];

	/** The fields that must match between a live point and a hydrated one. */
	function comparable(p: ContextTimelinePoint) {
		const { id: _id, timestamp: _timestamp, ...rest } = p;
		return rest;
	}

	function seedSession() {
		const session = createMockSession({ id: SID, toolType: 'claude-code' });
		useSessionStore.setState({ sessions: [session] } as never);
		return session;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		} as never);
		useContextTimelineStore.setState({ buffers: {} });
		__resetConfiguredContextWindowCacheForTests();
		__resetContextTimelineHydrationForTests();
		(window as unknown as { maestro: Record<string, unknown> }).maestro = {
			...((window as unknown as { maestro?: Record<string, unknown> }).maestro || {}),
			process: mockProcess,
			contextTimeline: { getCaptures, clearCaptures },
		};
		getCaptures.mockResolvedValue({
			success: true,
			trimmed: false,
			captures: STREAM.map((e, i) => ({
				seq: e.stats.captureSeq ?? i + 1,
				timestamp: 1_700_000_000_000 + i,
				sessionId: e.sessionId,
				usageStats: e.stats,
			})),
		});
	});

	/** Run the fixture stream through the LIVE listener and return its points. */
	function livePoints(): ContextTimelinePoint[] {
		seedSession();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: makeBatched(), contextWarningYellowThreshold: 80 })
		);
		for (const event of STREAM) handler!(event.sessionId, event.stats);
		return useContextTimelineStore.getState().buffers[SID].points;
	}

	describe('contextTimelineHydration', () => {
		it('hydrates to exactly the points the live path produces for the same stream', async () => {
			const live = livePoints().map(comparable);
			// Only the two recordable turns survive the four guards.
			expect(live).toHaveLength(2);

			// Fresh renderer: same stream, arriving as captures instead of live events.
			useContextTimelineStore.setState({ buffers: {} });
			const session = seedSession();
			await hydrateContextTimeline(SID, session);

			const hydrated = useContextTimelineStore.getState().buffers[SID].points;
			expect(hydrated.map(comparable)).toEqual(live);
		});

		it('preserves the captured timestamps rather than stamping the hydration moment', async () => {
			const session = seedSession();
			await hydrateContextTimeline(SID, session);

			const points = useContextTimelineStore.getState().buffers[SID].points;
			expect(points.map((p) => p.timestamp)).toEqual([1_700_000_000_000, 1_700_000_000_005]);
		});

		it('carries the trimmed flag across the fetch-hydrate round trip', async () => {
			getCaptures.mockResolvedValue({ success: true, trimmed: true, captures: [] });
			const session = seedSession();
			await hydrateContextTimeline(SID, session);

			expect(useContextTimelineStore.getState().buffers[SID].trimmed).toBe(true);
		});

		it('does not duplicate or reorder when a live point landed during the fetch', async () => {
			const session = seedSession();
			// The last recordable turn (seq 6) arrives live while the fetch is in flight.
			renderHook(() =>
				useAgentUsageListener({ batchedUpdater: makeBatched(), contextWarningYellowThreshold: 80 })
			);
			const lastEvent = STREAM[STREAM.length - 1];
			handler!(lastEvent.sessionId, lastEvent.stats);
			expect(useContextTimelineStore.getState().buffers[SID].points).toHaveLength(1);

			await hydrateContextTimeline(SID, session);

			const points = useContextTimelineStore.getState().buffers[SID].points;
			expect(points).toHaveLength(2);
			expect(points.map((p) => p.seq)).toEqual([1, 6]);
			expect(points.map((p) => p.contextTokens)).toEqual([50_000, 120_000]);
		});

		it('does not re-hydrate a buffer that was already hydrated', async () => {
			const session = seedSession();
			await hydrateContextTimeline(SID, session);
			expect(getCaptures).toHaveBeenCalledTimes(1);

			await hydrateContextTimeline(SID, session);
			expect(getCaptures).toHaveBeenCalledTimes(1);
		});

		it('leaves the buffer unhydrated when the fetch fails, so a reopen retries', async () => {
			getCaptures.mockResolvedValue({ success: false, error: 'boom' });
			const session = seedSession();
			await hydrateContextTimeline(SID, session);

			expect(useContextTimelineStore.getState().buffers[SID]?.hydrated).toBeUndefined();

			getCaptures.mockResolvedValue({ success: true, trimmed: false, captures: [] });
			await hydrateContextTimeline(SID, session);
			expect(useContextTimelineStore.getState().buffers[SID].hydrated).toBe(true);
		});

		// Review of PR #1365 (Greptile). `hydrateSession` runs AFTER an await, so a
		// clear that landed while the fetch was in flight used to be undone by the
		// reply - the discarded history reappeared, or a deleted agent's buffer was
		// recreated.
		it('drops a hydration whose history was cleared while the fetch was in flight', async () => {
			const session = seedSession();
			let release: ((v: unknown) => void) | undefined;
			getCaptures.mockReturnValueOnce(
				new Promise((resolve) => {
					release = resolve;
				})
			);

			const pending = hydrateContextTimeline(SID, session);
			// The user clears the timeline (or deletes the agent) mid-flight.
			forgetContextTimelineCaptures(SID);
			release!({
				success: true,
				trimmed: false,
				captures: STREAM.map((e, i) => ({
					seq: e.stats.captureSeq ?? i + 1,
					timestamp: 1_700_000_000_000 + i,
					sessionId: e.sessionId,
					usageStats: e.stats,
				})),
			});
			await pending;

			// Nothing restored, and the buffer is NOT marked hydrated, so a later
			// deliberate reopen can still fetch afresh.
			expect(useContextTimelineStore.getState().buffers[SID]?.points ?? []).toHaveLength(0);
			expect(useContextTimelineStore.getState().buffers[SID]?.hydrated).toBeUndefined();
		});

		it('still hydrates normally when the clear targets a different agent', async () => {
			const session = seedSession();
			const pending = hydrateContextTimeline(SID, session);
			forgetContextTimelineCaptures('some-other-agent');
			await pending;

			expect(useContextTimelineStore.getState().buffers[SID].points.length).toBeGreaterThan(0);
			expect(useContextTimelineStore.getState().buffers[SID].hydrated).toBe(true);
		});

		it('ignores captures belonging to a different agent whose id shares this prefix', async () => {
			getCaptures.mockResolvedValue({
				success: true,
				trimmed: false,
				captures: [
					{
						seq: 1,
						timestamp: 1,
						sessionId: `${SID}-extra-ai-tab1`,
						usageStats: usage({ captureSeq: 1 }),
					},
				],
			});
			const session = seedSession();
			await hydrateContextTimeline(SID, session);

			expect(useContextTimelineStore.getState().buffers[SID].points).toHaveLength(0);
		});
	});
});
describeSourceSuite('crossAgentConsultHold', () => {
	const SOURCE_ID = 'session-source';
	const SOURCE_TAB = 'tab-source';
	const BACKEND: ConsultHoldTarget = {
		targetSessionId: 'session-backend',
		targetAgentName: 'Backend',
	};
	const API: ConsultHoldTarget = { targetSessionId: 'session-api', targetAgentName: 'API' };

	const REPLY_TEMPLATE = 'REPLIES:\n\n{{CONSULT_REPLIES}}\n\nFinish.';

	function hold(targets: ConsultHoldTarget[], overrides: Partial<QueuedItem> = {}): QueuedItem {
		return {
			id: 'hold-1',
			timestamp: 5,
			tabId: SOURCE_TAB,
			type: 'message',
			text: 'Waiting',
			awaitingConsult: { pending: [...targets], replies: [] },
			...overrides,
		};
	}

	function sourceSession(overrides: Partial<Session> = {}): Session {
		return createMockSession({
			id: SOURCE_ID,
			name: 'Frontend',
			aiTabs: [createMockAITab({ id: SOURCE_TAB })],
			activeTabId: SOURCE_TAB,
			executionQueue: [],
			...overrides,
		});
	}

	function queueOf(sessionId = SOURCE_ID): QueuedItem[] {
		return (
			useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.executionQueue ?? []
		);
	}

	function stubPrompts(content: Record<string, string>): void {
		const w = window as unknown as { maestro: Record<string, unknown> };
		w.maestro = {
			...w.maestro,
			prompts: {
				get: async (id: string) => ({ success: true, content: content[id] }),
			},
		};
	}

	beforeEach(() => {
		useSessionStore.setState({ sessions: [], groups: [], activeSessionId: '' });
	});

	describe('formatConsultedAgentNames', () => {
		it('joins names the way a sentence would', () => {
			expect(formatConsultedAgentNames(['Backend'])).toBe('Backend');
			expect(formatConsultedAgentNames(['Backend', 'API'])).toBe('Backend and API');
			expect(formatConsultedAgentNames(['A', 'B', 'C'])).toBe('A, B and C');
			expect(formatConsultedAgentNames([])).toBe('another agent');
		});
	});

	describe('pending note', () => {
		it('fills every consulted-agent placeholder', () => {
			expect(
				buildConsultPendingNote('{{CONSULTED_AGENTS}} / {{CONSULTED_AGENTS}}', ['A', 'B'])
			).toBe('A and B / A and B');
		});

		it('is appended to the prompt once the template has loaded', async () => {
			stubPrompts({
				'cross-agent-consult-pending': 'Consulting {{CONSULTED_AGENTS}}.',
				'cross-agent-consult-reply': REPLY_TEMPLATE,
			});
			await loadCrossAgentConsultPrompts(true);

			expect(withConsultPendingNote('do the thing', [BACKEND])).toBe(
				'do the thing\n\n---\n\nConsulting Backend.'
			);
		});

		it('leaves the prompt alone when nothing is being consulted', async () => {
			stubPrompts({
				'cross-agent-consult-pending': 'Consulting {{CONSULTED_AGENTS}}.',
				'cross-agent-consult-reply': REPLY_TEMPLATE,
			});
			await loadCrossAgentConsultPrompts(true);

			expect(withConsultPendingNote('do the thing', [])).toBe('do the thing');
		});
	});

	describe('reply formatting', () => {
		it('labels each reply with who said it, verbatim', () => {
			const body = formatConsultReplies([
				{ ...BACKEND, text: 'Use a queue.' },
				{ ...API, text: 'partial', error: 'timed out' },
			]);
			expect(body).toContain('### Reply from Backend\n\nUse a queue.');
			// A failed consult says why, and keeps whatever it managed to say.
			expect(body).toContain('### API could not respond\n\ntimed out');
			expect(body).toContain('partial');
		});

		it('wraps the replies in the reply template', () => {
			expect(buildConsultReplyContext(REPLY_TEMPLATE, [{ ...BACKEND, text: 'ok' }])).toBe(
				'REPLIES:\n\n### Reply from Backend\n\nok\n\nFinish.'
			);
		});

		it('names who answered and who could not in the visible continuation', () => {
			expect(consultHoldReleasedText([{ ...BACKEND, text: 'ok' }])).toBe(
				'Backend replied. Finish your answer with what came back.'
			);
			expect(
				consultHoldReleasedText([
					{ ...BACKEND, text: 'ok' },
					{ ...API, text: '', error: 'gone' },
				])
			).toBe('Backend replied. API could not respond. Finish your answer with what came back.');
		});
	});

	describe('settleConsultInQueue', () => {
		const settle = (queue: QueuedItem[], targetSessionId: string, extra = {}) =>
			settleConsultInQueue(
				queue,
				{
					sourceSessionId: SOURCE_ID,
					sourceTabId: SOURCE_TAB,
					targetSessionId,
					text: 'answer',
					...extra,
				},
				REPLY_TEMPLATE
			);

		it('keeps holding while another consult is still pending', () => {
			const next = settle([hold([BACKEND, API])], BACKEND.targetSessionId);

			expect(next[0].awaitingConsult?.pending).toEqual([API]);
			expect(next[0].awaitingConsult?.replies).toEqual([{ ...BACKEND, text: 'answer' }]);
			expect(next[0].agentContext).toBeUndefined();
		});

		it('releases into a runnable continuation once the last reply lands', () => {
			const next = settle(
				settle([hold([BACKEND, API])], BACKEND.targetSessionId),
				API.targetSessionId
			);

			expect(next[0].awaitingConsult).toBeUndefined();
			expect(next[0].text).toBe('Backend and API replied. Finish your answer with what came back.');
			expect(next[0].agentContext).toContain('### Reply from Backend\n\nanswer');
			expect(next[0].agentContext).toContain('### Reply from API\n\nanswer');
			// Keeps its place: the release does not re-stamp the item.
			expect(next[0].timestamp).toBe(5);
		});

		it('records a failed consult as a reply, so the agent can still finish', () => {
			const next = settle([hold([BACKEND])], BACKEND.targetSessionId, {
				text: '',
				error: 'not found',
			});

			expect(next[0].awaitingConsult).toBeUndefined();
			expect(next[0].agentContext).toContain('Backend could not respond');
		});

		it('removes the hold when the user stopped the consult', () => {
			const other: QueuedItem = { id: 'q2', timestamp: 6, tabId: SOURCE_TAB, type: 'message' };
			const next = settle([hold([BACKEND]), other], BACKEND.targetSessionId, { canceled: true });

			expect(next).toEqual([other]);
		});

		it('is a no-op for a consult nothing is holding for', () => {
			const queue = [hold([BACKEND])];
			// Different tab (a `maestro-cli ask`, a different conversation).
			expect(
				settleConsultInQueue(
					queue,
					{
						sourceSessionId: SOURCE_ID,
						sourceTabId: 'other-tab',
						targetSessionId: BACKEND.targetSessionId,
						text: '',
					},
					REPLY_TEMPLATE
				)
			).toBe(queue);
			// Same target settling twice.
			const released = settle(queue, BACKEND.targetSessionId);
			expect(settle(released, BACKEND.targetSessionId)).toBe(released);
		});
	});

	describe('consult-first hold', () => {
		const FIRST_TEMPLATE =
			'Heard from {{CONSULTED_AGENTS}}:\n\n{{CONSULT_REPLIES}}\n\nAnswer:\n\n{{USER_MESSAGE}}';
		const deferredHold = (targets: ConsultHoldTarget[]) =>
			hold(targets, {
				awaitingConsult: {
					pending: [...targets],
					replies: [],
					deferred: { message: 'check with @Backend first', images: ['img-1'] },
				},
			});
		const settleFirst = (queue: QueuedItem[], targetSessionId: string) =>
			settleConsultInQueue(
				queue,
				{
					sourceSessionId: SOURCE_ID,
					sourceTabId: SOURCE_TAB,
					targetSessionId,
					text: 'answer',
				},
				REPLY_TEMPLATE,
				FIRST_TEMPLATE
			);

		it('keeps the deferred message while other consults are pending', () => {
			const [next] = settleFirst([deferredHold([BACKEND, API])], BACKEND.targetSessionId);

			expect(next.awaitingConsult?.pending).toEqual([API]);
			expect(next.awaitingConsult?.deferred?.message).toBe('check with @Backend first');
		});

		it('releases into the turn that ANSWERS the message, carrying its images', () => {
			// The source agent never saw the message: the released hold has to hand it
			// over along with the replies, not ask it to "finish" an answer it never began.
			const [next] = settleFirst([deferredHold([BACKEND])], BACKEND.targetSessionId);

			expect(next.awaitingConsult).toBeUndefined();
			expect(next.text).toBe('Backend replied. Answer the message with what came back.');
			expect(next.agentContext).toBe(
				'Heard from Backend:\n\n### Reply from Backend\n\nanswer\n\nAnswer:\n\ncheck with @Backend first'
			);
			expect(next.images).toEqual(['img-1']);
		});

		it('still hands over the message when the template has not loaded', () => {
			expect(buildConsultFirstContext('', [{ ...BACKEND, text: 'hi' }], 'the question')).toBe(
				'### Reply from Backend\n\nhi\n\nthe question'
			);
		});

		it('reads as waiting to ANSWER, not to finish, while it waits', () => {
			const session = sourceSession();
			const item = buildConsultHoldItem({
				session,
				tab: session.aiTabs[0],
				targets: [BACKEND],
				deferred: { message: 'm' },
			});

			expect(item.text).toBe('Waiting for Backend to reply before answering.');
			expect(consultHoldReleasedText([{ ...BACKEND, text: 'x' }], true)).toBe(
				'Backend replied. Answer the message with what came back.'
			);
		});
	});

	describe('hand-off note', () => {
		it('is appended once the template has loaded, naming every target', async () => {
			stubPrompts({ 'cross-agent-handoff-pending': 'Forwarding to {{HANDOFF_AGENTS}}.' });
			await loadCrossAgentConsultPrompts(true);

			expect(withHandoffPendingNote('do it', [BACKEND, API])).toBe(
				'do it\n\n---\n\nForwarding to Backend and API.'
			);
			expect(withHandoffPendingNote('do it', [])).toBe('do it');
		});
	});

	describe('interruptConsultHolds', () => {
		it('releases every pending consult as interrupted', () => {
			const queue = [hold([BACKEND, API])];
			const next = interruptConsultHolds(queue, REPLY_TEMPLATE);

			expect(next[0].awaitingConsult).toBeUndefined();
			expect(next[0].agentContext).toContain(CONSULT_INTERRUPTED_BY_RESTART);
		});

		it('returns the same queue when nothing is held', () => {
			const queue: QueuedItem[] = [{ id: 'q', timestamp: 0, tabId: SOURCE_TAB, type: 'message' }];
			expect(interruptConsultHolds(queue, REPLY_TEMPLATE)).toBe(queue);
		});
	});

	describe('store-bound hold', () => {
		it('resolves target names from the store, keeping unknown agents', () => {
			useSessionStore.setState({
				sessions: [sourceSession(), createMockSession({ id: 'session-backend', name: 'Backend' })],
			});

			expect(resolveConsultTargets(['session-backend', 'session-gone'])).toEqual([
				BACKEND,
				{ targetSessionId: 'session-gone', targetAgentName: 'another agent' },
			]);
		});

		it('puts the hold at the head of the queue, ahead of anything queued later', () => {
			const later: QueuedItem = { id: 'later', timestamp: 9, tabId: SOURCE_TAB, type: 'message' };
			useSessionStore.setState({ sessions: [sourceSession({ executionQueue: [later] })] });

			holdTurnForConsults(SOURCE_ID, SOURCE_TAB, [BACKEND]);

			const queue = queueOf();
			expect(queue).toHaveLength(2);
			expect(queue[0].awaitingConsult?.pending).toEqual([BACKEND]);
			expect(queue[0].tabId).toBe(SOURCE_TAB);
			expect(queue[1]).toBe(later);
		});

		it('does nothing without targets', () => {
			useSessionStore.setState({ sessions: [sourceSession()] });
			holdTurnForConsults(SOURCE_ID, SOURCE_TAB, []);
			expect(queueOf()).toEqual([]);
		});

		it('settles the hold from a terminal chunk', () => {
			useSessionStore.setState({ sessions: [sourceSession()] });
			holdTurnForConsults(SOURCE_ID, SOURCE_TAB, [BACKEND]);

			settleConsultHold({
				sourceSessionId: SOURCE_ID,
				sourceTabId: SOURCE_TAB,
				targetSessionId: BACKEND.targetSessionId,
				text: 'here you go',
			});

			const [released] = queueOf();
			expect(released.awaitingConsult).toBeUndefined();
			expect(released.agentContext).toContain('here you go');
		});
	});
});
