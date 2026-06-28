/**
 * Limit Reset Estimator
 *
 * Best-effort: estimate when a paused agent's provider limit window is expected
 * to reopen, so the auto-resume coordinator (Phase 3) can schedule its next
 * probe instead of polling blindly on the fixed interval.
 *
 * Claude is the only provider with a reliable signal today - the
 * `maestro-p --status` snapshot cached in `claudeUsageStore` carries the
 * session (5-hour) and weekly reset times. Every other provider returns
 * `undefined`; the coordinator falls back to its fixed probe interval there.
 *
 * Never throws - callers treat the result as advisory.
 */

import { getSnapshot, resolveConfigDirKey } from '../stores/claudeUsageStore';

/**
 * Epoch ms when `agentId`'s limit window is expected to reopen, or `undefined`
 * when there's no reliable signal.
 *
 * For Claude: reads the cached usage snapshot for the account and returns the
 * nearest FUTURE reset across the 5-hour session and 7-day all-models windows
 * (the two windows the mode selector treats as limits). A snapshot whose resets
 * are all in the past - or that is missing/expired - yields `undefined`.
 *
 * `claudeConfigDir` selects the account; when omitted, the process
 * `CLAUDE_CONFIG_DIR` (falling back to `~/.claude`) is used.
 */
export function getLimitResetAt(agentId: string, claudeConfigDir?: string): number | undefined {
	// Claude Code is the only provider with a reliable reset signal today.
	if (agentId !== 'claude-code') {
		return undefined;
	}

	const key = resolveConfigDirKey(
		claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : process.env
	);
	const snapshot = getSnapshot(key);
	if (!snapshot) {
		return undefined;
	}

	const now = Date.now();
	const futureResets = [snapshot.session.resetsAt, snapshot.weekAllModels.resetsAt]
		.map((iso) => new Date(iso).getTime())
		.filter((ms) => Number.isFinite(ms) && ms > now);

	if (futureResets.length === 0) {
		return undefined;
	}
	return Math.min(...futureResets);
}
