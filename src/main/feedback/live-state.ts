/**
 * Main half of the Feedback chat's self-diagnosis: read every window's live
 * state out of its own renderer, add the recent warnings and errors from the
 * log, and redact the result the way the support package does.
 *
 * `webContents.executeJavaScript` rather than a `webContents.debugger` (CDP)
 * session: it is the same in-process evaluation `Runtime.evaluate` would do,
 * without attaching a debugger that can collide with open DevTools or an
 * external CDP client, and without a detach to get wrong.
 *
 * Never throws. A window that does not answer within the budget is skipped,
 * and no answer at all is reported as `rendererAvailable: false` so the agent
 * knows to fall back on `maestro-cli` instead of concluding nothing is wrong.
 */

import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { sanitizeLogMessage } from '../debug-package/collectors/sanitize';
import {
	FEEDBACK_LIVE_STATE_GLOBAL,
	type FeedbackLiveDiagnosis,
	type FeedbackLogLine,
	type FeedbackRendererLiveState,
} from '../../shared/feedbackLiveState';

const LOG_CONTEXT = '[FeedbackLiveState]';
/** Per-window budget. The capture is a synchronous store read; this is slack. */
const RENDERER_TIMEOUT_MS = 3_000;
/** Recent warnings and errors to include, newest kept. */
const MAX_PROBLEM_LINES = 25;
/** Older problems are history, not the issue being reported. */
const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000;

const EXPRESSION = `(() => { const f = window[${JSON.stringify(
	FEEDBACK_LIVE_STATE_GLOBAL
)}]; return typeof f === 'function' ? f() : null; })()`;

async function readWindow(win: BrowserWindow): Promise<FeedbackRendererLiveState | null> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			win.webContents.executeJavaScript(
				EXPRESSION,
				true
			) as Promise<FeedbackRendererLiveState | null>,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), RENDERER_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		logger.warn('Failed to read live state from a window', LOG_CONTEXT, { error: String(error) });
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function recentProblems(now: number): FeedbackLogLine[] {
	try {
		return readRecentProblems(now);
	} catch {
		return [];
	}
}

function readRecentProblems(now: number): FeedbackLogLine[] {
	return logger
		.getLogs()
		.filter(
			(entry) =>
				(entry.level === 'error' || entry.level === 'warn') &&
				entry.timestamp > now - PROBLEM_WINDOW_MS &&
				entry.context !== LOG_CONTEXT
		)
		.slice(-MAX_PROBLEM_LINES)
		.map((entry) => ({
			timestamp: entry.timestamp,
			level: entry.level,
			context: entry.context,
			message: sanitizeLogMessage(entry.message),
		}));
}

/** Capture the live diagnosis. See the module comment for what and why. */
export async function captureFeedbackLiveDiagnosis(): Promise<FeedbackLiveDiagnosis> {
	const now = Date.now();
	let windows: BrowserWindow[] = [];
	try {
		windows = BrowserWindow.getAllWindows();
	} catch {
		// No Electron (tests, a headless context): report the renderer as unavailable.
	}
	const states = (await Promise.all(windows.map(readWindow))).filter(
		(state): state is FeedbackRendererLiveState => !!state && Array.isArray(state.agents)
	);

	// Each window holds its own copy of the agent list; the first one to report
	// an agent wins, and Auto Run counters are deduped the same way.
	const agents = new Map<string, FeedbackRendererLiveState['agents'][number]>();
	const autoRuns = new Map<string, FeedbackRendererLiveState['autoRunSnapshots'][number]>();
	let agentCount = 0;
	for (const state of states) {
		agentCount = Math.max(agentCount, state.agentCount);
		for (const agent of state.agents) {
			if (agents.has(agent.id)) continue;
			agents.set(
				agent.id,
				agent.error?.message
					? {
							...agent,
							error: { ...agent.error, message: sanitizeLogMessage(agent.error.message) },
						}
					: agent
			);
		}
		for (const run of state.autoRunSnapshots ?? []) {
			if (!autoRuns.has(run.sessionId)) autoRuns.set(run.sessionId, run);
		}
	}

	return {
		capturedAt: now,
		rendererAvailable: states.length > 0,
		agentCount,
		agents: [...agents.values()],
		autoRunSnapshots: [...autoRuns.values()],
		settings: states[0]?.settings,
		recentProblems: recentProblems(now),
	};
}
