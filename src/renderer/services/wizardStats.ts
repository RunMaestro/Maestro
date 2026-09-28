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
 * intact, and `endedAt` tracks last activity rather than close, so
 * `endedAt - startedAt` is always real time spent talking to the wizard.
 *
 * All writes are fire-and-forget: analytics must never block or break a wizard.
 */

import type { WizardRun } from '../../shared/stats-types';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';

/**
 * Live runs by key. The key is the caller's stable handle on the run: the AI
 * tab id for the inline wizard, `ONBOARDING_RUN_KEY` for the onboarding wizard.
 */
const activeRuns = new Map<string, WizardRun>();

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
	const run: WizardRun = {
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
		projectPath: init.projectPath,
	};
	activeRuns.set(key, run);
	flush(run);
}

/** Patch a live run and re-flush. No-op when the key has no run in flight. */
export function updateWizardRun(
	key: string,
	patch: Partial<Pick<WizardRun, 'mode' | 'agentType' | 'projectPath'>>
): void {
	const run = activeRuns.get(key);
	if (!run) return;
	Object.assign(run, patch);
	run.endedAt = Date.now();
	flush(run);
}

/** Count one user message sent to the wizard. */
export function countWizardExchange(key: string): void {
	const run = activeRuns.get(key);
	if (!run) return;
	run.exchanges += 1;
	run.endedAt = Date.now();
	flush(run);
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
	const run = activeRuns.get(key);
	if (!run) return;
	run.documents = totals.documents;
	run.tasks = totals.tasks;
	run.outcome = totals.documents > 0 ? 'generated' : run.outcome;
	run.endedAt = Date.now();
	flush(run);
}

/**
 * Close a run. A run that produced documents settles as 'generated' whatever
 * happens afterwards; one that produced none settles as 'abandoned'.
 */
export function finishWizardRun(key: string): void {
	const run = activeRuns.get(key);
	if (!run) return;
	activeRuns.delete(key);
	run.outcome = run.documents > 0 ? 'generated' : 'abandoned';
	run.endedAt = Date.now();
	flush(run);
}

/**
 * Record a run that was only observed at its end - the onboarding wizard hands
 * over a duration and totals in one callback rather than reporting milestones.
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
	flush({
		id: generateId(),
		sessionId: init.sessionId,
		agentType: init.agentType,
		surface: init.surface,
		mode: init.mode,
		outcome: init.documents > 0 ? 'generated' : 'abandoned',
		startedAt: endedAt - Math.max(0, init.durationMs),
		endedAt,
		exchanges: init.exchanges,
		documents: init.documents,
		tasks: init.tasks,
		projectPath: init.projectPath,
	});
}

/** Test seam: drop all in-flight runs without flushing them. */
export function resetWizardRunsForTest(): void {
	activeRuns.clear();
}
