import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAutoResumeCoordinator,
	runAutoResumeTick,
	probeAvailability,
	isLimitPausedSession,
	isEligibleToProbe,
} from '../../../../renderer/hooks/agent/useAutoResumeCoordinator';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useAgentStore } from '../../../../renderer/stores/agentStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import {
	useClaudeUsageStore,
	type ClaudeUsageSnapshot,
} from '../../../../renderer/stores/claudeUsageStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type { AgentError, Session, BatchRunState, LogEntry } from '../../../../renderer/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** Flush pending microtasks + the per-session fire-and-forget resume IIFEs. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await Promise.resolve();
}

function makeLimitError(overrides: Partial<AgentError> = {}): AgentError {
	return {
		type: 'rate_limited',
		message: 'Rate limited',
		recoverable: true,
		agentId: 'claude-code',
		// Default to "just now" so the give-up window (default 7 days) is nowhere
		// near elapsed - give-up tests pin their own timestamp + `now` explicitly.
		timestamp: Date.now(),
		resumeAttemptCount: 0,
		...overrides,
	};
}

function makeLimitPausedSession(overrides: Partial<Session> = {}): Session {
	const error = (overrides.agentError as AgentError | undefined) ?? makeLimitError();
	const logs = (overrides as { __logs?: LogEntry[] }).__logs ?? [];
	return createMockSession({
		id: 'sess-claude',
		toolType: 'claude-code',
		name: 'My Agent',
		state: 'error',
		agentErrorPaused: true,
		agentError: error,
		agentErrorTabId: 'tab-1',
		aiTabs: [createMockAITab({ id: 'tab-1', agentError: error, logs })],
		...overrides,
	});
}

function makeSnapshot(sessionPercent: number, weekPercent: number): ClaudeUsageSnapshot {
	const future = '2099-01-01T00:00:00.000Z';
	return {
		sampledAt: future,
		configDirKey: '/home/.claude',
		authState: 'authenticated',
		session: { percent: sessionPercent, resetsAt: future },
		weekAllModels: { percent: weekPercent, resetsAt: future },
		weekSonnetOnly: { percent: 0, resetsAt: future },
	};
}

/** Snapshot map returned by the mocked getClaudeUsageSnapshots IPC. */
let claudeSnapshotMap: Record<string, ClaudeUsageSnapshot> = {};

function setSessions(sessions: Session[]): void {
	useSessionStore.getState().setSessions(sessions);
}

beforeEach(() => {
	claudeSnapshotMap = {};
	useSessionStore.getState().setSessions([]);
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	useNotificationStore.getState().clearToasts();
	useClaudeUsageStore.getState().__resetForTests();
	useSettingsStore.setState({ autoResumeOnLimit: true, autoResumeCheckIntervalHours: 2 });

	(window as unknown as { maestro: unknown }).maestro = {
		agents: {
			refreshClaudeUsageSnapshots: vi.fn().mockResolvedValue({ refreshed: 1 }),
			getClaudeUsageSnapshots: vi.fn().mockImplementation(async () => claudeSnapshotMap),
		},
		agentError: {
			clearError: vi.fn().mockResolvedValue(undefined),
		},
		logger: { toast: vi.fn(), log: vi.fn(), autorun: vi.fn() },
		// `.show` must return a promise: notifyToast chains `.catch` on it.
		notification: { show: vi.fn().mockResolvedValue(undefined), speak: vi.fn() },
	};
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure predicates
// ---------------------------------------------------------------------------

describe('isLimitPausedSession / isEligibleToProbe', () => {
	it('recognizes a rate-limited paused session', () => {
		expect(isLimitPausedSession(makeLimitPausedSession())).toBe(true);
	});

	it('rejects a non-limit error pause', () => {
		const s = makeLimitPausedSession({ agentError: makeLimitError({ type: 'auth_expired' }) });
		expect(isLimitPausedSession(s)).toBe(false);
	});

	it('rejects an idle session', () => {
		expect(isLimitPausedSession(createMockSession({ state: 'idle' }))).toBe(false);
	});

	it('skips a session whose limitResetAt is still in the future', () => {
		const now = 10_000;
		const s = makeLimitPausedSession({ agentError: makeLimitError({ limitResetAt: now + 5_000 }) });
		expect(isEligibleToProbe(s, now)).toBe(false);
	});

	it('allows a session whose limitResetAt has passed', () => {
		const now = 10_000;
		const s = makeLimitPausedSession({ agentError: makeLimitError({ limitResetAt: now - 1 }) });
		expect(isEligibleToProbe(s, now)).toBe(true);
	});

	it('allows a session with unknown limitResetAt', () => {
		expect(isEligibleToProbe(makeLimitPausedSession(), 10_000)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// probeAvailability
// ---------------------------------------------------------------------------

describe('probeAvailability', () => {
	it('returns true for non-Claude providers (resume-as-probe)', async () => {
		const s = makeLimitPausedSession({ toolType: 'opencode' });
		await expect(probeAvailability(s)).resolves.toBe(true);
	});

	it('returns true when both Claude windows are below the limit threshold', async () => {
		useClaudeUsageStore.getState().setSnapshots({ '/home/.claude': makeSnapshot(40, 50) });
		await expect(probeAvailability(makeLimitPausedSession())).resolves.toBe(true);
	});

	it('returns false when a Claude window is at/above the limit threshold', async () => {
		useClaudeUsageStore.getState().setSnapshots({ '/home/.claude': makeSnapshot(100, 50) });
		await expect(probeAvailability(makeLimitPausedSession())).resolves.toBe(false);
	});

	it('returns false when no snapshot is available', async () => {
		await expect(probeAvailability(makeLimitPausedSession())).resolves.toBe(false);
	});

	it('returns false for an unauthenticated account', async () => {
		const snap = { ...makeSnapshot(10, 10), authState: 'unauthenticated' as const };
		useClaudeUsageStore.getState().setSnapshots({ '/home/.claude': snap });
		await expect(probeAvailability(makeLimitPausedSession())).resolves.toBe(false);
	});

	it('SSH-backed Claude session ignores the (local) snapshot and falls back to the interval attempt', async () => {
		// The local snapshot says OVER the limit, but for an SSH session it's the
		// wrong account/machine - the probe must treat availability as unknown and
		// return true (resume-as-probe on the remote) rather than read local numbers.
		useClaudeUsageStore.getState().setSnapshots({ '/home/.claude': makeSnapshot(100, 100) });
		const s = makeLimitPausedSession({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		await expect(probeAvailability(s)).resolves.toBe(true);
	});

	it('local (SSH-disabled) Claude session still uses the snapshot', async () => {
		useClaudeUsageStore.getState().setSnapshots({ '/home/.claude': makeSnapshot(100, 100) });
		const s = makeLimitPausedSession({
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
		});
		await expect(probeAvailability(s)).resolves.toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runAutoResumeTick - resume behavior
// ---------------------------------------------------------------------------

describe('runAutoResumeTick', () => {
	it('(b) resumes an eligible Claude session when probe=true and fires a toast', async () => {
		claudeSnapshotMap = { '/home/.claude': makeSnapshot(20, 30) };
		setSessions([makeLimitPausedSession()]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();

		// Standard (no batch) path: error cleared, session idle.
		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('idle');
		expect(after.agentError).toBeUndefined();

		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].title).toBe('Resumed');
		expect(toasts[0].color).toBe('green');
		expect(toasts[0].message).toContain('My Agent');
		expect(toasts[0].clickAction).toEqual({
			kind: 'jump-session',
			sessionId: 'sess-claude',
			tabId: 'tab-1',
		});
	});

	it('(c) leaves a Claude session paused and fires no toast when probe=false', async () => {
		claudeSnapshotMap = { '/home/.claude': makeSnapshot(100, 100) };
		setSessions([makeLimitPausedSession()]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('error');
		expect(after.agentError).toBeDefined();
		expect(resumeAutoRun).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('(d) attempts a resume for a non-Claude session on the interval (no probe signal)', async () => {
		setSessions([
			makeLimitPausedSession({ id: 'sess-oc', toolType: 'opencode', name: 'OC Agent' }),
		]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();

		// No batch run → standard path → error cleared.
		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('idle');
		expect(after.agentError).toBeUndefined();
		expect(useNotificationStore.getState().toasts).toHaveLength(1);
		// Claude usage is never re-sampled when no candidate is a Claude agent.
		const maestro = (
			window as unknown as {
				maestro: { agents: { refreshClaudeUsageSnapshots: ReturnType<typeof vi.fn> } };
			}
		).maestro;
		expect(maestro.agents.refreshClaudeUsageSnapshots).not.toHaveBeenCalled();
	});

	it('routes an error-paused batch run through resumeAutoRunAfterError', async () => {
		setSessions([makeLimitPausedSession({ id: 'sess-batch', toolType: 'opencode' })]);
		useBatchStore.setState({
			batchRunStates: {
				'sess-batch': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					errorPaused: true,
				} as BatchRunState,
			},
			customPrompts: {},
		});
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();

		expect(resumeAutoRun).toHaveBeenCalledTimes(1);
		expect(resumeAutoRun).toHaveBeenCalledWith('sess-batch');
		expect(useNotificationStore.getState().toasts).toHaveLength(1);
	});

	it('(e) skips a session whose limitResetAt is in the future', async () => {
		const future = Date.now() + 60 * 60 * 1000;
		setSessions([
			makeLimitPausedSession({
				toolType: 'opencode',
				agentError: makeLimitError({ limitResetAt: future }),
			}),
		]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('error');
		expect(resumeAutoRun).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('(f) does not start a second resume for a session already mid-resume', async () => {
		setSessions([makeLimitPausedSession({ id: 'sess-batch', toolType: 'opencode' })]);
		useBatchStore.setState({
			batchRunStates: {
				'sess-batch': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					errorPaused: true,
				} as BatchRunState,
			},
			customPrompts: {},
		});
		const resumeAutoRun = vi.fn();

		// Shared in-flight set across two back-to-back ticks: the second tick's
		// synchronous loop must observe the id the first tick added and skip.
		const inFlight = new Set<string>();
		const p1 = runAutoResumeTick(inFlight, resumeAutoRun);
		const p2 = runAutoResumeTick(inFlight, resumeAutoRun);
		await Promise.all([p1, p2]);
		await flush();

		expect(resumeAutoRun).toHaveBeenCalledTimes(1);
	});

	it('stamps limitPausedAt (seeded from the error timestamp) on first observation', async () => {
		claudeSnapshotMap = { '/home/.claude': makeSnapshot(100, 100) }; // probe=false → stays paused
		setSessions([makeLimitPausedSession({ agentError: makeLimitError({ timestamp: 4242 }) })]);

		// now just after the pause so the give-up window is nowhere near elapsed.
		await runAutoResumeTick(new Set(), vi.fn(), { now: 5242 });
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.agentError?.limitPausedAt).toBe(4242);
	});

	it('increments resumeAttemptCount before a batch resume', async () => {
		setSessions([
			makeLimitPausedSession({
				id: 'sess-batch',
				toolType: 'opencode',
				agentError: makeLimitError({ resumeAttemptCount: 2 }),
			}),
		]);
		useBatchStore.setState({
			batchRunStates: {
				'sess-batch': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					errorPaused: true,
				} as BatchRunState,
			},
			customPrompts: {},
		});
		let countAtResume: number | undefined;
		const resumeAutoRun = vi.fn((sessionId: string) => {
			countAtResume = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
				?.agentError?.resumeAttemptCount;
		});

		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();

		expect(countAtResume).toBe(3);
	});

	it('re-fires a captured in-flight direct send by enqueueing it', async () => {
		const captureLog: LogEntry = {
			id: 'log-err',
			timestamp: 1000,
			source: 'error',
			text: 'Rate limited',
			recoveryAction: { lastUserPrompt: 'continue please', tabId: 'tab-1' },
		};
		claudeSnapshotMap = { '/home/.claude': makeSnapshot(10, 10) };
		const error = makeLimitError();
		setSessions([
			createMockSession({
				id: 'sess-claude',
				toolType: 'claude-code',
				state: 'error',
				agentErrorPaused: true,
				agentError: error,
				agentErrorTabId: 'tab-1',
				aiTabs: [createMockAITab({ id: 'tab-1', agentError: error, logs: [captureLog] })],
			}),
		]);

		await runAutoResumeTick(new Set(), vi.fn());
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.executionQueue).toHaveLength(1);
		expect(after.executionQueue[0]).toMatchObject({
			type: 'message',
			text: 'continue please',
			tabId: 'tab-1',
		});
		// recoveryAction consumed so it fires only once.
		expect(after.aiTabs[0].logs[0].recoveryAction).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Restart re-attachment (Phase 4): a persisted limit pause survives a cold
// start (see useDebouncedPersistence + useSessionRestoration round-trip tests)
// and the coordinator must pick it up on its first tick with no extra wiring.
// ---------------------------------------------------------------------------

describe('restart re-attachment', () => {
	it('considers a restored limit-paused session on the first (kickoff) tick and resumes it via the standard queue-drain path', async () => {
		vi.useFakeTimers();
		// Post-restart conditions: batchStore is in-memory and is NOT
		// reconstructed on a cold start, so a session that paused mid Auto Run
		// has no batch state here. The session itself comes back shaped exactly
		// like restoreSession leaves a limit pause (state 'error', paused, error
		// intact). opencode = resume-as-probe so the tick is deterministic.
		useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		setSessions([
			makeLimitPausedSession({ id: 'sess-oc', toolType: 'opencode', name: 'OC Agent' }),
		]);
		const resumeAutoRun = vi.fn();

		// The restored session matches the coordinator's selector with no extra wiring.
		expect(isLimitPausedSession(useSessionStore.getState().sessions[0])).toBe(true);

		renderHook(() => useAutoResumeCoordinator({ resumeAutoRunAfterError: resumeAutoRun }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(11_000); // past the 10s kickoff tick
		});

		const after = useSessionStore.getState().sessions[0];
		// Standard path: error cleared, session idle, persisted queue drains and
		// the agent resumes its own transcript via the native --resume.
		expect(after.state).toBe('idle');
		expect(after.agentError).toBeUndefined();
		// The orchestration LOOP did NOT resume on a cold start - no batch state survived.
		expect(resumeAutoRun).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Respect manual user action
// ---------------------------------------------------------------------------

describe('respect manual user action', () => {
	it('drops a session from consideration once the user clears the error (clearAgentError)', async () => {
		setSessions([makeLimitPausedSession()]);
		// Sanity: it WAS a candidate before the user acted.
		expect(isLimitPausedSession(useSessionStore.getState().sessions[0])).toBe(true);

		// A manual recovery action / retry / start-new / restart all funnel through
		// clearAgentError, which resets the exact fields the coordinator selects on.
		act(() => {
			useAgentStore.getState().clearAgentError('sess-claude');
		});

		const cleared = useSessionStore.getState().sessions[0];
		expect(cleared.agentError).toBeUndefined();
		expect(cleared.agentErrorPaused).toBe(false);
		expect(cleared.state).toBe('idle');
		expect(isLimitPausedSession(cleared)).toBe(false);

		// The coordinator no longer touches it: no probe, no resume, no toast.
		const resumeAutoRun = vi.fn();
		await runAutoResumeTick(new Set(), resumeAutoRun);
		await flush();
		expect(resumeAutoRun).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Give up (time-based, off autoResumeGiveUpDays)
// ---------------------------------------------------------------------------

describe('give up (time-based)', () => {
	it('parks the session, fires one distinct toast, and stops resuming after the cutoff', async () => {
		const pausedAt = 1_000_000;
		const now = pausedAt + 8 * DAY; // past the default 7-day window
		setSessions([
			makeLimitPausedSession({
				id: 'sess-oc',
				toolType: 'opencode',
				name: 'OC Agent',
				agentError: makeLimitError({ timestamp: pausedAt }),
			}),
		]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun, { giveUp: new Map(), giveUpDays: 7, now });
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('error'); // left paused
		expect(after.agentError).toBeDefined();
		expect(resumeAutoRun).not.toHaveBeenCalled(); // NOT resumed

		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].title).toBe('Auto-resume stopped');
		expect(toasts[0].color).toBe('orange');
		expect(toasts[0].message).toContain('7 days');
		expect(toasts[0].message).toContain('OC Agent');
	});

	it('keeps retrying (and resumes) inside the give-up window', async () => {
		const pausedAt = 1_000_000;
		const now = pausedAt + 3 * DAY; // well within 7 days
		setSessions([
			makeLimitPausedSession({
				id: 'sess-oc',
				toolType: 'opencode',
				agentError: makeLimitError({ timestamp: pausedAt }),
			}),
		]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun, { giveUp: new Map(), giveUpDays: 7, now });
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('idle'); // resumed via standard path
		expect(after.agentError).toBeUndefined();
		expect(useNotificationStore.getState().toasts[0]?.title).toBe('Resumed');
	});

	it('fires the give-up toast only once across repeated ticks', async () => {
		const pausedAt = 1_000_000;
		const now = pausedAt + 8 * DAY;
		setSessions([
			makeLimitPausedSession({
				id: 'sess-oc',
				toolType: 'opencode',
				agentError: makeLimitError({ timestamp: pausedAt }),
			}),
		]);
		const giveUp = new Map();

		await runAutoResumeTick(new Set(), vi.fn(), { giveUp, giveUpDays: 7, now });
		await runAutoResumeTick(new Set(), vi.fn(), { giveUp, giveUpDays: 7, now: now + DAY });
		await flush();

		expect(useNotificationStore.getState().toasts).toHaveLength(1);
	});

	it('measures the window from the original pause, surviving a resume-then-re-hit', async () => {
		const original = 1_000_000;
		const now = original + 8 * DAY;
		// Pre-seeded as if an earlier tick anchored the window at the first pause.
		const giveUp = new Map([['sess-oc', { anchor: original, toastFired: false }]]);
		// The live error is a fresh RE-HIT - on its own timestamp it'd be deep
		// inside the window, but the preserved anchor wins and we still give up.
		setSessions([
			makeLimitPausedSession({
				id: 'sess-oc',
				toolType: 'opencode',
				agentError: makeLimitError({ timestamp: now - 60_000 }),
			}),
		]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun, { giveUp, giveUpDays: 7, now });
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('error');
		expect(resumeAutoRun).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts[0]?.title).toBe('Auto-resume stopped');
	});

	it('forgets the window once the session is no longer limit-paused (fresh window later)', async () => {
		const giveUp = new Map([['sess-oc', { anchor: 1_000_000, toastFired: true }]]);
		// Session resumed successfully: idle, not limit-paused.
		setSessions([createMockSession({ id: 'sess-oc', toolType: 'opencode', state: 'idle' })]);

		await runAutoResumeTick(new Set(), vi.fn(), { giveUp, giveUpDays: 7, now: 2_000_000 });
		await flush();

		expect(giveUp.has('sess-oc')).toBe(false);
	});

	it('does not give up on attempt count alone within the window', async () => {
		const pausedAt = 1_000_000;
		const now = pausedAt + 2 * DAY; // within window
		setSessions([
			makeLimitPausedSession({
				id: 'sess-oc',
				toolType: 'opencode',
				agentError: makeLimitError({ timestamp: pausedAt, resumeAttemptCount: 999 }),
			}),
		]);
		const resumeAutoRun = vi.fn();

		await runAutoResumeTick(new Set(), resumeAutoRun, { giveUp: new Map(), giveUpDays: 7, now });
		await flush();

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('idle'); // resumed despite 999 attempts - probing is cheap
		expect(useNotificationStore.getState().toasts[0]?.title).toBe('Resumed');
	});
});

// ---------------------------------------------------------------------------
// Hook timer wiring
// ---------------------------------------------------------------------------

describe('useAutoResumeCoordinator (timer)', () => {
	it('(a) schedules no timer and resumes nothing when the setting is disabled', () => {
		vi.useFakeTimers();
		useSettingsStore.setState({ autoResumeOnLimit: false, autoResumeCheckIntervalHours: 2 });
		setSessions([makeLimitPausedSession({ toolType: 'opencode' })]);
		const resumeAutoRun = vi.fn();

		renderHook(() => useAutoResumeCoordinator({ resumeAutoRunAfterError: resumeAutoRun }));

		act(() => {
			vi.advanceTimersByTime(3 * 60 * 60 * 1000); // 3h: past kickoff + a 2h interval
		});

		const after = useSessionStore.getState().sessions[0];
		expect(after.state).toBe('error');
		expect(resumeAutoRun).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('fires a kickoff tick shortly after mount when enabled', async () => {
		vi.useFakeTimers();
		useSettingsStore.setState({ autoResumeOnLimit: true, autoResumeCheckIntervalHours: 2 });
		setSessions([makeLimitPausedSession({ id: 'sess-oc', toolType: 'opencode' })]);
		const resumeAutoRun = vi.fn();

		renderHook(() => useAutoResumeCoordinator({ resumeAutoRunAfterError: resumeAutoRun }));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(11_000); // past the 10s kickoff
		});

		// Standard non-Claude session resumed → error cleared.
		expect(useSessionStore.getState().sessions[0].state).toBe('idle');
	});
});
