/**
 * DelegationScoreCard
 *
 * The Overview's headline answer to "how much of my AI work runs without me".
 * One number - the share of all retained AI time that came from Auto Run and
 * Cue rather than from a prompt you typed and waited on - drawn on a milestone
 * track at 25 / 50 / 75 / 100%.
 *
 * Two marks on one track, and they mean different things:
 *
 *   - The FILL runs to the highest milestone ever unlocked. It is a high-water
 *     mark held in settings, so a stretch of hands-on work can't take back a
 *     milestone already earned.
 *   - The MARKER is the live score, which moves in both directions. It is the
 *     number in the headline, so the card never shows a filled bar without also
 *     showing where you actually stand today.
 *
 * The score is time-based rather than turn-based: an Auto Run batch is a few
 * long turns while an afternoon of chat is hundreds of short ones, so counting
 * turns would report a heavily delegated day as barely delegated at all.
 */

import { memo, useEffect, useMemo } from 'react';
import { Info, Rocket } from 'lucide-react';
import type { Theme } from '../../types';
import type { DelegationTotals } from '../../../shared/delegation';
import {
	DELEGATION_MILESTONES,
	DELEGATION_MILESTONE_LABELS,
	delegatedMs,
	delegatedMsToReach,
	delegationPercent,
	highestMilestoneReached,
	nextMilestone,
	trackedMs,
	type DelegationMilestone,
} from '../../../shared/delegation';
import { formatDurationHuman } from '../../../shared/formatters';
import { HoverTooltip } from '../ui/HoverTooltip';
import { DelegationSplitBar } from './DelegationSplitBar';
import { DELEGATION_MILESTONE_GOLD } from './delegationColors';

interface DelegationScoreCardProps {
	/** Lifetime (all retained history) split. Null while loading or on failure. */
	totals: DelegationTotals | null;
	theme: Theme;
	colorBlindMode?: boolean;
	/** Highest milestone previously unlocked, from settings. */
	unlockedMilestone: number;
	/** Raise the stored high-water mark. Called only when the score has passed a new milestone. */
	onUnlockMilestone: (milestone: number) => void;
}

const TOOLTIP_LABEL = (
	<span>
		<strong>Delegated</strong> time is work that ran without you: Auto Run documents and Maestro Cue
		pipelines. Time you spent prompting an agent and waiting on the reply is interactive, and does
		not count.
		<br />
		<br />
		Move repeat work into an Auto Run document or a Cue trigger and this climbs. It counts every
		turn on record and all the Cue time Maestro has credited, so it moves down as well as up.
	</span>
);

export const DelegationScoreCard = memo(function DelegationScoreCard({
	totals,
	theme,
	colorBlindMode = false,
	unlockedMilestone,
	onUnlockMilestone,
}: DelegationScoreCardProps) {
	const percent = totals ? delegationPercent(totals) : 0;
	const reached = highestMilestoneReached(percent);
	const next = nextMilestone(percent);
	const hasData = !!totals && trackedMs(totals) > 0;

	// Persist a newly passed milestone. Guarded on the stored value so this is a
	// no-op on every refresh after the first, and the comparison runs against the
	// raw percentage: a 74.6% score renders as "75%" but has not earned the mark.
	useEffect(() => {
		if (!hasData) return;
		if (reached > unlockedMilestone) onUnlockMilestone(reached);
	}, [hasData, reached, unlockedMilestone, onUnlockMilestone]);

	// The fill is the larger of the two so the bar reflects the best you have
	// done, while a score that has since climbed past the stored mark (before the
	// effect above writes it) still shows immediately.
	const fillPercent = Math.max(unlockedMilestone, reached);

	const gapLabel = useMemo(() => {
		if (!totals || !next) return null;
		const needed = delegatedMsToReach(totals, next);
		if (!Number.isFinite(needed)) {
			// 100% is only reachable with zero interactive time on record, which
			// no real install has. Say so instead of printing an infinite gap.
			return 'Fully autonomous needs zero interactive time on record';
		}
		if (needed <= 0) return null;
		return `${formatDurationHuman(needed)} more delegated time to reach ${next}%`;
	}, [totals, next]);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="delegation-score-card"
			role="figure"
			aria-label={`Delegation score: ${Math.round(percent)} percent of tracked AI time ran without you`}
		>
			<div className="flex items-start justify-between gap-3 mb-3">
				<div className="flex items-center gap-2">
					<Rocket className="w-4 h-4" style={{ color: theme.colors.accent }} aria-hidden="true" />
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Delegation Score
					</h3>
					<HoverTooltip label={TOOLTIP_LABEL} theme={theme} maxWidth={360}>
						<button
							type="button"
							className="inline-flex items-center rounded"
							style={{ color: theme.colors.textDim }}
							aria-label="What counts as delegated work"
							data-testid="delegation-score-info"
						>
							<Info className="w-3.5 h-3.5" />
						</button>
					</HoverTooltip>
				</div>
				{unlockedMilestone > 0 && (
					<span
						className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap"
						style={{
							color: DELEGATION_MILESTONE_GOLD,
							border: `1px solid ${DELEGATION_MILESTONE_GOLD}66`,
						}}
						data-testid="delegation-milestone-badge"
					>
						{DELEGATION_MILESTONE_LABELS[unlockedMilestone as DelegationMilestone] ??
							`${unlockedMilestone}%`}
					</span>
				)}
			</div>

			<div className="flex items-baseline gap-2 mb-4">
				<span
					className="font-bold"
					style={{ color: theme.colors.textMain, fontSize: 'clamp(28px, 5vw, 42px)' }}
					data-testid="delegation-score-value"
				>
					{hasData ? `${Math.round(percent)}%` : '0%'}
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{hasData
						? 'of tracked AI time ran without you'
						: 'no AI time tracked yet - run an agent to start scoring'}
				</span>
			</div>

			{/* Milestone track */}
			<div className="relative mb-1" style={{ paddingBottom: 2 }}>
				<div
					className="relative w-full rounded-full overflow-hidden"
					style={{ height: 10, backgroundColor: theme.colors.border }}
				>
					<div
						className="h-full rounded-full"
						style={{
							width: `${Math.min(100, Math.max(0, fillPercent))}%`,
							background: `linear-gradient(90deg, ${theme.colors.accent}, ${DELEGATION_MILESTONE_GOLD})`,
							transition: 'width 500ms cubic-bezier(0.4, 0, 0.2, 1)',
						}}
						data-testid="delegation-milestone-fill"
					/>
					{/* Milestone ticks sit ON the track so a reached mark reads as part
					    of the fill rather than as a separate scale below it. */}
					{DELEGATION_MILESTONES.map((milestone) => (
						<span
							key={milestone}
							className="absolute top-0 bottom-0"
							style={{
								left: `${milestone}%`,
								width: 2,
								marginLeft: milestone === 100 ? -2 : 0,
								backgroundColor:
									fillPercent >= milestone ? `${theme.colors.bgMain}CC` : theme.colors.textDim,
								opacity: fillPercent >= milestone ? 0.8 : 0.5,
							}}
							aria-hidden="true"
						/>
					))}
				</div>

				{/* Live marker. Clamped inside the track so 0% and 100% stay visible. */}
				{hasData && (
					<span
						className="absolute rounded-full"
						style={{
							left: `${Math.min(99.5, Math.max(0.5, percent))}%`,
							top: -3,
							height: 16,
							width: 3,
							transform: 'translateX(-50%)',
							backgroundColor: theme.colors.textMain,
							boxShadow: `0 0 0 1px ${theme.colors.bgMain}`,
							transition: 'left 500ms cubic-bezier(0.4, 0, 0.2, 1)',
						}}
						data-testid="delegation-live-marker"
						aria-hidden="true"
					/>
				)}
			</div>

			{/* Tick labels are positioned at their own percentage rather than spaced
			    evenly: a `justify-between` row would print "25%" at the far left,
			    under the 0 mark, and read as a mislabeled axis. */}
			<div className="relative h-4 mb-3" aria-hidden="true">
				{DELEGATION_MILESTONES.map((milestone) => (
					<span
						key={milestone}
						className="absolute top-0 text-[10px]"
						style={{
							left: `${milestone}%`,
							transform: milestone === 100 ? 'translateX(-100%)' : 'translateX(-50%)',
							color: fillPercent >= milestone ? DELEGATION_MILESTONE_GOLD : theme.colors.textDim,
						}}
					>
						{milestone}%
					</span>
				))}
			</div>

			{/* What moves the number next */}
			<div className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
				{!hasData ? (
					<span>Auto Run and Cue runs are what count here.</span>
				) : next ? (
					<span data-testid="delegation-next-milestone">
						Next: {next}% {DELEGATION_MILESTONE_LABELS[next]}
						{gapLabel ? ` - ${gapLabel}` : ''}
					</span>
				) : (
					<span data-testid="delegation-next-milestone">
						Every tracked minute ran without you. Nothing left to delegate.
					</span>
				)}
			</div>

			{totals && (
				<DelegationSplitBar
					totals={totals}
					theme={theme}
					colorBlindMode={colorBlindMode}
					showLegend
				/>
			)}

			{totals && hasData && (
				<div className="mt-2 text-[10px]" style={{ color: theme.colors.textDim }}>
					{formatDurationHuman(delegatedMs(totals))} delegated of{' '}
					{formatDurationHuman(trackedMs(totals))} tracked
					{unlockedMilestone > reached ? ` - bar held at your ${unlockedMilestone}% milestone` : ''}
				</div>
			)}
		</div>
	);
});

export default DelegationScoreCard;
