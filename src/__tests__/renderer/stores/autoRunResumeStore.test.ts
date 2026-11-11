/**
 * The auto-resume store decides whether an unattended Auto Run restarts itself,
 * so the tests pin the three ways it can go wrong rather than the happy path
 * alone:
 *
 * - it must STOP. An off-by-one on the ceiling is a run that resumes forever.
 * - it must not fire into a loop that is already moving, which is what a stale
 *   timer does after the user resolves the pause by hand.
 * - it must not reset its own ceiling. Counting attempts per error, or clearing
 *   them on a successful resume, both turn "5 tries" into "unlimited tries".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentError, BatchRunState } from '../../../renderer/types';
import {
	classifyRetryableError,
	type ClassifiableError,
} from '../../../shared/retryClassification';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../renderer/hooks/batch/batchReducer';
import { createMockSession } from '../../helpers/mockSession';
import { resetStores } from '../../helpers/resetStores';
import { registerBatchResumer } from '../../../renderer/services/batchResumer';
import {
	scheduleAutoResume,
	cancelPendingAutoResume,
	clearAutoResume,
	resumeAutoRunNow,
	getAutoResumeEntry,
	resetAutoResumeStateForTests,
	useAutoRunResumeStore,
} from '../../../renderer/stores/autoRunResumeStore';

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const POLICY = { delayMs: 5 * 60_000, maxAttempts: 5 };

function agentError(
	overrides: Partial<AgentError & ClassifiableError> = {}
): AgentError & ClassifiableError {
	return {
		type: 'unknown',
		message: 'Something went wrong',
		recoverable: true,
		timestamp: Date.now(),
		...overrides,
	} as AgentError;
}

describe('autoRunResumeStore', () => {
	let resumer: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		resetAutoResumeStateForTests();
		resetStores(useSessionStore, useBatchStore);
		resumer = vi.fn();
		registerBatchResumer(resumer);
	});

	afterEach(() => {
		resetAutoResumeStateForTests();
		registerBatchResumer(null);
		resetStores(useSessionStore, useBatchStore);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('resumes the run after the configured wait', () => {
		expect(scheduleAutoResume('s1', POLICY, agentError())).toBe(true);
		expect(resumer).not.toHaveBeenCalled();

		vi.advanceTimersByTime(POLICY.delayMs);
		expect(resumer).toHaveBeenCalledWith('s1');
	});

	it('declines when the run opted out', () => {
		expect(scheduleAutoResume('s1', null, agentError())).toBe(false);
		vi.advanceTimersByTime(60 * 60_000);
		expect(resumer).not.toHaveBeenCalled();
	});

	it('leaves a quota pause to the limit coordinator', () => {
		// A fixed few-minute timer cannot know when the window reopens, so it
		// would spend the whole ceiling hitting the same wall.
		for (const type of ['rate_limited', 'token_exhaustion'] as const) {
			resetAutoResumeStateForTests();
			expect(scheduleAutoResume('s1', POLICY, agentError({ type }))).toBe(false);
		}
		vi.advanceTimersByTime(60 * 60_000);
		expect(resumer).not.toHaveBeenCalled();
	});

	it('declines when no resumer is registered, leaving the manual controls', () => {
		registerBatchResumer(null);
		expect(scheduleAutoResume('s1', POLICY, agentError())).toBe(false);
	});

	it('stops after maxAttempts and marks the run exhausted', () => {
		// Each failure schedules once; the run fails again every time.
		for (let i = 0; i < POLICY.maxAttempts; i++) {
			expect(scheduleAutoResume('s1', POLICY, agentError())).toBe(true);
			vi.advanceTimersByTime(POLICY.delayMs);
		}
		expect(resumer).toHaveBeenCalledTimes(POLICY.maxAttempts);

		// The failure after the last attempt gets no resume.
		expect(scheduleAutoResume('s1', POLICY, agentError())).toBe(false);
		vi.advanceTimersByTime(POLICY.delayMs * 10);
		expect(resumer).toHaveBeenCalledTimes(POLICY.maxAttempts);

		const entry = getAutoResumeEntry('s1');
		expect(entry?.exhausted).toBe(true);
		expect(entry?.nextResumeAt).toBeNull();
	});

	it('counts attempts per run, not per error message', () => {
		// A run that fails a different way each time must still exhaust its
		// ceiling; otherwise the cap never bites.
		for (let i = 0; i < POLICY.maxAttempts; i++) {
			scheduleAutoResume('s1', POLICY, agentError({ message: `failure ${i}` }));
			vi.advanceTimersByTime(POLICY.delayMs);
		}
		expect(scheduleAutoResume('s1', POLICY, agentError({ message: 'brand new' }))).toBe(false);
	});

	it('does not reset the ceiling when a resume fires', () => {
		scheduleAutoResume('s1', POLICY, agentError());
		vi.advanceTimersByTime(POLICY.delayMs);
		expect(getAutoResumeEntry('s1')?.attempts).toBe(1);

		scheduleAutoResume('s1', POLICY, agentError());
		expect(getAutoResumeEntry('s1')?.attempts).toBe(2);
	});

	it('cancelPendingAutoResume stops the timer but keeps the attempt count', () => {
		// This is the user clicking Resume themselves. A rescue must not hand the
		// run a fresh set of automatic attempts.
		scheduleAutoResume('s1', POLICY, agentError());
		cancelPendingAutoResume('s1');

		vi.advanceTimersByTime(POLICY.delayMs * 5);
		expect(resumer).not.toHaveBeenCalled();
		expect(getAutoResumeEntry('s1')?.attempts).toBe(1);
		expect(getAutoResumeEntry('s1')?.nextResumeAt).toBeNull();
	});

	it('clearAutoResume forgets the run entirely, so a fresh run starts clean', () => {
		for (let i = 0; i < POLICY.maxAttempts; i++) {
			scheduleAutoResume('s1', POLICY, agentError());
			vi.advanceTimersByTime(POLICY.delayMs);
		}
		expect(scheduleAutoResume('s1', POLICY, agentError())).toBe(false);

		clearAutoResume('s1');
		expect(getAutoResumeEntry('s1')).toBeUndefined();
		expect(scheduleAutoResume('s1', POLICY, agentError())).toBe(true);
	});

	it('keeps runs independent', () => {
		scheduleAutoResume('s1', POLICY, agentError());
		scheduleAutoResume('s2', POLICY, agentError());
		cancelPendingAutoResume('s1');

		vi.advanceTimersByTime(POLICY.delayMs);
		expect(resumer).toHaveBeenCalledTimes(1);
		expect(resumer).toHaveBeenCalledWith('s2');
	});

	it('resumeAutoRunNow fires the pending resume immediately, once', () => {
		scheduleAutoResume('s1', POLICY, agentError());
		resumeAutoRunNow('s1');
		expect(resumer).toHaveBeenCalledTimes(1);

		// The timer it pre-empted must not fire a second time.
		vi.advanceTimersByTime(POLICY.delayMs * 2);
		expect(resumer).toHaveBeenCalledTimes(1);
	});

	it('resumeAutoRunNow does nothing when no resume is pending', () => {
		resumeAutoRunNow('s1');
		expect(resumer).not.toHaveBeenCalled();
	});

	it('a re-scheduled run replaces its pending timer instead of stacking one', () => {
		scheduleAutoResume('s1', POLICY, agentError());
		scheduleAutoResume('s1', POLICY, agentError());

		vi.advanceTimersByTime(POLICY.delayMs);
		expect(resumer).toHaveBeenCalledTimes(1);
	});

	describe('Grok automatic replay ownership', () => {
		let safeError: AgentError & ClassifiableError;
		beforeEach(() => {
			safeError = agentError({
				agentId: 'grok',
				type: 'network_error',
				message: 'Service unavailable',
				terminal: { status: 'failed', kind: 'provider', dispatchState: 'not-dispatched' },
			});
			useSessionStore.getState().setSessions([
				createMockSession({
					id: 's1',
					toolType: 'grok',
					agentErrorPaused: true,
					agentError: safeError,
				}),
			]);
			useBatchStore.setState({
				batchRunStates: {
					s1: {
						...DEFAULT_BATCH_STATE,
						isRunning: true,
						errorPaused: true,
						error: safeError,
					},
				},
			});
		});

		it.each<[string, Partial<AgentError & ClassifiableError>]>([
			['missing terminal', { terminal: undefined }],
			['uncertain rate limit', { type: 'rate_limited', terminal: undefined }],
			[
				'unknown dispatch',
				{ terminal: { status: 'failed', kind: 'provider', dispatchState: 'unknown' } },
			],
			[
				'dispatched network failure',
				{ terminal: { status: 'failed', kind: 'provider', dispatchState: 'dispatched' } },
			],
			[
				'cancelled',
				{ terminal: { status: 'cancelled', origin: 'user', dispatchState: 'not-dispatched' } },
			],
			[
				'refused',
				{ terminal: { status: 'refused', origin: 'effect', dispatchState: 'not-dispatched' } },
			],
			['context limit', { type: 'token_exhaustion' }],
			[
				'partial transport',
				{ terminal: { status: 'failed', kind: 'transport', dispatchState: 'not-dispatched' } },
			],
			[
				'malformed protocol',
				{ terminal: { status: 'failed', kind: 'protocol', dispatchState: 'not-dispatched' } },
			],
		])('cannot fall through Agent Resilience decline for %s', (_name, patch) => {
			const error = { ...safeError, ...patch };
			expect(classifyRetryableError(error)).toBeNull();
			expect(scheduleAutoResume('s1', POLICY, error)).toBe(false);
			vi.advanceTimersByTime(POLICY.delayMs * 2);
			expect(resumer).not.toHaveBeenCalled();
			expect(useBatchStore.getState().batchRunStates.s1.errorPaused).toBe(true);
			expect(getAutoResumeEntry('s1')).toBeUndefined();
		});

		it('resumes a proven not-dispatched transient failure exactly once', () => {
			expect(classifyRetryableError(safeError)).toBe('availability');
			expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(true);
			vi.advanceTimersByTime(POLICY.delayMs * 2);
			expect(resumer).toHaveBeenCalledExactlyOnceWith('s1');
		});

		describe.each(['session', 'batch'] as const)('%s error ownership', (owner) => {
			it.each(['schedule', 'fire'] as const)('rejects an unsafe live error at %s', (stage) => {
				if (stage === 'fire') expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(true);
				const uncertain = agentError({ agentId: 'grok', type: 'network_error' });
				if (owner === 'session') {
					useSessionStore
						.getState()
						.setSessions((sessions) => sessions.map((s) => ({ ...s, agentError: uncertain })));
				} else {
					useBatchStore
						.getState()
						.setBatchRunStates((states) => ({ ...states, s1: { ...states.s1, error: uncertain } }));
				}
				if (stage === 'schedule') expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(false);
				vi.advanceTimersByTime(POLICY.delayMs * 2);
				expect(resumer).not.toHaveBeenCalled();
				expect(useSessionStore.getState().sessions[0].agentErrorPaused).toBe(true);
				expect(useBatchStore.getState().batchRunStates.s1.errorPaused).toBe(true);
			});
		});

		it.each<Partial<BatchRunState>>([
			{ isRunning: false },
			{ errorPaused: false },
			{ isStopping: true },
			{ mirrored: true },
			{ error: undefined },
			{ error: agentError({ agentId: 'grok', type: 'rate_limited' }) },
		])('disarms a timer when the current batch changes to %j', (patch) => {
			expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(true);
			useBatchStore
				.getState()
				.setBatchRunStates((states) => ({ ...states, s1: { ...states.s1, ...patch } }));
			vi.advanceTimersByTime(POLICY.delayMs);
			expect(resumer).not.toHaveBeenCalled();
			expect(getAutoResumeEntry('s1')).toMatchObject({ attempts: 1, nextResumeAt: null });
		});

		it('cancels a previously safe timer when its replacement is declined', () => {
			expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(true);
			expect(scheduleAutoResume('s1', POLICY, agentError({ agentId: 'grok' }))).toBe(false);
			vi.advanceTimersByTime(POLICY.delayMs);
			expect(resumer).not.toHaveBeenCalled();
			expect(getAutoResumeEntry('s1')).toMatchObject({ attempts: 1, nextResumeAt: null });
		});

		it.each(['changed provider', 'removed session'] as const)(
			'retains Grok identity after %s',
			(change) => {
				const legacy = { ...safeError, agentId: undefined } as unknown as AgentError;
				expect(scheduleAutoResume('s1', POLICY, legacy)).toBe(true);
				useSessionStore.getState().setSessions((sessions) =>
					change === 'removed session'
						? []
						: sessions.map((s) => ({
								...s,
								toolType: 'codex',
								agentError: agentError(),
								agentErrorPaused: true,
							}))
				);
				useBatchStore.getState().setBatchRunStates((states) => ({
					...states,
					s1: { ...states.s1, error: agentError() },
				}));
				vi.advanceTimersByTime(POLICY.delayMs);
				expect(resumer).not.toHaveBeenCalled();
			}
		);

		it('does not turn a restored countdown entry into an automatic resume', () => {
			expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(true);
			const saved = JSON.parse(JSON.stringify(useAutoRunResumeStore.getState().entries));
			resetAutoResumeStateForTests();
			useAutoRunResumeStore.setState({ entries: saved });
			vi.advanceTimersByTime(POLICY.delayMs * 2);
			resumeAutoRunNow('s1');
			expect(resumer).not.toHaveBeenCalled();
		});

		it('preserves explicit user Resume after a scheduled error becomes uncertain', () => {
			expect(scheduleAutoResume('s1', POLICY, safeError)).toBe(true);
			useBatchStore.getState().setBatchRunStates((states) => ({
				...states,
				s1: { ...states.s1, error: agentError({ agentId: 'grok' }) },
			}));
			resumeAutoRunNow('s1');
			vi.advanceTimersByTime(POLICY.delayMs * 2);
			expect(resumer).toHaveBeenCalledExactlyOnceWith('s1');
			expect(getAutoResumeEntry('s1')?.attempts).toBe(1);
		});
	});

	it.each(['claude-code', 'codex', 'antigravity'] as const)(
		'preserves %s blanket automatic resume',
		(toolType) => {
			const error = agentError({ agentId: toolType });
			useSessionStore
				.getState()
				.setSessions([createMockSession({ id: 's1', toolType, agentError: error })]);
			expect(classifyRetryableError(error)).toBeNull();
			expect(scheduleAutoResume('s1', POLICY, error)).toBe(true);
			vi.advanceTimersByTime(POLICY.delayMs * 2);
			expect(resumer).toHaveBeenCalledExactlyOnceWith('s1');
		}
	);
});
