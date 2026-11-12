import type { QuickAction } from '../types';

interface BuildStatsIndexingCommandsArgs {
	/** A usage-data scan large enough to report is running. */
	scanActive: boolean;
	/** Bring the scan's progress modal back from the corner card (or from hidden). */
	showScanProgress: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * The palette route back to a usage-data scan's progress after it was sent to
 * the background or hidden. Listed only while a scan runs: with nothing
 * scanning there is no progress to show, and the command would only ever say so.
 */
export function buildStatsIndexingCommands({
	scanActive,
	showScanProgress,
	setQuickActionOpen,
}: BuildStatsIndexingCommandsArgs): QuickAction[] {
	if (!scanActive) return [];
	return [
		{
			id: 'show-usage-data-scan-progress',
			label: 'Show Usage Data Scan Progress',
			subtext: 'Maestro is reading your session history to rebuild usage totals',
			action: () => {
				showScanProgress();
				setQuickActionOpen(false);
			},
		},
	];
}
