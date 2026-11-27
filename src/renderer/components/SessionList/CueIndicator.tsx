import { memo } from 'react';
import { Zap } from 'lucide-react';

interface CueIndicatorProps {
	/** Number of Cue subscriptions registered for this session. */
	subscriptionCount: number;
	/** Whether a Cue run is currently active (drives the pulse animation). */
	activeRun: boolean;
	/** Subscriptions past their failure-alert threshold. Turns the zap red. */
	failingCount?: number;
}

const ZAP_COLOR = '#2dd4bf';
const ZAP_FAILING_COLOR = '#ef4444';
const ZAP_STYLE = { color: ZAP_COLOR } as const;
const ZAP_FAILING_STYLE = { color: ZAP_FAILING_COLOR } as const;

/**
 * Maestro Cue indicator pill rendered next to the session name.
 *
 * Memo'd because SessionItem renders one of these per row in the Left Bar
 * and the props are all primitive - React's default shallow compare lets
 * this component skip re-renders when only unrelated parent state changes.
 *
 * Hidden entirely when `subscriptionCount <= 0` so SessionItem can use
 * `<CueIndicator ... />` unconditionally instead of a parent-side guard.
 */
export const CueIndicator = memo(function CueIndicator({
	subscriptionCount,
	activeRun,
	failingCount = 0,
}: CueIndicatorProps) {
	if (subscriptionCount <= 0) return null;

	const failing = failingCount > 0;
	const subs = `${subscriptionCount} subscription${subscriptionCount === 1 ? '' : 's'}`;
	const tooltip = failing
		? `Maestro Cue: ${failingCount} of ${subs} failing - open the Cue dashboard to see which`
		: `Maestro Cue ${activeRun ? 'running' : 'active'} (${subs})`;

	return (
		<span
			className={`shrink-0 flex items-center${activeRun ? ' animate-pulse' : ''}`}
			title={tooltip}
			data-testid={failing ? 'cue-indicator-failing' : 'cue-indicator'}
		>
			<Zap
				className="w-3 h-3"
				style={failing ? ZAP_FAILING_STYLE : ZAP_STYLE}
				fill={failing ? ZAP_FAILING_COLOR : ZAP_COLOR}
			/>
		</span>
	);
});
