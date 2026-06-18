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
	selected,
}: NodeProps<PipelineGroupNodeDataProps>) {
	return (
		<div
			style={{
				width: data.width,
				height: data.height,
				backgroundColor: `${data.color}14`,
				// Selection bumps the border to solid + a soft ring so it's
				// obvious which pipeline you grabbed before dragging it.
				border: `1px ${selected ? 'solid' : 'dashed'} ${data.color}${selected ? 'cc' : '66'}`,
				boxShadow: selected ? `0 0 0 2px ${data.color}55` : 'none',
				borderRadius: 12,
				// Pointer events ENABLED. In pointer/select mode the group sits
				// above its content nodes (zIndex 5) so the whole body is the
				// drag handle; in hand mode it drops behind (zIndex -1) so empty
				// area pans the canvas.
				position: 'relative',
				cursor: 'grab',
			}}
		>
			<div
				style={{
					position: 'absolute',
					top: -38,
					left: 12,
					fontSize: 22,
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
