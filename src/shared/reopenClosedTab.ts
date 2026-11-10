/**
 * Wire shape for the `reopen_closed_tab` message - the CLI half of Reopen Closed
 * Tab (Cmd+Shift+T, the command palette entry).
 *
 * A round trip rather than a fire-and-forget send: the closed-tab history lives
 * only in the renderer's session store (it is never persisted), so only the
 * renderer can say what came back, or that there was nothing to reopen.
 */

export type ReopenedTabType = 'ai' | 'file' | 'browser' | 'terminal';

const REOPENED_TAB_TYPES: readonly ReopenedTabType[] = ['ai', 'file', 'browser', 'terminal'];

export type ReopenClosedTabResult =
	| {
			success: true;
			/** The restored tab, or the already-open tab a duplicate hit switched to. */
			tabId: string;
			tabType: ReopenedTabType;
			/** True when the closed tab was still open, so nothing was restored. */
			wasDuplicate: boolean;
			/** True when the agent's active tab was left where it was. */
			background: boolean;
	  }
	| { success: false; error: string };

/** The error text for an agent with nothing in its closed-tab history. */
export const NOTHING_TO_REOPEN_ERROR = 'No closed tab to reopen';

/**
 * Coerce whatever the renderer answered into a {@link ReopenClosedTabResult}.
 * Runs in the main process, which must never forward a half-formed success.
 */
export function normalizeReopenClosedTabResult(raw: unknown): ReopenClosedTabResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid reopen response' };
	}
	const candidate = raw as Record<string, unknown>;
	if (
		candidate.success !== true ||
		typeof candidate.tabId !== 'string' ||
		!REOPENED_TAB_TYPES.includes(candidate.tabType as ReopenedTabType)
	) {
		return {
			success: false,
			error:
				typeof candidate.error === 'string' && candidate.error
					? candidate.error
					: 'Reopen closed tab failed',
		};
	}
	return {
		success: true,
		tabId: candidate.tabId,
		tabType: candidate.tabType as ReopenedTabType,
		wasDuplicate: candidate.wasDuplicate === true,
		background: candidate.background === true,
	};
}
