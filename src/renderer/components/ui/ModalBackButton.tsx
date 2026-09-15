/**
 * ModalBackButton - the "Back" control at the bottom-left of a step in a modal
 * series.
 *
 * A sequence of modals that only moves forward makes the first answer
 * unchangeable: the moment the next step opens, the previous one is gone and
 * the only way back to it is to find the setting it wrote. This is the way
 * back, and it sits bottom-LEFT on purpose - the forward action lives
 * bottom-right, so backwards and forwards read as opposites rather than as two
 * buttons in a row.
 *
 * Render it only when there IS a previous step. A disabled Back on the first
 * step is a control that says the series has a history it does not have.
 *
 * Usage:
 * ```tsx
 * {onBack && <ModalBackButton theme={theme} onBack={onBack} testId="theme-choice-back" />}
 * ```
 */

import { ChevronLeft } from 'lucide-react';
import type { Theme } from '../../types';

export interface ModalBackButtonProps {
	theme: Theme;
	/** Return to the previous step. Must not commit the current one. */
	onBack: () => void;
	/** Visible text. Defaults to 'Back'. */
	label?: string;
	/** Test id for automated tests. */
	testId?: string;
}

export function ModalBackButton({ theme, onBack, label = 'Back', testId }: ModalBackButtonProps) {
	return (
		<button
			type="button"
			onClick={onBack}
			data-testid={testId}
			className="flex items-center gap-1 pl-2 pr-3 py-1.5 rounded text-xs font-bold border hover:bg-white/5 transition-colors"
			style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
		>
			<ChevronLeft className="w-3.5 h-3.5" />
			{label}
		</button>
	);
}

export default ModalBackButton;
