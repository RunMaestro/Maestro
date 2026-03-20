/** Status indicator dot for Cue sessions (active/paused/none). */

export function StatusDot({ status }: { status: 'active' | 'paused' | 'none' }) {
	const color = status === 'active' ? '#22c55e' : status === 'paused' ? '#eab308' : '#6b7280';
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
