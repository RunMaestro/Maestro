/**
 * wizardStats - records Auto Run wizard usage into the stats database.
 *
 * One shared recorder for BOTH wizard surfaces: the inline `/wizard` command
 * (`useInlineWizard`, keyed per AI tab) and the first-run onboarding wizard
 * (`MaestroWizard`, a single run at a time). They have very different shapes but
 * answer the same four questions - how long, how often, how many documents, how
 * many tasks - so the row shape and the flush live here once.
 *
 * ## Why upsert instead of a single write at the end
 *
 * A wizard run's payoff (documents written) and its close are separated by
 * however long the user spends reading the result, and plenty of runs are never
 * closed at all - the app quits, the tab closes, the user walks away. Writing
 * only at close would drop those runs entirely, including their documents. So
 * every milestone re-flushes the WHOLE row under a stable id; `INSERT OR
 * REPLACE` in the main process makes that idempotent and never double-counts.
 *
 * A run that is never finished stays `outcome: 'in-progress'` with its counts
 * intact.
 *
 * ## Why time is accrued, not measured as open-to-close
 *
 * A wizard tab can stay open for days. `endedAt - startedAt` would then count
 * every hour the tab sat idle, and one run left open overnight swamped all the
 * real use (a 9-message run once logged 26 hours). So `activeMs` is accrued gap
 * by gap between milestones: a gap while the agent is working counts in full
 * (that is the agent's time, however long a generation takes), and a gap while
 * the wizard waits on the user counts only up to `USER_GAP_CAP_MS` (reading a
 * reply, typing the next message). Idle time past the cap is not wizard time.
 *
 * All writes are fire-and-forget: analytics must never block or break a wizard.
 */

import type { WizardRun } from '../../shared/stats-types';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';

/**
 * Most of one user gap that counts as wizard time: reading the agent's reply,
 * thinking, typing or dictating the next message. Anything longer is the user
 * away from the wizard.
 */
export const USER_GAP_CAP_MS = 5 * 60_000;

/**
 * Most of one agent turn that counts. A real turn (even a long document
 * generation) is well under this; a turn that runs longer is a hung agent, not
 * work the user spent in the wizard.
 */
export const AGENT_TURN_CAP_MS = 60 * 60_000;

/** A run plus the accrual state that never leaves the renderer. */
interface LiveRun {
	row: WizardRun & { activeMs: number };
	/** Epoch ms of the last milestone; the next gap is measured from here. */
	lastActivityAt: number;
	/** True while an agent turn or a document generation is in flight. */
	agentWorking: boolean;
}

/**
 * Live runs by key. The key is the caller's stable handle on the run: the AI
 * tab id for the inline wizard, `ONBOARDING_RUN_KEY` for the onboarding wizard.
 */
const activeRuns = new Map<string, LiveRun>();

/** Key for the onboarding wizard, which only ever has one run in flight. */
export const ONBOARDING_RUN_KEY = 'onboarding-wizard';

/**
 * Push the current state of a run to the stats database. Never throws.
 *
 * Deliberately defensive about the bridge itself, not just the call: this runs
 * inside the wizard's own lifecycle, so a missing or partially-stubbed
 * `window.maestro` must degrade to "no analytics", never to a broken wizard.
 */
function flush(run: WizardRun): void {
	const record = window.maestro?.stats?.recordWizardRun;
	if (typeof record !== 'function') return;
	// Promise.resolve() rather than a bare .catch(), for the same reason: a stub
	// that returns a non-promise must not turn analytics into a thrown error.
	void Promise.resolve(record(run)).catch((err: unknown) => {
		logger.warn('Failed to record wizard run', '[WizardStats]', { error: String(err) });
	});
}

/**
 * Close the gap since the last milestone into `activeMs`, capped by who was
 * holding the turn, and stamp `endedAt` as this milestone.
 */
function accrue(live: LiveRun): void {
	const now = Date.now();
	const gap = Math.max(0, now - live.lastActivityAt);
	live.row.activeMs += Math.min(gap, live.agentWorking ? AGENT_TURN_CAP_MS : USER_GAP_CAP_MS);
	live.lastActivityAt = now;
	live.row.endedAt = now;
}

/**
 * Open a run. Safe to call again for the same key - a wizard restarted on a tab
 * whose previous run was never finished closes that one out first, so the
 * abandoned run keeps its counts instead of being overwritten by the new one.
 */
export function beginWizardRun(
	key: string,
	init: {
		sessionId: string;
		agentType: string;
		surface: WizardRun['surface'];
		mode?: WizardRun['mode'];
		projectPath?: string;
	}
): void {
	finishWizardRun(key);

	const now = Date.now();
	const row: LiveRun['row'] = {
		id: generateId(),
		sessionId: init.sessionId,
		agentType: init.agentType,
		surface: init.surface,
		// The inline wizard settles new-vs-iterate only after intent parsing, so
		// a run starts as 'new' and updateWizardRun corrects it moments later.
		mode: init.mode ?? 'new',
		outcome: 'in-progress',
		startedAt: now,
		endedAt: now,
		exchanges: 0,
		documents: 0,
		tasks: 0,
		activeMs: 0,
		projectPath: init.projectPath,
	};
	activeRuns.set(key, { row, lastActivityAt: now, agentWorking: false });
	flush(row);
}

/** Patch a live run and re-flush. No-op when the key has no run in flight. */
export function updateWizardRun(
	key: string,
	patch: Partial<Pick<WizardRun, 'mode' | 'agentType' | 'projectPath'>>
): void {
	const live = activeRuns.get(key);
	if (!live) return;
	Object.assign(live.row, patch);
	accrue(live);
	flush(live.row);
}

/** Count one user message sent to the wizard. */
export function countWizardExchange(key: string): void {
	const live = activeRuns.get(key);
	if (!live) return;
	live.row.exchanges += 1;
	accrue(live);
	flush(live.row);
}

/**
 * Mark the start or end of agent work: a conversation turn or a document
 * generation. Every agent call must be bracketed by `true` then `false` -
 * a turn left marked as working counts its gaps up to `AGENT_TURN_CAP_MS`
 * instead of `USER_GAP_CAP_MS`.
 */
export function setWizardAgentWorking(key: string, working: boolean): void {
	const live = activeRuns.get(key);
	if (!live || live.agentWorking === working) return;
	accrue(live);
	live.agentWorking = working;
	flush(live.row);
}

/**
 * Record what a generation pass produced. Called with the run's TOTALS, not a
 * delta, so a second generation pass in the same conversation replaces rather
 * than accumulates - the row should describe the documents that exist, not
 * every draft that was streamed.
 */
export function recordWizardDocuments(
	key: string,
	totals: { documents: number; tasks: number }
): void {
	const live = activeRuns.get(key);
	if (!live) return;
	const { row } = live;
	row.documents = totals.documents;
	row.tasks = totals.tasks;
	row.outcome = totals.documents > 0 ? 'generated' : row.outcome;
	accrue(live);
	flush(row);
}

/**
 * Close a run. A run that produced documents settles as 'generated' whatever
 * happens afterwards; one that produced none settles as 'abandoned'. The gap
 * before the close accrues like any other, so a tab closed days later adds at
 * most `USER_GAP_CAP_MS`.
 */
export function finishWizardRun(key: string): void {
	const live = activeRuns.get(key);
	if (!live) return;
	activeRuns.delete(key);
	accrue(live);
	live.row.outcome = live.row.documents > 0 ? 'generated' : 'abandoned';
	flush(live.row);
}

/**
 * Record a run that was only observed at its end - the onboarding wizard hands
 * over a duration and totals in one callback rather than reporting milestones.
 * That duration is taken as active time: the onboarding wizard is a full-window
 * flow that lives inside one app session, not a tab that can sit open for days.
 */
export function recordCompletedWizardRun(init: {
	sessionId: string;
	agentType: string;
	surface: WizardRun['surface'];
	mode: WizardRun['mode'];
	durationMs: number;
	exchanges: number;
	documents: number;
	tasks: number;
	projectPath?: string;
}): void {
	const endedAt = Date.now();
	const durationMs = Math.max(0, init.durationMs);
	flush({
		id: generateId(),
		sessionId: init.sessionId,
		agentType: init.agentType,
		surface: init.surface,
		mode: init.mode,
		outcome: init.documents > 0 ? 'generated' : 'abandoned',
		startedAt: endedAt - durationMs,
		endedAt,
		exchanges: init.exchanges,
		documents: init.documents,
		tasks: init.tasks,
		activeMs: durationMs,
		projectPath: init.projectPath,
	});
}

/** Test seam: drop all in-flight runs without flushing them. */
export function resetWizardRunsForTest(): void {
	activeRuns.clear();
}
