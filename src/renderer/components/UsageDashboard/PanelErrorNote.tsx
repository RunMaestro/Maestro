/**
 * PanelErrorNote - what a Usage Dashboard panel shows when its own fetch fails.
 *
 * The panels that load for themselves (Cue, Models) cannot use the modal's
 * "Failed to load usage data" screen: that one belongs to the stats
 * aggregation, and a panel's failure must not blank the tabs that still work.
 * So each shows this card in its own place: what failed, the message the call
 * rejected with, and a Retry that runs the panel's fetch again.
 *
 * Purely presentational. The caller owns the fetch and unwraps the message.
 */

import { memo } from 'react';
import { XCircle } from 'lucide-react';
import type { Theme } from '../../types';

export interface PanelErrorNoteProps {
	theme: Theme;
	/** What failed, e.g. "Failed to load Cue stats". */
	title: string;
	/** The reason, as the failed call gave it. */
	message: string;
	onRetry: () => void;
	testId?: string;
}

export const PanelErrorNote = memo(function PanelErrorNote({
	theme,
	title,
	message,
	onRetry,
	testId,
}: PanelErrorNoteProps) {
	return (
		<div
			className="p-6 rounded-lg flex flex-col items-center justify-center gap-3 text-center"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
		>
			<XCircle className="w-6 h-6" style={{ color: theme.colors.error }} />
			<div className="text-sm" style={{ color: theme.colors.textMain }}>
				{title}
			</div>
			<div className="text-xs select-text" style={{ color: theme.colors.textDim, maxWidth: 420 }}>
				{message}
			</div>
			<button
				type="button"
				onClick={onRetry}
				className="px-4 py-1.5 rounded text-sm"
				style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
			>
				Retry
			</button>
		</div>
	);
});

export default PanelErrorNote;
