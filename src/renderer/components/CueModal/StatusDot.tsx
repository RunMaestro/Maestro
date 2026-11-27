/** Status indicator dot for Cue sessions (active/failing/paused/none). */

import type { Theme } from '../../types';

export function StatusDot({
	status,
	theme,
}: {
	status: 'active' | 'failing' | 'paused' | 'none';
	theme?: Theme;
}) {
	const color =
		status === 'active'
			? (theme?.colors.success ?? '#22c55e')
			: status === 'failing'
				? (theme?.colors.error ?? '#ef4444')
				: status === 'paused'
					? (theme?.colors.warning ?? '#eab308')
					: (theme?.colors.textDim ?? '#6b7280');
	return (
		<span
			data-testid={`cue-status-dot-${status}`}
			className="inline-block w-2 h-2 rounded-full flex-shrink-0"
			style={{ backgroundColor: color }}
		/>
	);
}

/** Colored dot representing a pipeline. */
export function PipelineDot({ color, name }: { color: string; name: string }) {
	return (
		<span
			className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
			style={{ backgroundColor: color }}
			title={name}
		/>
	);
}
