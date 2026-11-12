import { memo } from 'react';

interface AutoRunErrorBadgeProps {
	/** The run is parked on an agent error waiting to be resolved. */
	errorPaused: boolean;
	/** Automatic resumes already spent on this run. */
	attempts?: number;
	/** The run's ceiling, so the tooltip can say "2 of 5". */
	maxAttempts?: number;
	/** Epoch ms of the pending automatic resume, or null/undefined when none. */
	nextResumeAt?: number | null;
	/** True once the attempts are spent: only a human continues the run now. */
	exhausted?: boolean;
}

/** Red when the run needs a person, amber while a resume is still coming. */
const NEEDS_HUMAN = '#f87171';
const RETRYING = '#fbbf24';

/**
 * "ERR" badge beside an agent's name while one of its Auto Runs is stopped on
 * an error.
 *
 * The Left Bar already tints the status dot for an Agent Resilience outage, but
 * a dot colour is not something you notice across a screen of agents, and it
 * cannot say whether anything is going to happen next. A paused Auto Run is
 * dead until someone acts, so it gets a word instead of a hue.
 *
 * The two colours carry the only distinction that changes what the user should
 * do. Amber: an automatic resume is still scheduled, so leave it alone. Red:
 * the attempts are spent (or auto-resume is off for this run) and the run will
 * sit there until a person opens it. The badge disappears entirely when a
 * resume succeeds, which is the signal that no action was needed after all.
 *
 * Memo'd for the same reason as `CueIndicator`: one per row, primitive props.
 */
export const AutoRunErrorBadge = memo(function AutoRunErrorBadge({
	errorPaused,
	attempts,
	maxAttempts,
	nextResumeAt,
	exhausted,
}: AutoRunErrorBadgeProps) {
	if (!errorPaused) return null;

	const resumeScheduled = !exhausted && typeof nextResumeAt === 'number';
	const color = resumeScheduled ? RETRYING : NEEDS_HUMAN;

	let tooltip: string;
	if (resumeScheduled) {
		const minutes = Math.max(1, Math.round((nextResumeAt - Date.now()) / 60_000));
		const of = maxAttempts ? ` (${attempts ?? 1} of ${maxAttempts})` : '';
		tooltip = `Auto Run error - resuming in about ${minutes} minute${
			minutes === 1 ? '' : 's'
		}${of}`;
	} else if (exhausted) {
		tooltip = `Auto Run error - gave up after ${maxAttempts ?? attempts} automatic resumes. Resume it yourself to continue.`;
	} else {
		tooltip = 'Auto Run error - paused until you resume it.';
	}

	return (
		<span
			className={`shrink-0 rounded px-1 text-2xs font-bold leading-none py-0.5${
				resumeScheduled ? '' : ' animate-pulse'
			}`}
			style={{ color, border: `1px solid ${color}`, backgroundColor: `${color}1a` }}
			title={tooltip}
			aria-label={tooltip}
		>
			ERR
		</span>
	);
});
