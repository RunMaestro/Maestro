import { memo } from 'react';
import { ServerCog } from 'lucide-react';
import type { Theme } from '../../types';
import { useLiftedMirrorTarget } from '../../hooks/federation/useAgentLift';
import { openLiftedAgent } from '../../services/agentLift';

interface LiftedPointerChipProps {
	theme: Theme;
	/** The agent's stored `liftedTo` pointer. Nothing renders without one. */
	liftedTo: unknown;
}

/**
 * The Left Bar's mark on an agent that moved to a Federation host (FED-SSH-06): `on <peer>`.
 * Clicking it opens the mirrored agent on that host; the row itself still opens this local copy,
 * whose tabs and transcripts all stayed. Renders null while Federation is off (zero footprint) and
 * for an agent that never moved.
 */
export const LiftedPointerChip = memo(function LiftedPointerChip({
	theme,
	liftedTo,
}: LiftedPointerChipProps) {
	const target = useLiftedMirrorTarget(liftedTo);
	if (!target) return null;
	const label = target.mirrored
		? `Moved to ${target.ref}. Click to open it on the host.`
		: `Moved to ${target.ref}. The peer does not show it right now.`;
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				openLiftedAgent({ liftedTo });
			}}
			className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-3xs font-medium leading-none hover:opacity-80"
			style={{ backgroundColor: `${theme.colors.accent}1f`, color: theme.colors.accent }}
			title={label}
			aria-label={label}
			data-testid="lifted-pointer-chip"
		>
			<ServerCog className="w-2.5 h-2.5" />
			on {target.peerId}
		</button>
	);
});
