import { memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../../types';

/** Shown when the IPC gate reports Cue stats off (either Encore flag disabled). */
export const DisabledNote = memo(function DisabledNote({ theme }: { theme: Theme }) {
	return (
		<div
			className="p-6 rounded-lg flex flex-col items-center justify-center gap-3 text-center"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-disabled"
		>
			<AlertTriangle className="w-6 h-6" style={{ color: theme.colors.warning }} />
			<div className="text-sm" style={{ color: theme.colors.textMain }}>
				Cue stats are unavailable.
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim, maxWidth: 420 }}>
				Both <strong>Maestro Cue</strong> and <strong>Usage Dashboard</strong> Encore features must
				be enabled to view Cue analytics. Open Settings, Plugins to turn them on.
			</div>
		</div>
	);
});
