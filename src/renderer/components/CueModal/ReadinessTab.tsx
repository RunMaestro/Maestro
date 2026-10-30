/**
 * ReadinessTab - Cue modal "Readiness" tab.
 *
 * Can this data directory run its pipelines unattended? The same report
 * `maestro-cli cue engine check` prints, read over `cue:checkReadiness`, and in
 * the same words (`formatCueReadinessSummary()` for the verdict, each gap's own
 * message, which already carries its remedy). Loads on open; Refresh re-runs
 * the check after the user fixes something.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { formatCueReadinessSummary, type CueReadinessReport } from '../../../shared/cue/readiness';
import { cueService } from '../../services/cue';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

interface ReadinessTabProps {
	theme: Theme;
}

export function ReadinessTab({ theme }: ReadinessTabProps) {
	const [report, setReport] = useState<CueReadinessReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const runCheck = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setReport(await cueService.checkReadiness());
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void runCheck();
	}, [runCheck]);

	const verdictColor = report?.ready ? theme.colors.success : theme.colors.error;

	return (
		<div className="flex-1 overflow-auto px-5 py-4 space-y-4">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					{report &&
						!error &&
						(report.ready ? (
							<CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: verdictColor }} />
						) : (
							<XCircle className="w-4 h-4 shrink-0" style={{ color: verdictColor }} />
						))}
					<span
						className="text-sm font-medium select-text"
						style={{ color: report && !error ? verdictColor : theme.colors.textDim }}
						data-testid="cue-readiness-summary"
					>
						{error
							? 'Readiness check failed'
							: report
								? formatCueReadinessSummary(report)
								: 'Checking readiness…'}
					</span>
				</div>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={() => void runCheck()}
					disabled={loading}
					icon={<RefreshCw />}
					testId="cue-readiness-refresh"
				>
					Refresh
				</HeaderActionButton>
			</div>

			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				Whether every agent, workspace, secret, and tool the enabled subscriptions need is in place
				to run Cue unattended. Same check as{' '}
				<code className="select-text">maestro-cli cue engine check</code>.
			</p>

			{loading && !report ? (
				<div
					className="flex items-center justify-center py-12 text-sm gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<Spinner size={16} />
					Checking readiness…
				</div>
			) : error ? (
				<div
					className="rounded-md px-3 py-2 text-sm select-text"
					style={{ backgroundColor: `${theme.colors.error}15`, color: theme.colors.error }}
					data-testid="cue-readiness-error"
				>
					{error}
				</div>
			) : report && report.gaps.length > 0 ? (
				<ul className="space-y-2" data-testid="cue-readiness-gaps">
					{report.gaps.map((gap, index) => (
						<li
							key={`${gap.kind}-${index}`}
							className="flex items-start gap-2 rounded-md px-3 py-2"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<MiniBadge
								label={gap.kind}
								theme={theme}
								color={theme.colors.warning}
								className="mt-0.5"
							/>
							<span
								className="text-sm select-text break-words min-w-0"
								style={{ color: theme.colors.textMain }}
							>
								{gap.message}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
