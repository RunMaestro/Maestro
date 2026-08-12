import { memo } from 'react';
import { Terminal } from 'lucide-react';

interface StartupCommandIndicatorProps {
	/** True when at least one terminal tab on this agent has a saved startup command. */
	active: boolean;
	/** Number of terminal tabs with a saved startup command (used in the tooltip). */
	count: number;
}

const TERMINAL_STYLE = { color: '#a3e635' } as const;

/**
 * Persistent-terminal indicator rendered next to the agent name in the Left Bar.
 * Surfaces that this agent has at least one terminal tab configured to re-run a
 * sticky command every time the PTY spawns (e.g. `npm run dev`, `btop`).
 *
 * Renders null when inactive so the caller can mount it unconditionally -
 * matches the CueIndicator / WizardIndicator pattern.
 */
export const StartupCommandIndicator = memo(function StartupCommandIndicator({
	active,
	count,
}: StartupCommandIndicatorProps) {
	if (!active) return null;

	const tooltip =
		count === 1
			? 'One terminal tab has a saved startup command'
			: `${count} terminal tabs have saved startup commands`;

	return (
		<span className="shrink-0 flex items-center" title={tooltip}>
			<Terminal className="w-3 h-3" style={TERMINAL_STYLE} />
		</span>
	);
});
