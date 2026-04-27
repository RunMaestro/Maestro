import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import type { Theme } from '../../../types';

export interface PipelineGroupNodeDataProps {
	pipelineName: string;
	color: string;
	width: number;
	height: number;
	theme?: Theme;
}

export const PipelineGroupNode = memo(function PipelineGroupNode({
	data,
}: NodeProps<PipelineGroupNodeDataProps>) {
	return (
		<div
			style={{
				width: data.width,
				height: data.height,
				backgroundColor: `${data.color}14`,
				border: `1px dashed ${data.color}66`,
				borderRadius: 12,
				// Pointer events ENABLED — empty area inside the group is the
				// drag handle. Real pipeline nodes render on top (default
				// zIndex 0 vs group's -1) so clicks on them still go to them.
				position: 'relative',
				cursor: 'grab',
			}}
		>
			<div
				style={{
					position: 'absolute',
					top: -24,
					left: 12,
					fontSize: 11,
					fontWeight: 600,
					color: data.color,
					textTransform: 'uppercase',
					letterSpacing: '0.05em',
					padding: '2px 8px',
					borderRadius: 4,
					backgroundColor: `${data.color}1a`,
					border: `1px solid ${data.color}55`,
					whiteSpace: 'nowrap',
				}}
			>
				{data.pipelineName}
			</div>
		</div>
	);
});
