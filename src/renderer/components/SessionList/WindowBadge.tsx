import { memo } from 'react';
import { AppWindow } from 'lucide-react';

interface WindowBadgeProps {
	/**
	 * 1-based number of the OTHER window this agent is open in (primary = 1).
	 * Undefined/0 when the agent belongs to THIS window, in which case nothing
	 * renders.
	 */
	windowNumber?: number;
}

const BADGE_COLOR = '#60a5fa';
const ICON_STYLE = { color: BADGE_COLOR } as const;
const BADGE_STYLE = { backgroundColor: `${BADGE_COLOR}1f`, color: BADGE_COLOR } as const;

/**
 * Window-number badge rendered next to an agent in the Left Bar when that agent
 * is open in a DIFFERENT window. Signals which window currently surfaces the
 * agent; clicking the row focuses that window rather than stealing the agent
 * (single-window-per-agent invariant). The Left Bar still lists every agent in
 * every window, so this is the one cue that an agent lives elsewhere.
 *
 * Memo'd because SessionItem renders one of these per row and the prop is
 * primitive - shallow compare lets the component bail out when only unrelated
 * parent state changes (matches the CueIndicator / WizardIndicator pattern).
 *
 * Renders null when the agent belongs to this window so callers can mount it
 * unconditionally.
 */
export const WindowBadge = memo(function WindowBadge({ windowNumber }: WindowBadgeProps) {
	if (!windowNumber) return null;

	const label = `Open in window ${windowNumber}`;

	return (
		<span
			className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold leading-none"
			style={BADGE_STYLE}
			title={label}
			aria-label={label}
		>
			<AppWindow className="w-2.5 h-2.5" style={ICON_STYLE} />
			{windowNumber}
		</span>
	);
});
