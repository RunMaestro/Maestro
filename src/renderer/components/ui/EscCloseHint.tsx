/**
 * EscCloseHint - the dismissal affordance in modal search headers.
 *
 * Fine pointers (mouse/trackpad) see the passive "ESC" keycap hint. Coarse
 * pointers (touch - phones/tablets, incl. web-desktop mobile) have no Escape
 * key, so the hint is useless there; they get a real X button that closes the
 * modal. Use this instead of hand-rolling the ESC badge so every modal stays
 * closable on touch.
 */

import { X } from 'lucide-react';
import type { Theme } from '../../types';
import { isCoarsePointer } from '../../utils/touch';

interface EscCloseHintProps {
	theme: Theme;
	onClose: () => void;
}

export function EscCloseHint({ theme, onClose }: EscCloseHintProps) {
	if (isCoarsePointer()) {
		return (
			<button
				onClick={onClose}
				aria-label="Close"
				className="p-1.5 rounded"
				style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
			>
				<X className="w-4 h-4" />
			</button>
		);
	}
	return (
		<div
			className="px-2 py-0.5 rounded text-xs font-bold"
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
		>
			ESC
		</div>
	);
}
