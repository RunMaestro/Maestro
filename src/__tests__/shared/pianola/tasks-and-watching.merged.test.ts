// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/pianola/pianola-watcher.test.ts
// Source: src/__tests__/shared/pianola/pianola-tasks.test.ts
// Source: src/__tests__/shared/pianola/pianola-first-party-plugin.test.ts
// Source: src/__tests__/shared/pianola/pianola-agent-select.test.ts
// Source: src/__tests__/shared/pianola/pianola-message-contract.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
	runWatchIteration,
	initialWatchState,
	rehydrateWatchState,
	lastWatchActivityMs,
	isWatchIdleExpired,
	MAX_DISPATCH_ATTEMPTS,
	HANDOFF_TIMEOUT_POLLS,
	type WatchDeps,
	type WatchState,
	type WatchTarget,
	type PianolaNotifyEvent,
} from '../../../shared/pianola/pianola-watcher';
import type {
	PianolaMessage as S1_PianolaMessage,
	PianolaRule,
} from '../../../shared/pianola/types';
import type { PianolaDecisionRecord, PianolaProfileEntry } from '../../../shared/pianola/storage';
import {
	isTerminalStatus,
	findPlanCycle,
	validatePlan,
	computeReadyTasks,
	markTaskStatus,
	revisePlanTask,
	propagateBlocked,
	planProgress,
	type PianolaPlan,
	type PianolaTask as S2_PianolaTask,
	type PianolaTaskStatus,
} from '../../../shared/pianola/pianola-tasks';
import { parsePermissions } from '../../../shared/plugins/permissions';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';
import {
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	FIRST_PARTY_PLUGINS,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN_PERMISSIONS,
	PIANOLA_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../shared/plugins/first-party';
import {
	selectAgentForTask,
	type AgentCandidate,
} from '../../../shared/pianola/pianola-agent-select';
import { DEFAULT_CAPABILITIES, type AgentCapabilities } from '../../../shared/types';
import type { PianolaTask as S4_PianolaTask } from '../../../shared/pianola/pianola-tasks';
import type { SessionHistoryMessage } from '../../../main/web-server/types';
import type { PianolaMessage as S5_PianolaMessage } from '../../../shared/pianola/types';
// Source: src/__tests__/shared/pianola/pianola-watcher.test.ts
describe('', () => {
	let seq = 0;
	function assistant(content: string): S1_PianolaMessage {
		seq += 1;
		return {
			id: `m${seq}`,
			role: 'assistant',
			source: 'ai',
			content,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		};
	}
	function autoAnswerRule(): PianolaRule {
		return {
			id: 'rule-1',
			enabled: true,
			scope: 'global',
			match: { maxRisk: 'low', kinds: ['question'] },
			action: 'auto_answer',
			answer: 'Use tabs.',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
	}
	function makeDeps(over: Partial<WatchDeps> = {}): {
		deps: WatchDeps;
		records: PianolaDecisionRecord[];
		dispatch: ReturnType<typeof vi.fn>;
	} {
		const records: PianolaDecisionRecord[] = [];
		let idCounter = 0;
		const dispatch = vi.fn(async () => ({
			success: true as boolean,
			error: undefined as string | undefined,
		}));
		const deps: WatchDeps = {
			readRules: () => [],
			dispatch,
			recordDecision: (r) => records.push(r),
			now: () => '2026-01-01T00:00:00.000Z',
			genId: () => {
				idCounter += 1;
				return `decision-${idCounter}`;
			},
			log: () => {},
			...over,
		};
		return { deps, records, dispatch };
	}
	function escalateRule(): PianolaRule {
		return {
			id: 'rule-esc',
			enabled: true,
			scope: 'global',
			match: { kinds: ['question'] },
			action: 'escalate',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
	}
	function profileEntry(): PianolaProfileEntry {
		return {
			profile: 'Auto-approves tests, builds, reads. Cautious about deletes and prod.',
			updatedAt: 1,
			pairCount: 10,
		};
	}
	/** Wire the optional handoff deps so the thought-based path is active. */
	function withHandoff(
		over: Partial<WatchDeps> = {},
		profile: PianolaProfileEntry | null = profileEntry()
	): {
		deps: WatchDeps;
		records: PianolaDecisionRecord[];
		requestJudgment: ReturnType<typeof vi.fn>;
	} {
		const requestJudgment = vi.fn(async () => ({
			success: true as boolean,
			error: undefined as string | undefined,
		}));
		const base = makeDeps({
			resolveProfile: () => profile,
			requestJudgment,
			...over,
		});
		return { deps: base.deps, records: base.records, requestJudgment };
	}
	const target: WatchTarget = { tabId: 'tab-1', agentId: 'agent-1' };
	describe('runWatchIteration - basics', () => {
		it('does nothing for a non-actionable transcript', async () => {
			const { deps, records, dispatch } = makeDeps();
			const { result } = await runWatchIteration(
				[assistant('All tests pass and the build is green.')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.acted).toBe(false);
			expect(records).toHaveLength(0);
			expect(dispatch).not.toHaveBeenCalled();
		});
		it('escalates and records once when no rule matches', async () => {
			const { deps, records, dispatch } = makeDeps();
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.decision?.action).toBe('escalate');
			expect(dispatch).not.toHaveBeenCalled();
			expect(records).toHaveLength(1);
		});
		it('dry-run never dispatches but records the decision', async () => {
			const { deps, records, dispatch } = makeDeps({ readRules: () => [autoAnswerRule()] });
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: true }
			);
			expect(result.decision?.action).toBe('auto_answer');
			expect(dispatch).not.toHaveBeenCalled();
			expect(records).toHaveLength(1);
			expect(records[0].dryRun).toBe(true);
			expect(records[0].dispatched).toBe(false);
		});
	});
	describe('runWatchIteration - auto-answer dispatch', () => {
		it('writes an audit record before dispatching, then an outcome record', async () => {
			const order: string[] = [];
			const dispatch = vi.fn(async () => {
				order.push('dispatch');
				return { success: true, error: undefined };
			});
			const { deps, records } = makeDeps({
				readRules: () => [autoAnswerRule()],
				dispatch,
				recordDecision: () => order.push('record'),
			});
			await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			// Audit (intent) must be persisted before the message is sent.
			expect(order).toEqual(['record', 'dispatch', 'record']);
			void records;
			expect(dispatch).toHaveBeenCalledWith(target, 'Use tabs.');
		});
		it('records intent and a dispatched outcome under one id', async () => {
			const { deps, records } = makeDeps({ readRules: () => [autoAnswerRule()] });
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(records).toHaveLength(2);
			expect(records[0].id).toBe(records[1].id); // same id, folded by readers
			expect(records[0].dispatched).toBe(false); // intent
			expect(records[1].dispatched).toBe(true); // outcome
			expect(result.dispatched).toBe(true);
		});
		it('does not dispatch if the pre-dispatch audit write fails (fails closed)', async () => {
			const dispatch = vi.fn(async () => ({ success: true, error: undefined }));
			const deps = makeDeps({
				readRules: () => [autoAnswerRule()],
				dispatch,
				recordDecision: () => {
					throw new Error('disk full');
				},
			}).deps;
			await expect(
				runWatchIteration(
					[assistant('Should I name it count or total?')],
					target,
					initialWatchState(),
					deps,
					{
						dryRun: false,
					}
				)
			).rejects.toThrow('disk full');
			expect(dispatch).not.toHaveBeenCalled();
		});
	});
	describe('runWatchIteration - dedup and retry', () => {
		it('does not re-handle the same prompt after a successful decision', async () => {
			const { deps, records } = makeDeps();
			const messages = [assistant('Should I deploy to production?')];
			const first = await runWatchIteration(messages, target, initialWatchState(), deps, {
				dryRun: false,
			});
			expect(first.result.acted).toBe(true);
			const second = await runWatchIteration(messages, target, first.state, deps, {
				dryRun: false,
			});
			expect(second.result.acted).toBe(false);
			expect(second.result.skipped).toContain('already handled');
			expect(records).toHaveLength(1);
		});
		it('retries a failed dispatch on subsequent polls, then gives up at the cap', async () => {
			const dispatch = vi.fn(async () => ({ success: false, error: 'session busy' }));
			const { deps } = makeDeps({ readRules: () => [autoAnswerRule()], dispatch });
			const messages = [assistant('Should I name it count or total?')];
			let state: WatchState = initialWatchState();
			// First MAX-1 failures keep retrying (cursor not advanced).
			for (let attempt = 1; attempt < MAX_DISPATCH_ATTEMPTS; attempt += 1) {
				const out = await runWatchIteration(messages, target, state, deps, { dryRun: false });
				state = out.state;
				expect(state.lastHandledMessageId).toBeNull();
				expect(state.pendingRetry?.attempts).toBe(attempt);
			}
			// The capping attempt gives up: cursor advances, retry cleared.
			const final = await runWatchIteration(messages, target, state, deps, { dryRun: false });
			expect(final.state.pendingRetry).toBeNull();
			expect(final.state.lastHandledMessageId).toBe('m' + seq);
			expect(dispatch).toHaveBeenCalledTimes(MAX_DISPATCH_ATTEMPTS);
			// After giving up, the same prompt is skipped.
			const skipped = await runWatchIteration(messages, target, final.state, deps, {
				dryRun: false,
			});
			expect(skipped.result.skipped).toContain('already handled');
			expect(dispatch).toHaveBeenCalledTimes(MAX_DISPATCH_ATTEMPTS);
		});
		it('records the dispatch error on the outcome entry', async () => {
			const dispatch = vi.fn(async () => ({ success: false, error: 'session busy' }));
			const { deps, records } = makeDeps({ readRules: () => [autoAnswerRule()], dispatch });
			await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			const outcome = records[records.length - 1];
			expect(outcome.dispatched).toBe(false);
			expect(outcome.error).toBe('session busy');
		});
	});
	describe('runWatchIteration - thought-based handoff', () => {
		it('hands an uncovered, non-high-risk ask to Pianola when a profile exists', async () => {
			const { deps, requestJudgment } = withHandoff();
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoff).toBe(true);
			expect(result.decision?.action).toBe('escalate');
			expect(requestJudgment).toHaveBeenCalledTimes(1);
			const req = requestJudgment.mock.calls[0][0];
			expect(req.profile).toEqual(profileEntry());
			expect(req.promptText).toContain('count or total');
		});
		it('uses the profile and escalates normally when memory recall fails', async () => {
			const { deps, requestJudgment } = withHandoff({
				resolveContext: async () => {
					throw new Error('memory offline');
				},
			});
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoff).toBe(true);
			expect(requestJudgment).toHaveBeenCalledWith(
				expect.objectContaining({ profile: profileEntry(), context: undefined })
			);
		});
		it('does not re-hand-off while awaiting Pianola, and tracks a pending handoff', async () => {
			const { deps, requestJudgment } = withHandoff();
			const messages = [assistant('Should I name it count or total?')];
			const first = await runWatchIteration(messages, target, initialWatchState(), deps, {
				dryRun: false,
			});
			expect(first.state.pendingHandoff?.messageId).toBeTruthy();
			const second = await runWatchIteration(messages, target, first.state, deps, {
				dryRun: false,
			});
			expect(second.result.skipped).toContain('awaiting Pianola');
			expect(requestJudgment).toHaveBeenCalledTimes(1); // not handed off again
			expect(second.state.pendingHandoff?.polls).toBe(1);
		});
		it('escalates to the user when a pending handoff times out', async () => {
			const notify = vi.fn();
			const { deps } = withHandoff({ notify });
			const messages = [assistant('Should I name it count or total?')];
			let out = await runWatchIteration(messages, target, initialWatchState(), deps, {
				dryRun: false,
			});
			// Poll until the timeout fires.
			for (let i = 0; i < HANDOFF_TIMEOUT_POLLS; i += 1) {
				out = await runWatchIteration(messages, target, out.state, deps, { dryRun: false });
			}
			expect(out.result.handoffTimedOut).toBe(true);
			expect(out.result.decision?.action).toBe('escalate');
			expect(out.result.decision?.reason).toContain('timed out');
			expect(out.state.pendingHandoff).toBeNull();
			expect(notify).toHaveBeenCalled();
		});
		it('records intent before the handoff side effect, then an outcome (one id)', async () => {
			const order: string[] = [];
			const requestJudgment = vi.fn(async () => {
				order.push('handoff');
				return { success: true, error: undefined };
			});
			const records: PianolaDecisionRecord[] = [];
			const { deps } = makeDeps({
				resolveProfile: () => profileEntry(),
				requestJudgment,
				recordDecision: (r) => {
					order.push('record');
					records.push(r);
				},
			});
			await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(order).toEqual(['record', 'handoff', 'record']);
			expect(records).toHaveLength(2);
			expect(records[0].id).toBe(records[1].id);
			expect(records[1].dispatched).toBe(false); // a handoff never answers the watched tab
		});
		it('falls back to a user escalation (audited + notified) when handoff delivery fails', async () => {
			const requestJudgment = vi.fn(async () => ({ success: false, error: 'pianola busy' }));
			const notify = vi.fn();
			const { deps, records } = withHandoff({ requestJudgment, notify });
			const { result, state } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoffFailed).toBe(true);
			expect(result.handoff).toBeFalsy();
			expect(result.decision?.action).toBe('escalate');
			expect(result.decision?.reason).toContain('escalated to user');
			expect(records[records.length - 1].error).toBe('pianola busy');
			expect(notify).toHaveBeenCalledTimes(1);
			// The ask is now fully handled (no pending handoff, cursor advanced).
			expect(state.pendingHandoff).toBeNull();
			expect(state.lastHandledMessageId).toBe('m' + seq);
		});
		it('does not crash the loop when notify itself throws', async () => {
			const requestJudgment = vi.fn(async () => ({ success: false, error: 'pianola busy' }));
			const notify = vi.fn(() => {
				throw new Error('toast bridge down');
			});
			const { deps } = withHandoff({ requestJudgment, notify });
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoffFailed).toBe(true);
			expect(result.notified).toBe(false); // notify threw, swallowed
		});
		it('does NOT hand off a high-risk ask; it escalates to the user', async () => {
			const { deps, records, requestJudgment } = withHandoff();
			const { result } = await runWatchIteration(
				[assistant('Should I deploy to production?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoff).toBeFalsy();
			expect(result.decision?.action).toBe('escalate');
			expect(requestJudgment).not.toHaveBeenCalled();
			expect(records).toHaveLength(1);
		});
		it('does NOT hand off when no profile exists; it escalates to the user', async () => {
			const { deps, records, requestJudgment } = withHandoff({}, null);
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoff).toBeFalsy();
			expect(requestJudgment).not.toHaveBeenCalled();
			expect(records).toHaveLength(1);
		});
		it('does NOT hand off when a rule already covers the ask (matchedRuleId set)', async () => {
			const { deps, requestJudgment } = withHandoff({ readRules: () => [escalateRule()] });
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoff).toBeFalsy();
			expect(result.decision?.matchedRuleId).toBe('rule-esc');
			expect(requestJudgment).not.toHaveBeenCalled();
		});
		it('does NOT hand off on a dry run', async () => {
			const { deps, requestJudgment } = withHandoff();
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: true }
			);
			expect(result.handoff).toBeFalsy();
			expect(requestJudgment).not.toHaveBeenCalled();
		});
		it('stays purely rule-driven when handoff deps are not wired', async () => {
			const { deps, records, dispatch } = makeDeps();
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoff).toBeFalsy();
			expect(result.decision?.action).toBe('escalate');
			expect(dispatch).not.toHaveBeenCalled();
			expect(records).toHaveLength(1);
		});
	});
	describe('runWatchIteration - escalation notifications', () => {
		it('fires a notification when a plain escalation reaches the user', async () => {
			const events: PianolaNotifyEvent[] = [];
			const { deps } = makeDeps({ notify: (e) => void events.push(e) });
			const { result } = await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.notified).toBe(true);
			expect(events).toHaveLength(1);
			expect(events[0].kind).toBe('escalate');
			expect(events[0].highRisk).toBe(false);
		});
		it('marks a high-risk escalation as highRisk for a sticky notification', async () => {
			const events: PianolaNotifyEvent[] = [];
			const { deps } = makeDeps({ notify: (e) => void events.push(e) });
			await runWatchIteration(
				[assistant('Should I deploy to production?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(events[0].highRisk).toBe(true);
		});
		it('does NOT notify on a dry run', async () => {
			const notify = vi.fn();
			const { deps } = makeDeps({ notify });
			await runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: true }
			);
			expect(notify).not.toHaveBeenCalled();
		});
	});
	describe('rehydrateWatchState', () => {
		function record(over: Partial<PianolaDecisionRecord>): PianolaDecisionRecord {
			return {
				id: 'r',
				timestamp: '2026-01-01T00:00:00.000Z',
				tabId: 'tab-1',
				agentId: 'agent-1',
				classification: {
					kind: 'question',
					risk: 'low',
					topic: 't',
					confidence: 'high',
					evidence: { messageId: 'mX', reason: 'r', structured: false },
				},
				decision: { action: 'escalate', matchedRuleId: null, reason: 'no rule' },
				dispatched: false,
				dryRun: false,
				...over,
			};
		}
		it('seeds the cursor from the most recent handled prompt for the tab', () => {
			const state = rehydrateWatchState(
				[
					record({
						classification: {
							...record({}).classification,
							evidence: { messageId: 'm1', reason: 'r', structured: false },
						},
					}),
					record({
						classification: {
							...record({}).classification,
							evidence: { messageId: 'm2', reason: 'r', structured: false },
						},
					}),
				],
				'tab-1'
			);
			expect(state.lastHandledMessageId).toBe('m2');
			expect(state.pendingHandoff).toBeNull();
		});
		it('ignores records for other tabs', () => {
			const state = rehydrateWatchState([record({ tabId: 'other' })], 'tab-1');
			expect(state.lastHandledMessageId).toBeNull();
		});
		it('restores a pending handoff so its timeout resumes after restart', () => {
			const state = rehydrateWatchState(
				[
					record({
						decision: {
							action: 'escalate',
							matchedRuleId: null,
							reason: 'handed off to Pianola for profile-based judgment',
						},
					}),
				],
				'tab-1'
			);
			expect(state.pendingHandoff?.messageId).toBe('mX');
			expect(state.lastHandledMessageId).toBeNull(); // kept behind so timeout can fire
		});
		it('does NOT restore a pending handoff for a failed handoff record', () => {
			const state = rehydrateWatchState(
				[
					record({
						decision: {
							action: 'escalate',
							matchedRuleId: null,
							reason: 'handoff to Pianola failed (busy); escalated to user',
						},
						error: 'busy',
					}),
				],
				'tab-1'
			);
			expect(state.pendingHandoff).toBeNull();
			expect(state.lastHandledMessageId).toBe('mX');
		});
		const autoAnswer = {
			action: 'auto_answer' as const,
			answer: 'Use tabs.',
			matchedRuleId: 'rule-1',
			reason: 'matched auto-answer rule',
		};
		it('does NOT adopt a failed (non-dry-run) auto_answer as the handled cursor', () => {
			const state = rehydrateWatchState(
				[record({ decision: autoAnswer, dispatched: false, dryRun: false, error: 'agent down' })],
				'tab-1'
			);
			// The dispatch failed, so the prompt was never answered: re-attempt on restart.
			expect(state.lastHandledMessageId).toBeNull();
			expect(state.pendingHandoff).toBeNull();
		});
		it('adopts a successfully dispatched auto_answer as the handled cursor', () => {
			const state = rehydrateWatchState(
				[record({ decision: autoAnswer, dispatched: true, dryRun: false })],
				'tab-1'
			);
			expect(state.lastHandledMessageId).toBe('mX');
		});
		it('adopts a dry-run auto_answer as the handled cursor (dry-run is not a failure)', () => {
			const state = rehydrateWatchState(
				[record({ decision: autoAnswer, dispatched: false, dryRun: true })],
				'tab-1'
			);
			expect(state.lastHandledMessageId).toBe('mX');
		});
	});
	describe('runWatchIteration - give-up escalates instead of abandoning', () => {
		it('records an escalate decision and notifies after the dispatch attempt cap', async () => {
			const notifyEvents: PianolaNotifyEvent[] = [];
			const dispatch = vi.fn(async () => ({
				success: false as boolean,
				error: 'down' as string | undefined,
			}));
			const { deps, records } = makeDeps({
				readRules: () => [autoAnswerRule()],
				dispatch,
				notify: async (e) => {
					notifyEvents.push(e);
					return true;
				},
			});
			const messages = [assistant('Should I name it count or total?')];
			let state = initialWatchState();
			let last: Awaited<ReturnType<typeof runWatchIteration>> | undefined;
			for (let i = 0; i < MAX_DISPATCH_ATTEMPTS; i += 1) {
				last = await runWatchIteration(messages, target, state, deps, { dryRun: false });
				state = last.state;
			}
			expect(last?.result.decision.action).toBe('escalate');
			expect(notifyEvents.some((e) => e.kind === 'handoff_failed')).toBe(true);
			expect(records.some((r) => r.decision.action === 'escalate')).toBe(true);
		});
	});
	describe('runWatchIteration - handoff resolution', () => {
		it('records the observed answer and clears the handoff when the agent advances', async () => {
			const { deps, records, requestJudgment } = withHandoff();
			const prompt = assistant('Should I name it count or total?');
			// Poll 1: uncovered, non-high-risk ask is handed off to Pianola.
			const first = await runWatchIteration([prompt], target, initialWatchState(), deps, {
				dryRun: false,
			});
			expect(first.result.handoff).toBe(true);
			expect(first.state.pendingHandoff?.messageId).toBe(prompt.id);
			expect(requestJudgment).toHaveBeenCalledTimes(1);
			// Poll 2: the agent advanced - Pianola's answer landed as a user message, so
			// the prompt is no longer awaiting. The handoff resolves and is audited with
			// the original ask's classification and the observed answer.
			const answer: S1_PianolaMessage = {
				id: 'm-answer',
				role: 'user',
				source: 'user',
				content: 'Use count',
				timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString(),
			};
			const second = await runWatchIteration([prompt, answer], target, first.state, deps, {
				dryRun: false,
			});
			expect(second.result.handoffResolved).toBe(true);
			expect(second.result.decision).toMatchObject({ action: 'auto_answer', answer: 'Use count' });
			expect(second.state.pendingHandoff).toBeNull();
			expect(second.state.lastHandledMessageId).toBe(prompt.id);
			expect(requestJudgment).toHaveBeenCalledTimes(1); // not re-handed-off on resolution
			const last = records[records.length - 1];
			expect(last.classification.kind).toBe('question'); // original ask, not 'none'
			expect(last.decision.action).toBe('auto_answer');
			expect(last.dispatched).toBe(true);
		});
		it('does not record a resolution when no handoff is pending', async () => {
			const { deps, records } = makeDeps();
			const { result, state } = await runWatchIteration(
				[assistant('All tests pass and the build is green.')],
				target,
				initialWatchState(),
				deps,
				{ dryRun: false }
			);
			expect(result.handoffResolved).toBeUndefined();
			expect(result.acted).toBe(false);
			expect(records).toHaveLength(0);
			expect(state.pendingHandoff).toBeNull();
		});
	});
	describe('watch idle retirement', () => {
		const HOUR = 3600000;
		const msg = (id: string, timestamp: string): S1_PianolaMessage => ({
			id,
			role: 'assistant',
			source: 'ai',
			content: 'done',
			timestamp,
		});
		it('takes the newest message timestamp, floored at the watch start', () => {
			const t1 = Date.parse('2026-01-01T00:00:00.000Z');
			const t2 = Date.parse('2026-01-01T05:00:00.000Z');
			const messages = [msg('a', new Date(t1).toISOString()), msg('b', new Date(t2).toISOString())];
			expect(lastWatchActivityMs(messages, 0)).toBe(t2);
			expect(lastWatchActivityMs(messages, t2 + HOUR)).toBe(t2 + HOUR);
			expect(lastWatchActivityMs([msg('c', 'not a date')], 42)).toBe(42);
		});
		it('expires only after the idle window with nothing in flight', () => {
			const state = initialWatchState();
			expect(isWatchIdleExpired(state, 0, 6 * HOUR - 1, 6 * HOUR)).toBe(false);
			expect(isWatchIdleExpired(state, 0, 6 * HOUR, 6 * HOUR)).toBe(true);
		});
		it('never expires while a handoff or retry is pending, or when disabled', () => {
			const handoff: WatchState = {
				...initialWatchState(),
				pendingHandoff: {
					messageId: 'm1',
					polls: 1,
					classification: { kind: 'question', risk: 'low', topic: 't' },
				} as WatchState['pendingHandoff'],
			};
			const retry: WatchState = {
				...initialWatchState(),
				pendingRetry: { messageId: 'm1', attempts: 1 },
			};
			expect(isWatchIdleExpired(handoff, 0, 100 * HOUR, HOUR)).toBe(false);
			expect(isWatchIdleExpired(retry, 0, 100 * HOUR, HOUR)).toBe(false);
			expect(isWatchIdleExpired(initialWatchState(), 0, 100 * HOUR, 0)).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-tasks.test.ts
describe('', () => {
	function task(overrides: Partial<S2_PianolaTask> = {}): S2_PianolaTask {
		return {
			id: 't1',
			title: 'Task 1',
			prompt: 'Do the thing.',
			dependsOn: [],
			status: 'pending',
			...overrides,
		};
	}
	function plan(tasks: S2_PianolaTask[], overrides: Partial<PianolaPlan> = {}): PianolaPlan {
		return {
			id: 'plan-1',
			title: 'Plan 1',
			createdAt: 1000,
			tasks,
			...overrides,
		};
	}
	/** Build a raw (untrusted-shaped) plan object for validatePlan. */
	function rawPlan(
		tasks: unknown[],
		overrides: Record<string, unknown> = {}
	): Record<string, unknown> {
		return { id: 'plan-1', title: 'Plan 1', createdAt: 1000, tasks, ...overrides };
	}
	function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 't1',
			title: 'Task 1',
			prompt: 'Do the thing.',
			dependsOn: [],
			status: 'pending',
			...overrides,
		};
	}
	describe('isTerminalStatus', () => {
		it.each<[PianolaTaskStatus, boolean]>([
			['done', true],
			['failed', true],
			['skipped', true],
			['pending', false],
			['running', false],
			['blocked', false],
		])('%s -> %s', (status, expected) => {
			expect(isTerminalStatus(status)).toBe(expected);
		});
	});
	describe('validatePlan', () => {
		it('rejects negative fix attempts that would extend the charter retry budget', () => {
			const result = validatePlan(rawPlan([rawTask({ fixAttempts: -1 })]));
			expect(result.plan).toBeNull();
			expect(result.errors.some((error) => error.includes('fixAttempts'))).toBe(true);
		});
		it('accepts a good linear plan', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([
					rawTask({ id: 'a', dependsOn: [] }),
					rawTask({ id: 'b', dependsOn: ['a'] }),
					rawTask({ id: 'c', dependsOn: ['b'] }),
				])
			);
			expect(errors).toEqual([]);
			expect(result).not.toBeNull();
			expect(result?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
		});
		it('accepts a diamond DAG', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([
					rawTask({ id: 'a', dependsOn: [] }),
					rawTask({ id: 'b', dependsOn: ['a'] }),
					rawTask({ id: 'c', dependsOn: ['a'] }),
					rawTask({ id: 'd', dependsOn: ['b', 'c'] }),
				])
			);
			expect(errors).toEqual([]);
			expect(result?.tasks).toHaveLength(4);
		});
		it('preserves valid optional fields and drops absent ones', () => {
			const { plan: result } = validatePlan(
				rawPlan([rawTask({ id: 'a', agentId: 'agent-7', tabId: 'tab-3' })])
			);
			const t = result?.tasks[0];
			expect(t?.agentId).toBe('agent-7');
			expect(t?.tabId).toBe('tab-3');
			expect(t?.agentType).toBeUndefined();
		});
		it('round-trips acceptance and physical run bindings through recovery validation', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([
					rawTask({
						id: 'a',
						runId: 'acceptance',
						executionRunId: 'fix-execution',
						fixAttempts: 2,
						requiredChecks: ['build', 'acceptance'],
						completionCursor: 'reply:42',
						holdReason: 'acceptance',
					}),
				])
			);
			expect(errors).toEqual([]);
			expect(result?.tasks[0]).toMatchObject({
				runId: 'acceptance',
				executionRunId: 'fix-execution',
				fixAttempts: 2,
				requiredChecks: ['build', 'acceptance'],
				completionCursor: 'reply:42',
				holdReason: 'acceptance',
			});
		});
		it.each([
			{ requiredChecks: [''] },
			{ requiredChecks: [42] },
			{ runId: 42 },
			{ executionRunId: {} },
			{ fixAttempts: -1 },
			{ fixAttempts: 0.5 },
			{ holdReason: 'unexpected' },
			{ holdReason: 42 },
		])('rejects malformed acceptance/runtime fields %j', (patch) => {
			const { plan: result, errors } = validatePlan(rawPlan([rawTask({ id: 'a', ...patch })]));
			expect(result).toBeNull();
			expect(errors.length).toBeGreaterThan(0);
		});
		it('rejects an unknown dependency and reports it', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([rawTask({ id: 'a', dependsOn: ['ghost'] })])
			);
			expect(result).toBeNull();
			expect(errors.some((e) => e.includes('unknown task "ghost"'))).toBe(true);
		});
		it('rejects a self dependency and reports it', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([rawTask({ id: 'a', dependsOn: ['a'] })])
			);
			expect(result).toBeNull();
			expect(errors.some((e) => e.includes('depends on itself'))).toBe(true);
		});
		it('rejects a task with missing/invalid fields', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([rawTask({ id: 'a', title: '', status: 'bogus' })])
			);
			expect(result).toBeNull();
			expect(errors.length).toBeGreaterThan(0);
		});
		it('rejects a cycle and reports the cycle path', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([
					rawTask({ id: 'a', dependsOn: ['c'] }),
					rawTask({ id: 'b', dependsOn: ['a'] }),
					rawTask({ id: 'c', dependsOn: ['b'] }),
				])
			);
			expect(result).toBeNull();
			const cycleError = errors.find((e) => e.includes('dependency cycle'));
			expect(cycleError).toBeDefined();
			// All three nodes appear in the reported cycle.
			expect(cycleError).toContain('a');
			expect(cycleError).toContain('b');
			expect(cycleError).toContain('c');
		});
		it('rejects non-record input', () => {
			expect(validatePlan(null).plan).toBeNull();
			expect(validatePlan('plan').plan).toBeNull();
			expect(validatePlan([]).plan).toBeNull();
		});
		it('rejects missing top-level fields', () => {
			expect(validatePlan(rawPlan([], { id: '' })).plan).toBeNull();
			expect(validatePlan(rawPlan([], { title: undefined })).plan).toBeNull();
			expect(validatePlan(rawPlan([], { createdAt: 'soon' })).plan).toBeNull();
			expect(validatePlan({ id: 'x', title: 'y', createdAt: 1 }).plan).toBeNull(); // tasks not array
		});
		it('rejects duplicate task ids', () => {
			const { plan: result, errors } = validatePlan(
				rawPlan([rawTask({ id: 'a' }), rawTask({ id: 'a' })])
			);
			expect(result).toBeNull();
			expect(errors.some((e) => e.includes('Duplicate task id'))).toBe(true);
		});
		it('accepts an empty task list', () => {
			const { plan: result, errors } = validatePlan(rawPlan([]));
			expect(errors).toEqual([]);
			expect(result?.tasks).toEqual([]);
		});
	});
	describe('findPlanCycle', () => {
		it('returns null for an acyclic diamond', () => {
			expect(
				findPlanCycle([
					task({ id: 'a', dependsOn: [] }),
					task({ id: 'b', dependsOn: ['a'] }),
					task({ id: 'c', dependsOn: ['a'] }),
					task({ id: 'd', dependsOn: ['b', 'c'] }),
				])
			).toBeNull();
		});
		it('finds a 3-node cycle as an ordered id list', () => {
			const cycle = findPlanCycle([
				task({ id: 'a', dependsOn: ['c'] }),
				task({ id: 'b', dependsOn: ['a'] }),
				task({ id: 'c', dependsOn: ['b'] }),
			]);
			expect(cycle).not.toBeNull();
			expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
			expect(cycle).toHaveLength(3);
		});
		it('does not treat unknown dependency ids as edges', () => {
			expect(
				findPlanCycle([
					task({ id: 'a', dependsOn: ['ghost'] }),
					task({ id: 'b', dependsOn: ['a'] }),
				])
			).toBeNull();
		});
	});
	describe('computeReadyTasks', () => {
		it('returns pending tasks whose deps are all done', () => {
			const p = plan([
				task({ id: 'a', status: 'done', dependsOn: [] }),
				task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
				task({ id: 'c', status: 'pending', dependsOn: ['b'] }),
			]);
			expect(computeReadyTasks(p).map((t) => t.id)).toEqual(['b']);
		});
		it('treats a task with no deps as ready', () => {
			const p = plan([task({ id: 'a', status: 'pending', dependsOn: [] })]);
			expect(computeReadyTasks(p).map((t) => t.id)).toEqual(['a']);
		});
		it('does not mark a task ready when a dep failed or was skipped', () => {
			const p = plan([
				task({ id: 'a', status: 'failed', dependsOn: [] }),
				task({ id: 'b', status: 'skipped', dependsOn: [] }),
				task({ id: 'c', status: 'pending', dependsOn: ['a'] }),
				task({ id: 'd', status: 'pending', dependsOn: ['b'] }),
			]);
			expect(computeReadyTasks(p)).toEqual([]);
		});
		it('respects a diamond: the join only readies when both arms are done', () => {
			const partial = plan([
				task({ id: 'a', status: 'done', dependsOn: [] }),
				task({ id: 'b', status: 'done', dependsOn: ['a'] }),
				task({ id: 'c', status: 'pending', dependsOn: ['a'] }),
				task({ id: 'd', status: 'pending', dependsOn: ['b', 'c'] }),
			]);
			expect(computeReadyTasks(partial).map((t) => t.id)).toEqual(['c']);
			const ready = plan([
				task({ id: 'a', status: 'done', dependsOn: [] }),
				task({ id: 'b', status: 'done', dependsOn: ['a'] }),
				task({ id: 'c', status: 'done', dependsOn: ['a'] }),
				task({ id: 'd', status: 'pending', dependsOn: ['b', 'c'] }),
			]);
			expect(computeReadyTasks(ready).map((t) => t.id)).toEqual(['d']);
		});
	});
	describe('markTaskStatus', () => {
		it('returns a new plan and does not mutate the input', () => {
			const original = plan([task({ id: 'a', status: 'pending' })]);
			const next = markTaskStatus(original, 'a', 'running');
			expect(next).not.toBe(original);
			expect(next.tasks).not.toBe(original.tasks);
			expect(original.tasks[0].status).toBe('pending');
			expect(next.tasks[0].status).toBe('running');
		});
		it('merges the optional patch fields', () => {
			const original = plan([task({ id: 'a', status: 'pending' })]);
			const next = markTaskStatus(original, 'a', 'running', {
				tabId: 'tab-1',
				agentId: 'agent-9',
			});
			expect(next.tasks[0]).toMatchObject({
				status: 'running',
				tabId: 'tab-1',
				agentId: 'agent-9',
			});
			// Original untouched.
			expect(original.tasks[0].tabId).toBeUndefined();
		});
		it('records an error via the patch on failure', () => {
			const original = plan([task({ id: 'a', status: 'running' })]);
			const next = markTaskStatus(original, 'a', 'failed', { error: 'boom' });
			expect(next.tasks[0].status).toBe('failed');
			expect(next.tasks[0].error).toBe('boom');
		});
		it('is a no-op clone when the task id is not found', () => {
			const original = plan([task({ id: 'a', status: 'pending' })]);
			const next = markTaskStatus(original, 'missing', 'done');
			expect(next).not.toBe(original);
			expect(next.tasks.map((t) => t.status)).toEqual(['pending']);
		});
	});
	describe('propagateBlocked', () => {
		it('blocks a pending task whose direct dependency failed', () => {
			const p = plan([
				task({ id: 'a', status: 'failed', dependsOn: [] }),
				task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
			]);
			const next = propagateBlocked(p);
			expect(next.tasks.find((t) => t.id === 'b')?.status).toBe('blocked');
		});
		it('cascades through a chain to a fixed point', () => {
			const p = plan([
				task({ id: 'a', status: 'failed', dependsOn: [] }),
				task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
				task({ id: 'c', status: 'pending', dependsOn: ['b'] }),
				task({ id: 'd', status: 'pending', dependsOn: ['c'] }),
			]);
			const next = propagateBlocked(p);
			expect(next.tasks.map((t) => t.status)).toEqual(['failed', 'blocked', 'blocked', 'blocked']);
		});
		it('blocks via a skipped dependency too', () => {
			const p = plan([
				task({ id: 'a', status: 'skipped', dependsOn: [] }),
				task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
			]);
			expect(propagateBlocked(p).tasks.find((t) => t.id === 'b')?.status).toBe('blocked');
		});
		it('does not block a running task or a terminal task', () => {
			const p = plan([
				task({ id: 'a', status: 'failed', dependsOn: [] }),
				task({ id: 'b', status: 'running', dependsOn: ['a'] }),
				task({ id: 'c', status: 'done', dependsOn: ['a'] }),
			]);
			const next = propagateBlocked(p);
			expect(next.tasks.find((t) => t.id === 'b')?.status).toBe('running');
			expect(next.tasks.find((t) => t.id === 'c')?.status).toBe('done');
		});
		it('leaves a healthy plan untouched and does not mutate input', () => {
			const p = plan([
				task({ id: 'a', status: 'done', dependsOn: [] }),
				task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
			]);
			const next = propagateBlocked(p);
			expect(next.tasks.map((t) => t.status)).toEqual(['done', 'pending']);
			expect(p.tasks[1].status).toBe('pending');
		});
	});
	describe('revisePlanTask', () => {
		it.each(['needs_review', 'failed'] as const)(
			'requeues %s work without changing completed tasks or its oracle',
			(status) => {
				const done = task({ id: 'done', status: 'done', runId: 'verified-run' });
				const reviewed = task({
					id: 'reviewed',
					status,
					dependsOn: ['done'],
					agentId: 'engineer',
					agentType: 'codex',
					cwd: '/product',
					tabId: 'old-tab',
					runId: 'old-run',
					error: 'wrong answer',
					fixAttempts: 2,
					validationUnknownAttempts: 2,
					dispatchedMessageCount: 5,
					dispatchedMessageId: 'old-message',
					validation: {
						command: ['python3', 'oracle.py'],
						target: '/product',
						artifacts: ['answer.txt'],
					},
				});
				const original = plan([done, reviewed], { programId: 'product' });
				const revised = revisePlanTask(original, 'reviewed', 'Use the founder-approved answer.');
				expect(revised).toEqual({
					...original,
					tasks: [
						done,
						{
							id: 'reviewed',
							title: reviewed.title,
							status: 'pending',
							dependsOn: ['done'],
							prompt: 'Use the founder-approved answer.',
							agentId: 'engineer',
							agentType: 'codex',
							cwd: '/product',
							validation: reviewed.validation,
						},
					],
				});
				expect(computeReadyTasks(revised).map((entry) => entry.id)).toEqual(['reviewed']);
				expect(original.tasks[1]).toEqual(reviewed);
			}
		);
		it('uses a distinct supplied identity for a reopened attempt', () => {
			const original = plan([task({ id: 'reviewed', status: 'failed', runId: 'old-run' })]);
			const revised = revisePlanTask(original, 'reviewed', 'Correct the work.', 'new-run');
			expect(revised.tasks[0]).toMatchObject({ status: 'pending', runId: 'new-run' });
			expect(revised.tasks[0].runId).not.toBe(original.tasks[0].runId);
		});
		it('reopens only descendants whose remaining prerequisites are no longer blocked', () => {
			const original = plan([
				task({ id: 'tail', status: 'blocked', dependsOn: ['child'], error: 'upstream failed' }),
				task({ id: 'child', status: 'blocked', dependsOn: ['reviewed'] }),
				task({ id: 'reviewed', status: 'failed' }),
				task({ id: 'other', status: 'failed' }),
				task({
					id: 'shared',
					status: 'blocked',
					dependsOn: ['reviewed', 'other'],
					error: 'other failed',
				}),
				task({ id: 'unrelated', status: 'blocked', dependsOn: ['other'] }),
			]);
			const revised = revisePlanTask(original, 'reviewed', 'Correct the work.');
			expect(revised.tasks.map((entry) => [entry.id, entry.status])).toEqual([
				['tail', 'pending'],
				['child', 'pending'],
				['reviewed', 'pending'],
				['other', 'failed'],
				['shared', 'blocked'],
				['unrelated', 'blocked'],
			]);
			expect(revised.tasks[0].error).toBeUndefined();
			expect(revised.tasks[4]).toEqual(original.tasks[4]);
		});
		it.each(['pending', 'running', 'fixing', 'done', 'skipped', 'blocked'] as const)(
			'refuses to revise %s work',
			(status) => {
				const original = plan([task({ status })]);
				expect(() => revisePlanTask(original, 't1', 'Correction')).toThrow();
				expect(original.tasks[0].status).toBe(status);
			}
		);
		it('rejects missing tasks and empty corrections', () => {
			const original = plan([task({ status: 'needs_review' })]);
			expect(() => revisePlanTask(original, 'absent', 'Correction')).toThrow();
			expect(() => revisePlanTask(original, 't1', '  ')).toThrow();
		});
	});
	describe('planProgress', () => {
		it('counts tasks by status', () => {
			const p = plan([
				task({ id: 'a', status: 'done' }),
				task({ id: 'b', status: 'running' }),
				task({ id: 'c', status: 'pending' }),
				task({ id: 'd', status: 'failed' }),
				task({ id: 'e', status: 'blocked' }),
				task({ id: 'f', status: 'skipped' }),
			]);
			expect(planProgress(p)).toEqual({
				total: 6,
				pending: 1,
				running: 1,
				needs_review: 0,
				fixing: 0,
				done: 1,
				failed: 1,
				blocked: 1,
				skipped: 1,
				complete: false,
			});
		});
		it('is not complete while a task can still run', () => {
			const p = plan([
				task({ id: 'a', status: 'done' }),
				task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
			]);
			expect(planProgress(p).complete).toBe(false);
		});
		it('is complete when every task is terminal or blocked', () => {
			const p = plan([
				task({ id: 'a', status: 'done' }),
				task({ id: 'b', status: 'failed' }),
				task({ id: 'c', status: 'skipped' }),
				task({ id: 'd', status: 'blocked' }),
			]);
			expect(planProgress(p).complete).toBe(true);
		});
		it('treats an empty plan as complete', () => {
			expect(planProgress(plan([])).complete).toBe(true);
		});
	});
	describe('task validation specs', () => {
		it('preserves a valid oracle through plan validation and rejects missing commands', () => {
			const validation = {
				command: ['pytest', '-q'],
				target: '/workspace',
				artifacts: ['result.txt'],
			};
			expect(validatePlan(rawPlan([rawTask({ validation })])).plan?.tasks[0].validation).toEqual(
				validation
			);
			const absent = validatePlan(rawPlan([rawTask()]));
			expect(absent.errors).toEqual([]);
			expect(absent.plan?.tasks[0].validation).toBeUndefined();
			const invalid = validatePlan(rawPlan([rawTask({ validation: { target: '/workspace' } })]));
			expect(invalid.plan).toBeNull();
			expect(invalid.errors.some((error) => error.includes('validation'))).toBe(true);
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-first-party-plugin.test.ts
describe('', () => {
	describe('Pianola first-party plugin definition', () => {
		it('declares Pianola as a first-party plugin-backed agents extension', () => {
			expect(PIANOLA_FIRST_PARTY_PLUGIN_ID).toBe('com.maestro.pianola');
			expect(PIANOLA_FIRST_PARTY_PLUGIN).toMatchObject({
				id: PIANOLA_FIRST_PARTY_PLUGIN_ID,
				name: 'Pianola',
				firstParty: true,
				category: 'agents',
				settingsNamespace: 'pianola',
				encoreFlag: 'pianola',
				backgroundServices: [{ id: 'pianola.supervisor', kind: 'supervised' }],
			});
			expect(FIRST_PARTY_PLUGINS.pianola).toBe(PIANOLA_FIRST_PARTY_PLUGIN);
		});
		it('requests only valid broker capabilities used by the supervised Pianola flow', () => {
			const parsed = parsePermissions(PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS);
			expect(parsed.errors).toEqual([]);
			// `agents:dispatch` is deliberately NOT declared: FC2 promoted it to an
			// allowlist scope naming exact targets, which a static manifest cannot
			// name for Pianola's dynamically-discovered sessions. Pianola dispatch
			// stays host-owned until the plugin lift designs a runtime grant seam
			// (see first-party.ts NOTE).
			expect(parsed.requests.map((p) => p.capability)).toEqual([
				'settings:read',
				'agents:read',
				'transcripts:read',
				'decisions:write',
				'notifications:toast',
				'background:service',
			]);
			expect(
				parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)
			).toBe(true);
		});
	});
	/**
	 * The usage guide the Extensions details pane renders. It lives on the
	 * definition (not inline in the view), so these guard what the pane assumes:
	 * a non-empty overview, a walkthrough whose steps say something, and agent
	 * commands that name real `maestro pianola` verbs rather than an invented
	 * binary.
	 */
	describe('Pianola usage guide', () => {
		const usage = PIANOLA_FIRST_PARTY_PLUGIN.usage;
		it('ships an overview and an ordered walkthrough', () => {
			expect(usage).toBeDefined();
			expect(usage!.overview.length).toBeGreaterThan(0);
			expect(usage!.overview.every((p) => p.trim().length > 0)).toBe(true);
			expect(usage!.steps?.length ?? 0).toBeGreaterThan(0);
			for (const step of usage!.steps ?? []) {
				expect(step.title.trim()).not.toBe('');
				expect(step.body.trim()).not.toBe('');
			}
		});
		it('says how to reach the manager, since Pianola has no hotkey', () => {
			const access = usage!.access ?? [];
			expect(access.length).toBeGreaterThan(0);
			// No shortcutId anywhere: the pane resolves one to a live binding, and
			// naming an id that DEFAULT_SHORTCUTS does not carry would render nothing.
			expect(access.every((path) => path.shortcutId === undefined)).toBe(true);
			expect(access.some((path) => path.commandPalette || path.menu)).toBe(true);
		});
		it('states the two safety guarantees the policy engine actually enforces', () => {
			const notes = (usage!.notes ?? []).join(' ').toLowerCase();
			// High-risk always escalates, and an unmatched prompt escalates rather
			// than being answered. Both are load-bearing claims - if the engine ever
			// stops honoring them, this copy becomes a lie.
			expect(notes).toContain('high-risk');
			expect(notes).toContain('escalate');
		});
		it('documents agent commands under the maestro pianola namespace', () => {
			const commands = usage!.agentCommands ?? [];
			expect(commands.length).toBeGreaterThan(0);
			for (const entry of commands) {
				expect(entry.command.startsWith('maestro pianola ')).toBe(true);
				expect(entry.label.trim()).not.toBe('');
			}
		});
		it('has no em-dashes or en-dashes in user-facing copy', () => {
			const all = [
				...usage!.overview,
				...(usage!.steps ?? []).flatMap((s) => [s.title, s.body]),
				...(usage!.notes ?? []),
				...(usage!.access ?? []).flatMap((a) => [a.label, a.commandPalette ?? '', a.menu ?? '']),
				...(usage!.agentCommands ?? []).flatMap((c) => [c.label, c.command]),
			].join(' ');
			expect(all).not.toMatch(/[\u2013\u2014]/);
		});
	});
	describe('Groups+ first-party plugin definition', () => {
		it('declares Groups+ as an opt-in first-party UI extension', () => {
			expect(GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID).toBe('com.maestro.groups-plus');
			expect(GROUPS_PLUS_FIRST_PARTY_PLUGIN).toMatchObject({
				id: GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID,
				name: 'Groups+',
				firstParty: true,
				category: 'ui',
				settingsNamespace: 'groupsPlus',
				encoreFlag: 'groupsPlus',
				backgroundServices: [],
			});
			expect(FIRST_PARTY_PLUGINS.groupsPlus).toBe(GROUPS_PLUS_FIRST_PARTY_PLUGIN);
		});
		it('only requests read access to its enabling setting', () => {
			const parsed = parsePermissions(GROUPS_PLUS_FIRST_PARTY_PLUGIN_PERMISSIONS);
			expect(parsed.errors).toEqual([]);
			expect(parsed.requests.map((permission) => permission.capability)).toEqual(['settings:read']);
		});
		it('defaults its Encore flag to off', () => {
			expect(SETTINGS_METADATA.encoreFeatures.default).toMatchObject({ groupsPlus: false });
		});
	});
	describe('first-party plugin registry', () => {
		it('registers every Encore feature under its plan-stable plugin id', () => {
			expect(FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => [def.encoreFlag, def.id])).toEqual([
				['usageStats', 'com.maestro.usage-stats'],
				['symphony', 'com.maestro.symphony'],
				['maestroCue', 'com.maestro.cue'],
				['directorNotes', 'com.maestro.director-notes'],
				['pianola', 'com.maestro.pianola'],
				['coworking', 'com.maestro.coworking'],
				['opencodeServer', 'com.maestro.opencode-server'],
				['concerto', 'com.maestro.concerto'],
				['groupsPlus', 'com.maestro.groups-plus'],
				['webLogin', 'com.maestro.web-login'],
				['computerHistory', 'com.maestro.computer-history'],
				['quickChat', 'com.maestro.quick-chat'],
				['maestroRun', 'com.maestro.maestro-run'],
				['throughputGauge', 'com.maestro.throughput-gauge'],
				['dataview', 'com.maestro.dataview'],
			]);
		});
		it('keys the registry by Encore flag with no id or namespace collisions', () => {
			for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
				expect(FIRST_PARTY_PLUGINS[def.encoreFlag]).toBe(def);
			}
			const ids = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.id);
			expect(new Set(ids).size).toBe(ids.length);
			const namespaces = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.settingsNamespace);
			expect(new Set(namespaces).size).toBe(namespaces.length);
		});
		it('every definition declares first-party, valid permissions, and supervised-only services', () => {
			for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
				expect(def.firstParty).toBe(true);
				const parsed = parsePermissions(def.permissions);
				expect(parsed.errors).toEqual([]);
				expect(parsed.requests.length).toBeGreaterThan(0);
				// Every feature at least discloses reading its own Encore flag.
				expect(parsed.requests.map((p) => p.capability)).toContain('settings:read');
				// `agents:dispatch` can NEVER appear in static first-party metadata
				// (FC2 allowlist scopes require exact targets; see the Pianola NOTE).
				expect(parsed.requests.map((p) => p.capability)).not.toContain('agents:dispatch');
				for (const service of def.backgroundServices) {
					expect(service.kind).toBe('supervised');
					expect(service.id.length).toBeGreaterThan(0);
				}
			}
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-agent-select.test.ts
describe('', () => {
	function task(over: Partial<S4_PianolaTask> = {}): S4_PianolaTask {
		return { id: 't1', title: 'T1', prompt: 'do it', dependsOn: [], status: 'pending', ...over };
	}
	function caps(over: Partial<AgentCapabilities> = {}): AgentCapabilities {
		return { ...DEFAULT_CAPABILITIES, ...over };
	}
	function candidate(over: Partial<AgentCandidate> = {}): AgentCandidate {
		return { agentId: 'a', capabilities: caps(), status: 'ok', busy: false, inFlight: 0, ...over };
	}
	describe('selectAgentForTask', () => {
		it('chooses a ready, capable, not-busy agent', () => {
			const sel = selectAgentForTask(task(), [candidate({ agentId: 'claude-code' })]);
			expect(sel).toEqual({ agentId: 'claude-code' });
		});
		it('filters out a candidate missing a required capability', () => {
			const sel = selectAgentForTask(
				task(),
				[
					candidate({ agentId: 'no-images', capabilities: caps({ supportsImageInput: false }) }),
					candidate({ agentId: 'images', capabilities: caps({ supportsImageInput: true }) }),
				],
				{ required: ['supportsImageInput'] }
			);
			expect(sel).toEqual({ agentId: 'images' });
		});
		it('avoids a busy agent in favor of a free one', () => {
			const sel = selectAgentForTask(task(), [
				candidate({ agentId: 'busy-one', busy: true }),
				candidate({ agentId: 'free-one', busy: false }),
			]);
			expect(sel).toEqual({ agentId: 'free-one' });
		});
		it('prefers the lowest inFlight load', () => {
			const sel = selectAgentForTask(task(), [
				candidate({ agentId: 'loaded', inFlight: 3 }),
				candidate({ agentId: 'light', inFlight: 1 }),
			]);
			expect(sel).toEqual({ agentId: 'light' });
		});
		it('breaks an inFlight tie deterministically by agent id', () => {
			const sel = selectAgentForTask(task(), [
				candidate({ agentId: 'zeta', inFlight: 2 }),
				candidate({ agentId: 'alpha', inFlight: 2 }),
			]);
			expect(sel).toEqual({ agentId: 'alpha' });
		});
		it('escalates when there are no candidates', () => {
			const sel = selectAgentForTask(task(), []);
			expect('escalate' in sel).toBe(true);
		});
		it('escalates when every candidate is unready (status not ok)', () => {
			const sel = selectAgentForTask(task(), [
				candidate({ agentId: 'a', status: 'auth_required' }),
				candidate({ agentId: 'b', status: 'not_installed' }),
			]);
			expect('escalate' in sel).toBe(true);
		});
		it('escalates when every ready candidate is busy', () => {
			const sel = selectAgentForTask(task(), [
				candidate({ agentId: 'a', busy: true }),
				candidate({ agentId: 'b', busy: true }),
			]);
			expect('escalate' in sel).toBe(true);
		});
		it('escalates when no candidate supports a required capability', () => {
			const sel = selectAgentForTask(
				task(),
				[candidate({ agentId: 'a' }), candidate({ agentId: 'b' })],
				{
					required: ['supportsImageInput'],
				}
			);
			expect('escalate' in sel).toBe(true);
		});
		it('keeps a stable binding when the task is pinned to an eligible agent', () => {
			const sel = selectAgentForTask(task({ agentId: 'pinned' }), [
				candidate({ agentId: 'lighter', inFlight: 0 }),
				candidate({ agentId: 'pinned', inFlight: 5 }),
			]);
			expect(sel).toEqual({ agentId: 'pinned' });
		});
		it('ignores a pinned agent that is not eligible and selects another', () => {
			const sel = selectAgentForTask(task({ agentId: 'pinned-busy' }), [
				candidate({ agentId: 'pinned-busy', busy: true }),
				candidate({ agentId: 'free', busy: false }),
			]);
			expect(sel).toEqual({ agentId: 'free' });
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-message-contract.test.ts
describe('', () => {
	describe('Pianola message contract', () => {
		it('accepts a SessionHistoryMessage as a PianolaMessage', () => {
			const wire: SessionHistoryMessage = {
				id: 'm1',
				role: 'assistant',
				source: 'ai',
				content: 'hi',
				timestamp: '2026-01-01T00:00:00.000Z',
			};
			// Compile-time assignability check; the runtime assertions keep vitest happy.
			const message: S5_PianolaMessage = wire;
			expect(message.id).toBe('m1');
			expect(message.awaitingInput).toBeUndefined();
		});
	});
});
