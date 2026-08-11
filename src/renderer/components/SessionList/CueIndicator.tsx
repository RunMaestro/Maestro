import { memo } from 'react';
import { Zap } from 'lucide-react';

interface CueIndicatorProps {
	/** Number of Cue subscriptions registered for this session. */
	subscriptionCount: number;
	/** Whether a Cue run is currently active (drives the pulse animation). */
	activeRun: boolean;
}

const ZAP_STYLE = { color: '#2dd4bf' } as const;

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
}: CueIndicatorProps) {
	if (subscriptionCount <= 0) return null;

	const tooltip = `Maestro Cue ${activeRun ? 'running' : 'active'} (${subscriptionCount} subscription${
		subscriptionCount === 1 ? '' : 's'
	})`;

	return (
		<span
			className={`shrink-0 flex items-center${activeRun ? ' animate-pulse' : ''}`}
			title={tooltip}
		>
			<Zap className="w-3 h-3" style={ZAP_STYLE} fill="#2dd4bf" />
		</span>
	);
});
