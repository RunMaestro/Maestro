/**
 * Cue auth-expiry detection.
 *
 * Cue spawns agents itself (see cue-process-lifecycle) instead of going through
 * the ProcessManager, so none of the streaming error classification that backs
 * `agent:error` ever sees a pipeline run. The practical consequence was that an
 * expired provider token took every pipeline down silently: runs kept failing
 * in the background and the user only found out when they typed a message by
 * hand hours later.
 *
 * This module closes that gap by running the SAME pattern bank over a finished
 * run's output and, on a match, telling the renderer to open the
 * re-authentication terminal for the owning agent.
 */

import type { BrowserWindow } from 'electron';
import type { CueRunResult } from '../../shared/cue/contracts';
import type { ToolType } from '../../shared/types';
import { getErrorPatterns, matchErrorPattern } from '../parsers/error-patterns';
import { capabilitySnapshots } from '../agents/capability-snapshot';
import { isWebContentsAvailable } from '../utils/safe-send';
import { logger } from '../utils/logger';

/**
 * How much of a run's output to scan. An auth failure is announced up front and
 * the process dies right after, so the head and tail always carry it - while a
 * long successful-looking run can produce megabytes we have no reason to regex.
 */
const SCAN_CHARS = 4000;

/**
 * Detect an expired-credentials failure in a finished Cue run.
 *
 * Returns the provider's own error message when the run failed on auth, or
 * `null` for every other outcome (including successful runs).
 */
export function detectCueAuthFailure(result: CueRunResult, toolType: ToolType): string | null {
	if (result.status === 'completed') return null;

	const patterns = getErrorPatterns(toolType);
	// stderr first: an auth rejection is written there by every agent we
	// support, and it is the smaller haystack.
	const haystacks = [
		result.stderr.slice(0, SCAN_CHARS),
		result.stdout.slice(0, SCAN_CHARS),
		result.stdout.slice(-SCAN_CHARS),
	];

	for (const text of haystacks) {
		if (!text) continue;
		const match = matchErrorPattern(patterns, text);
		if (match?.type === 'auth_expired') return match.message;
	}

	return null;
}

/**
 * Providers already reported as needing a login, keyed by agent (and remote).
 *
 * Expired credentials fail EVERY run on that provider, and a busy board can
 * fire several a minute - without this, a user who dismisses the modal to
 * finish a thought gets it thrown back at them on the next tick. An entry is
 * dropped as soon as a run for that provider succeeds, which is the only
 * reliable signal that the new credentials took.
 */
const reportedProviders = new Set<string>();

function providerKey(toolType: ToolType, sshRemoteId?: string): string {
	return sshRemoteId ? `${toolType}@${sshRemoteId}` : toolType;
}

/** Test seam: forget which providers have already been reported. */
export function resetReportedAuthFailures(): void {
	reportedProviders.clear();
}

/**
 * Classify a finished Cue run and, when its provider rejected the stored
 * credentials, mark the agent's capability snapshot and ask the renderer to
 * open the re-authentication terminal.
 *
 * Never throws: this runs on the Cue completion path, where a reporting failure
 * must not take down the run bookkeeping that follows it.
 *
 * @returns true when this call raised the prompt. A repeat failure on an
 *   already-reported provider returns false: the prompt is already up (or was
 *   deliberately dismissed), and re-raising it would fight the user.
 */
export function reportCueAuthFailure(
	mainWindow: BrowserWindow | null,
	result: CueRunResult,
	toolType: ToolType,
	sshRemoteId?: string
): boolean {
	const key = providerKey(toolType, sshRemoteId);

	let message: string | null = null;
	try {
		message = detectCueAuthFailure(result, toolType);
	} catch (err) {
		logger.warn('Failed to classify Cue run for auth expiry', 'Cue', err);
		return false;
	}

	if (!message) {
		// A run that got through means the credentials work again, so the next
		// expiry is allowed to prompt.
		if (result.status === 'completed') reportedProviders.delete(key);
		return false;
	}

	if (reportedProviders.has(key)) return false;
	reportedProviders.add(key);

	logger.warn(
		`[CUE] "${result.subscriptionName}" failed on expired ${toolType} credentials - prompting for re-authentication`,
		'Cue',
		{ runId: result.runId, sessionId: result.sessionId }
	);

	// Same reactive classification the interactive error listener does, so the
	// Settings -> Agents pill flips to "Auth required" for a pipeline-only
	// failure too.
	capabilitySnapshots.markAuthRequired(toolType, message, sshRemoteId);

	if (!isWebContentsAvailable(mainWindow)) return true;
	try {
		mainWindow.webContents.send('agent:authExpired', {
			sessionId: result.sessionId,
			agentId: toolType,
			message,
			fromPipeline: true,
		});
	} catch (err) {
		logger.warn('Failed to send auth-expired notice to renderer', 'Cue', err);
	}

	return true;
}
