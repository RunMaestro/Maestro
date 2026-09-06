/**
 * StopTurnButton - the red "Stop" pill that ends the active agent's turn.
 *
 * Every surface that offers Stop draws the SAME control, because Stop is one
 * agent-level action (see `useInterruptHandler`): it signals the agent's own
 * process, every other busy tab it owns, and every cross-agent consult it fanned
 * out. A surface that hand-rolls its own button drifts on the square glyph, the
 * padding, and - worse - on what the tooltip claims the button does.
 *
 * Rendered by the thinking pill (while the agent is working) and by the
 * cross-agent "N agents responding…" pill (when consulted agents are working but
 * this agent is not, so the thinking pill is absent).
 */

import type { Theme } from '../../types';

interface StopTurnButtonProps {
	theme: Theme;
	/** Runs the agent-level interrupt. */
	onClick: () => void;
	/** Tooltip text. Name what stops, not which provider is running. */
	title?: string;
}

export function StopTurnButton({
	theme,
	onClick,
	title = 'Stop this turn (Ctrl+C)',
}: StopTurnButtonProps): JSX.Element {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors hover:opacity-80"
			style={{ backgroundColor: theme.colors.error, color: 'white' }}
			title={title}
		>
			{/* Filled square: the universal transport "stop", and the one glyph that
			    cannot be read as "pause" or "close". */}
			<svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
				<rect x="6" y="6" width="12" height="12" rx="1" />
			</svg>
			Stop
		</button>
	);
}

export default StopTurnButton;
