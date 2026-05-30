/** Status indicator dot for Cue sessions (active/paused/none). */

import type { Theme } from '../../types';

export function StatusDot({
	status,
	theme,
}: {
	status: 'active' | 'paused' | 'none';
	theme?: Theme;
}) {
	const color =
		status === 'active'
			? (theme?.colors.success ?? '#22c55e')
			: status === 'paused'
				? (theme?.colors.warning ?? '#eab308')
				: (theme?.colors.textDim ?? '#6b7280');
	return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />;
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
