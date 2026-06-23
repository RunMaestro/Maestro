/**
 * useAutoResumeCoordinator - the brain of Auto-Resume On Limit (Phase 3).
 *
 * A renderer-side singleton (mounted once in App.tsx, mirroring the other
 * `useAgent*Listener` hooks) that, on a fixed interval (the
 * `autoResumeCheckIntervalHours` setting, default 2h), finds every
 * limit-paused session, probes whether its provider window has reopened, and
 * resumes the ones that are clear - dispatching the correct resume action per
 * run kind and firing a toast.
 *
 * Why renderer-side: every resume action (clearing error state,
 * `resumeAfterError`, re-entering the goal loop, draining the queue) lives in
 * the renderer, and the app must be open to resume regardless, so a renderer
 * singleton avoids new cross-process dispatch plumbing.
 *
 * Run-kind dispatch on resume:
 *   - Spec- or goal-driven (an error-paused batch run exists in batchStore):
 *     `resumeAutoRunAfterError(sessionId)` resolves the shared in-memory
 *     `errorResolution` promise that BOTH the document runner and the goal
 *     runner await, and clears the session/batch error. The goal runner retries
 *     the same iteration; the document runner re-runs the paused task.
 *   - Standard query: clear the paused error so the session falls back to idle
 *     and the persisted execution queue drains automatically (the
 *     runtime-recovery effect in useQueueProcessing), re-firing any captured
 *     in-flight direct send.
 */

import { useEffect, useRef } from 'react';
import type { Session, QueuedItem } from '../../types';
import { isLimitError } from '../../../shared/types';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore, updateSessionWith } from '../../stores/sessionStore';
import { useBatchStore } from '../../stores/batchStore';
import { useAgentStore } from '../../stores/agentStore';
import {
	useClaudeUsageStore,
	getClaudeUsageSnapshotForSession,
} from '../../stores/claudeUsageStore';
import { notifyToast } from '../../stores/notificationStore';
import { LIMIT_THRESHOLD } from '../../components/UsageDashboard/quota/quotaFormatting';
import { generateId } from '../../utils/ids';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[AutoResume]';

/**
 * Run one tick promptly after mount (not a full interval later) so a day-later
 * restart probes limit-paused agents within seconds instead of hours. Kept
 * short but non-zero so the rest of the app's startup wiring settles first.
 */
const INITIAL_TICK_DELAY_MS = 10_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fallback give-up window when the setting is missing (matches the default). */
const DEFAULT_GIVE_UP_DAYS = 7;

/**
 * Per-session give-up bookkeeping, held in memory across ticks (rebuilt from the
 * persisted `limitPausedAt` after a restart). `anchor` is when the give-up
 * window started - it deliberately survives a probe that resumes-then-re-hits
 * the limit (resume-as-probe for non-Claude), so "N days of REPEATED limits"
 * actually elapses instead of resetting every interval. `toastFired` guards the
 * single give-up toast.
 */
interface GiveUpTracking {
	anchor: number;
	toastFired: boolean;
}

/** Options bag for {@link runAutoResumeTick}. All optional for ease of testing. */
export interface RunAutoResumeTickOptions {
	/** Cross-tick give-up bookkeeping (the hook passes a stable ref'd map). */
	giveUp?: Map<string, GiveUpTracking>;
	/** `autoResumeGiveUpDays` setting (default 7). */
	giveUpDays?: number;
	/** Injectable clock for tests. */
	now?: number;
}

export interface UseAutoResumeCoordinatorDeps {
	/**
	 * The batch resume entry point (`resumeAfterError` wrapped to also clear the
	 * session's agent error). Resolves the shared `errorResolution` promise that
	 * both the document and goal runners await, unblocking either kind of paused
	 * Auto Run with its in-memory loop state intact.
	 */
	resumeAutoRunAfterError: (sessionId: string) => void;
}

// ============================================================================
// Pure predicates / selectors
// ============================================================================

/** A session paused specifically on a provider limit (rate / token / credit). */
export function isLimitPausedSession(session: Session): boolean {
	return (
		session.state === 'error' &&
		session.agentErrorPaused === true &&
		!!session.agentError &&
		isLimitError(session.agentError)
	);
}

/**
 * Whether a limit-paused session is eligible to probe on this tick. When the
 * provider told us when the window reopens (`limitResetAt`) and it's still in
 * the future, skip - it's not time yet. Sessions with an unknown reset time
 * (non-Claude / unparseable) are always eligible: the interval itself is the
 * backoff.
 */
export function isEligibleToProbe(session: Session, now: number): boolean {
	const resetAt = session.agentError?.limitResetAt;
	if (typeof resetAt === 'number' && resetAt > now) return false;
	return true;
}

// ============================================================================
// Probe
// ============================================================================

/**
 * Probe whether a paused session's provider window has reopened.
 *
 * Claude: reads the (freshly re-sampled, see `refreshClaudeUsageForTick`) usage
 * snapshot for that session's account and returns true only when both relevant
 * windows are below `LIMIT_THRESHOLD` - i.e. credits are actually available
 * again. A missing snapshot or an unauthenticated account returns false (we
 * can't confirm availability, so stay paused and retry next interval).
 *
 * All other providers: return true. No usage signal exists for them, so the
 * resume attempt itself is the probe - if it re-hits the limit, Phase 2's pause
 * path re-pauses it and the next interval retries. This is how "all providers"
 * is supported.
 */
export async function probeAvailability(session: Session): Promise<boolean> {
	if (session.toolType !== 'claude-code') return true;

	// SSH-backed sessions: the usage sampler (`maestro-p --status` in
	// claude-usage-sampler.ts) runs LOCALLY and is keyed by the LOCAL account's
	// CLAUDE_CONFIG_DIR - it does NOT honor `sessionSshRemoteConfig` /
	// `wrapSpawnWithSsh`, so the cached snapshot describes the wrong machine's
	// account. Rather than make a remote-account decision from local numbers,
	// treat availability as UNKNOWN and fall back to the interval-based attempt
	// (resume-as-probe, like non-Claude providers): the resume runs on the remote,
	// and if it re-hits the limit Phase 2 re-pauses it for the next interval. If a
	// real remote `--status` probe is added later, run it here via wrapSpawnWithSsh.
	if (session.sessionSshRemoteConfig?.enabled) return true;

	const snapshot = getClaudeUsageSnapshotForSession(session);
	if (!snapshot) return false;
	if (snapshot.authState === 'unauthenticated') return false;

	return (
		snapshot.session.percent < LIMIT_THRESHOLD && snapshot.weekAllModels.percent < LIMIT_THRESHOLD
	);
}

/**
 * Re-sample Claude plan usage once per tick (best-effort), then pull the
 * refreshed map into the renderer mirror so `probeAvailability` reads current
 * numbers. Re-sampling spawns `maestro-p --status` per account on main, so we
 * do it once per tick covering every account rather than once per paused
 * session.
 */
async function refreshClaudeUsageForTick(): Promise<void> {
	try {
		await window.maestro.agents.refreshClaudeUsageSnapshots();
	} catch (err) {
		// Best-effort: fall back to whatever's already cached in the mirror.
		logger.warn('Claude usage re-sample failed; using cached snapshot', LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
	try {
		await useClaudeUsageStore.getState().refresh();
	} catch {
		// refresh() already swallows its own IPC errors; guard anyway.
	}
}

// ============================================================================
// Session mutations
// ============================================================================

/**
 * Patch a session's `agentError` (and the matching tab copy) in place, keyed on
 * the error timestamp so a newer error isn't clobbered. No-op if the session
 * has no agent error or the updater returns the same object.
 */
function patchAgentError(
	sessionId: string,
	updater: (err: NonNullable<Session['agentError']>) => NonNullable<Session['agentError']>
): void {
	updateSessionWith(sessionId, (s) => {
		if (!s.agentError) return s;
		const patched = updater(s.agentError);
		if (patched === s.agentError) return s;
		const ts = s.agentError.timestamp;
		return {
			...s,
			agentError: patched,
			aiTabs: s.aiTabs.map((tab) =>
				tab.agentError?.timestamp === ts ? { ...tab, agentError: patched } : tab
			),
		};
	});
}

/**
 * Find a captured in-flight direct send (a prompt that hit the limit but was
 * never queued, so the queue drainer won't replay it). Phase 2 stashes it as
 * `recoveryAction.lastUserPrompt` on the error log entry of the paused tab.
 */
function findCapturedPrompt(
	session: Session
): { tabId: string; text: string; logId: string } | null {
	const tab =
		session.aiTabs.find((t) => t.id === session.agentErrorTabId) ??
		session.aiTabs.find((t) => t.agentError?.timestamp === session.agentError?.timestamp);
	if (!tab) return null;
	for (let i = tab.logs.length - 1; i >= 0; i--) {
		const log = tab.logs[i];
		const prompt = log.recoveryAction?.lastUserPrompt;
		if (prompt) return { tabId: tab.id, text: prompt, logId: log.id };
	}
	return null;
}

/**
 * Enqueue a captured direct send at the front of the session's execution queue
 * and consume its `recoveryAction` so it only fires once. Done WHILE the session
 * is still in the error state (the drainer ignores non-idle sessions); the
 * subsequent `clearAgentError` flips it to idle and the runtime-recovery effect
 * dispatches the queue front-to-back, preserving order.
 */
function enqueueCapturedPrompt(
	sessionId: string,
	captured: { tabId: string; text: string; logId: string }
): void {
	const item: QueuedItem = {
		id: generateId(),
		timestamp: Date.now(),
		tabId: captured.tabId,
		type: 'message',
		text: captured.text,
	};
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: [item, ...s.executionQueue],
		aiTabs: s.aiTabs.map((tab) =>
			tab.id === captured.tabId
				? {
						...tab,
						logs: tab.logs.map((log) =>
							log.id === captured.logId ? { ...log, recoveryAction: undefined } : log
						),
					}
				: tab
		),
	}));
}

// ============================================================================
// Resume
// ============================================================================

/**
 * Resume a single limit-paused session, dispatching by run kind. Increments
 * `resumeAttemptCount` BEFORE attempting so backoff/telemetry observe it.
 */
function resume(session: Session, resumeAutoRunAfterError: (sessionId: string) => void): void {
	patchAgentError(session.id, (err) => ({
		...err,
		resumeAttemptCount: (err.resumeAttemptCount ?? 0) + 1,
	}));

	// After an app restart this batch state is gone: batchStore is in-memory and
	// is intentionally NOT reconstructed on cold start. So a session that paused
	// mid Auto Run before the restart has no `batch` here and falls through to the
	// standard path below - it clears the error, the persisted executionQueue
	// drains, and the agent continues from its own transcript via the native
	// `--resume`. The orchestration LOOP does not resume; the agent session and
	// its queued work do. (Within a single app run, the loop state is still live
	// and this takes the Auto Run branch.)
	const batch = useBatchStore.getState().batchRunStates[session.id];
	const isAutoRunPaused = !!batch && batch.errorPaused === true;

	if (isAutoRunPaused) {
		// Spec- or goal-driven: one entry point unblocks both (it resolves the
		// shared errorResolution promise the runners await and clears the error).
		logger.info('Resuming Auto Run after limit', LOG_CONTEXT, {
			sessionId: session.id,
			goalMode: batch.goalMode === true,
		});
		resumeAutoRunAfterError(session.id);
		return;
	}

	// Standard query: re-fire a captured direct send (prepended while still
	// paused), then clear the error so the session goes idle and the queue
	// drains.
	const captured = findCapturedPrompt(session);
	if (captured) {
		enqueueCapturedPrompt(session.id, captured);
	}
	logger.info('Resuming standard session after limit', LOG_CONTEXT, {
		sessionId: session.id,
		refiredCapturedPrompt: !!captured,
	});
	useAgentStore.getState().clearAgentError(session.id);
}

/**
 * Fire one green "Resumed" toast for a resumed session. Uses the pre-resume
 * session snapshot so the tab id (cleared by the resume) is still available for
 * click-to-jump. The session's own display name is preferred for the agent name
 * (falling back to the provider display name) so a user with several agents can
 * tell which one came back.
 */
function fireResumedToast(session: Session): void {
	const agentName = session.name?.trim() || getAgentDisplayName(session.toolType);
	notifyToast({
		color: 'green',
		title: 'Resumed',
		message: `${agentName} resumed - credits available`,
		project: session.name,
		clickAction: { kind: 'jump-session', sessionId: session.id, tabId: session.agentErrorTabId },
	});
}

// ============================================================================
// Give up (time-based)
// ============================================================================

/**
 * Resolve the give-up anchor for a limit-paused session and remember it in the
 * cross-tick map. Order of preference: an anchor already tracked this app
 * session (survives a resume-then-re-hit so the window doesn't reset) > the
 * persisted `limitPausedAt` (rebuilds the window after a restart) > the error
 * timestamp (first pause) > now. Also keeps the persisted `limitPausedAt` in
 * sync with the live anchor so a restart measures the same window.
 */
function resolveGiveUpAnchor(
	giveUp: Map<string, GiveUpTracking>,
	session: Session,
	now: number
): number {
	const existing = giveUp.get(session.id);
	const err = session.agentError;
	const anchor = existing?.anchor ?? err?.limitPausedAt ?? err?.timestamp ?? now;
	giveUp.set(session.id, { anchor, toastFired: existing?.toastFired ?? false });
	if (err && err.limitPausedAt !== anchor) {
		patchAgentError(session.id, (e) =>
			e.limitPausedAt === anchor ? e : { ...e, limitPausedAt: anchor }
		);
	}
	return anchor;
}

/**
 * Drop give-up tracking for any session that is no longer limit-paused - i.e. it
 * resumed successfully (or the user cleared it). This is what makes a LATER limit
 * start a fresh give-up window. A resume that immediately re-hits the limit does
 * NOT prune here: ticks are hours apart while a re-hit re-pauses within seconds,
 * so by the next tick the session is limit-paused again and its anchor survives.
 */
function pruneGiveUpTracking(
	giveUp: Map<string, GiveUpTracking>,
	limitPausedIds: Set<string>
): void {
	for (const id of [...giveUp.keys()]) {
		if (!limitPausedIds.has(id)) giveUp.delete(id);
	}
}

/**
 * Fire one distinct give-up toast (orange, sticky) telling the user auto-resume
 * has stopped for this session and they must resume manually. Trigger is purely
 * time-based (the give-up window), never an attempt count.
 */
function fireGaveUpToast(session: Session, giveUpDays: number): void {
	const agentName = session.name?.trim() || getAgentDisplayName(session.toolType);
	const dayWord = giveUpDays === 1 ? 'day' : 'days';
	notifyToast({
		color: 'orange',
		title: 'Auto-resume stopped',
		message: `${agentName}: auto-resume gave up after ${giveUpDays} ${dayWord} of repeated limits - resume manually`,
		project: session.name,
		dismissible: true,
		clickAction: { kind: 'jump-session', sessionId: session.id, tabId: session.agentErrorTabId },
	});
}

// ============================================================================
// Tick
// ============================================================================

/**
 * One coordinator pass: select limit-paused + eligible sessions, stamp their
 * pause-start, give up on any past their time-based cutoff, then probe
 * availability and resume the clear ones. `inFlight` guards against a later tick
 * starting a second probe/resume for a session still mid-resume from this one.
 */
export async function runAutoResumeTick(
	inFlight: Set<string>,
	resumeAutoRunAfterError: (sessionId: string) => void,
	options: RunAutoResumeTickOptions = {}
): Promise<void> {
	const { giveUp = new Map(), giveUpDays = DEFAULT_GIVE_UP_DAYS, now = Date.now() } = options;

	const sessions = useSessionStore.getState().sessions;
	const limitPaused = sessions.filter(isLimitPausedSession);

	// A session that left the limit-paused state resumed successfully (or was
	// cleared by the user); forget its give-up window so a future limit is fresh.
	pruneGiveUpTracking(giveUp, new Set(limitPaused.map((s) => s.id)));

	const candidates = limitPaused.filter((s) => isEligibleToProbe(s, now));
	if (candidates.length === 0) return;

	// Give-up pass: resolve each candidate's give-up anchor (which also stamps the
	// persisted `limitPausedAt` for the give-up window), then park any candidate
	// past its time-based cutoff and fire one toast. Probing is cheap, so
	// everything inside the window keeps retrying on the normal interval - the
	// cutoff is the ONLY thing that ends retries, never an attempt count.
	const retryable: Session[] = [];
	for (const session of candidates) {
		const anchor = resolveGiveUpAnchor(giveUp, session, now);
		if (now >= anchor + Math.max(1, giveUpDays) * MS_PER_DAY) {
			const tracking = giveUp.get(session.id);
			if (tracking && !tracking.toastFired) {
				tracking.toastFired = true;
				fireGaveUpToast(session, giveUpDays);
			}
			continue; // leave it paused; stop auto-retrying this one
		}
		retryable.push(session);
	}
	if (retryable.length === 0) return;

	// Re-sample Claude usage once per tick if any retryable candidate is Claude.
	if (retryable.some((s) => s.toolType === 'claude-code')) {
		await refreshClaudeUsageForTick();
	}

	for (const session of retryable) {
		// Don't start a second probe/resume for a session already mid-resume.
		if (inFlight.has(session.id)) continue;
		inFlight.add(session.id);

		void (async () => {
			try {
				const available = await probeAvailability(session);
				if (!available) return; // stay paused; retried next interval
				resume(session, resumeAutoRunAfterError);
				fireResumedToast(session);
			} catch (err) {
				logger.warn('Auto-resume probe/resume failed', LOG_CONTEXT, {
					sessionId: session.id,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				inFlight.delete(session.id);
			}
		})();
	}
}

// ============================================================================
// Hook
// ============================================================================

export function useAutoResumeCoordinator(deps: UseAutoResumeCoordinatorDeps): void {
	const enabled = useSettingsStore((s) => s.autoResumeOnLimit);
	const intervalHours = useSettingsStore((s) => s.autoResumeCheckIntervalHours);
	const giveUpDays = useSettingsStore((s) => s.autoResumeGiveUpDays);

	// Always call the latest resume fn / give-up window from the interval without
	// recreating the timer on every render.
	const resumeRef = useRef(deps.resumeAutoRunAfterError);
	resumeRef.current = deps.resumeAutoRunAfterError;
	const giveUpDaysRef = useRef(giveUpDays);
	giveUpDaysRef.current = giveUpDays;

	// Session ids with an in-flight probe/resume - persists across ticks.
	const inFlightRef = useRef<Set<string>>(new Set());

	// Per-session give-up bookkeeping - persists across ticks (rebuilt from
	// persisted limitPausedAt after a restart). See GiveUpTracking.
	const giveUpRef = useRef<Map<string, GiveUpTracking>>(new Map());

	useEffect(() => {
		// Disabled: no timer, nothing scheduled (the cleanup of any prior timer
		// already ran when `enabled` flipped, so there's nothing to clear here).
		if (!enabled) return;

		const periodMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
		const tick = () => {
			void runAutoResumeTick(inFlightRef.current, resumeRef.current, {
				giveUp: giveUpRef.current,
				giveUpDays: giveUpDaysRef.current,
			});
		};

		// Prompt first tick after mount so a day-later restart probes quickly
		// rather than waiting a full interval.
		const kickoff = setTimeout(tick, INITIAL_TICK_DELAY_MS);
		const timer = setInterval(tick, periodMs);

		return () => {
			clearTimeout(kickoff);
			clearInterval(timer);
		};
	}, [enabled, intervalHours]);
}
