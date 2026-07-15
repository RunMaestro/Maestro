import { memo } from 'react';
import { Wand2 } from 'lucide-react';

interface WizardIndicatorProps {
	/** True when the inline wizard is active on at least one tab of this agent. */
	active: boolean;
	/** True when the wizard is in the Auto Run document generation phase. Drives the pulse. */
	generatingDocs: boolean;
}

const WAND_STYLE = { color: '#c084fc' } as const;

/**
 * Inline wizard indicator pill rendered next to the agent (or group) name in
 * the Left Bar. Tells the user that the `/wizard` flow is in progress for this
 * agent - either still gathering requirements in dialog mode, or generating
 * Auto Run documents (which is when it pulses).
 *
 * Memo'd because SessionItem renders one of these per row and the props are
 * primitive - shallow compare lets the component bail out when only unrelated
 * parent state changes (matches the CueIndicator pattern).
 *
 * Renders null when inactive so callers can mount unconditionally.
 */
export const WizardIndicator = memo(function WizardIndicator({
	active,
	generatingDocs,
}: WizardIndicatorProps) {
	if (!active) return null;

	const tooltip = generatingDocs
		? 'Wizard generating Auto Run documents'
		: 'Wizard active (dialog mode)';

	return (
		<span className="shrink-0 flex items-center" title={tooltip}>
			<Wand2
				className={`w-3 h-3${generatingDocs ? ' wand-sparkle-active' : ''}`}
				style={WAND_STYLE}
			/>
		</span>
	);
});
