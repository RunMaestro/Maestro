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
 * Classify a finished Cue run and, when its provider rejected the stored
 * credentials, mark the agent's capability snapshot and tell the renderer which
 * agent is blocked.
 *
 * Deliberately does NOT deduplicate. Every blocked agent must be reported, even
 * when thirty of them share one expired token: the renderer's auth-outage store
 * groups them into a SINGLE prompt, and it can only resume an agent's queued
 * work if it was told that agent is blocked. An earlier version suppressed the
 * second and later reports here, which quietly made those agents unresumable.
 *
 * Never throws: this runs on the Cue completion path, where a reporting failure
 * must not take down the run bookkeeping that follows it.
 *
 * @returns true when the run failed on expired credentials.
 */
export function reportCueAuthFailure(
	mainWindow: BrowserWindow | null,
	result: CueRunResult,
	toolType: ToolType,
	sshRemoteId?: string
): boolean {
	let message: string | null = null;
	try {
		message = detectCueAuthFailure(result, toolType);
	} catch (err) {
		logger.warn('Failed to classify Cue run for auth expiry', 'Cue', err);
		return false;
	}
	if (!message) return false;

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
			sshRemoteId,
			message,
			fromPipeline: true,
		});
	} catch (err) {
		logger.warn('Failed to send auth-expired notice to renderer', 'Cue', err);
	}

	return true;
}
