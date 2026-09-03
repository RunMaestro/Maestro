/**
 * QuotaLimitEvidence - the "which limit, and can I do anything about it?" rows
 * shown under a plan-limit notice.
 *
 * Claude Code's own banner collapses to one sentence ("You've hit your session
 * limit · resets 7pm"), which cannot distinguish the 5-hour window from the
 * weekly one, does not say whether paid extra usage applies, and does not say
 * whether the stop is recoverable. The structured `quotaLimits` payload riding
 * on the same message answers all three; this renders that answer.
 *
 * Renders NOTHING when the payload carried no quota object - a provider or
 * transport that only forwarded the message envelope leaves the plain notice
 * text as the whole story, and an empty evidence block that says less than the
 * sentence above it is worse than no block at all.
 *
 * Used by both surfaces a limit can appear on: the auto-retry outage card
 * (`RetryStatusCard`) and the blocking error modal (`AgentErrorModal`).
 */

import React from 'react';

import { formatFutureTime } from '../../../shared/formatters';
import {
	describeQuotaRemedy,
	describeQuotaWindow,
	type QuotaLimitDetail,
} from '../../../shared/quotaLimitDetail';
import type { Theme } from '../../types';

interface QuotaLimitEvidenceProps {
	detail: QuotaLimitDetail | undefined;
	theme: Theme;
	/**
	 * Omit the window name when the caller already renders it as its own heading
	 * (the outage card titles itself with `describeQuotaWindow`), so the same
	 * words don't appear twice a line apart.
	 */
	hideWindowName?: boolean;
}

export function QuotaLimitEvidence({
	detail,
	theme,
	hideWindowName,
}: QuotaLimitEvidenceProps): React.ReactElement | null {
	if (!detail) return null;

	const remedy = describeQuotaRemedy(detail);
	const showWindow = !hideWindowName;
	// `resetsAt` in the past means the sample is stale rather than that the window
	// is open, and `formatFutureTime` renders that as "just now" - which would
	// read as "your limit reset a moment ago" beside a banner saying it is still
	// blocked. Drop the row instead.
	const resetsAt = detail.resetsAt && detail.resetsAt > Date.now() ? detail.resetsAt : undefined;

	if (!showWindow && !remedy && !resetsAt) return null;

	return (
		<div
			className="flex flex-col gap-1 text-xs"
			style={{ color: theme.colors.textDim }}
			data-testid="quota-limit-evidence"
		>
			{showWindow && (
				<span>
					<span style={{ color: theme.colors.textMain }}>{describeQuotaWindow(detail)}</span>
					{detail.window === 'unknown' && detail.windowRaw ? ` (${detail.windowRaw})` : ''}
				</span>
			)}
			{resetsAt !== undefined && <span>Resets {formatFutureTime(resetsAt)}.</span>}
			{remedy !== undefined && <span data-testid="quota-limit-remedy">{remedy}</span>}
		</div>
	);
}
