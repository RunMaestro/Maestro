/**
 * A small dot on the Left Bar hamburger button while Computer History is
 * recording (or is on but waiting for a permission). Renders nothing when the
 * feature is off, paused, or unavailable (web-desktop). Absolutely positioned
 * inside the button's `relative` wrapper so it never shifts the header row.
 */

import type { Theme } from '../../types';
import { useComputerHistoryStatus } from '../../hooks/computerHistory/useComputerHistoryStatus';

export function ComputerHistoryRecordingDot({ theme }: { theme: Theme }) {
	const { status } = useComputerHistoryStatus();
	if (!status) return null;
	const recording = status.state === 'recording';
	const needsAttention = status.state === 'blocked' || status.state === 'binary-missing';
	if (!recording && !needsAttention) return null;
	const label = recording
		? 'Computer History is recording'
		: 'Computer History is on but cannot record yet (see Settings > Plugins > Computer History)';
	return (
		<span
			role="status"
			aria-label={label}
			title={label}
			data-testid="computer-history-recording-dot"
			className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full pointer-events-none"
			style={{ backgroundColor: recording ? theme.colors.error : theme.colors.warning }}
		/>
	);
}
