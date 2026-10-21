import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { Bot } from 'lucide-react';
import type { Theme } from '../../../types';

export interface AgentClusterNodeDataProps {
	agentName: string;
	pipelineCount: number;
	width: number;
	height: number;
	theme?: Theme;
}

/**
 * The labeled box drawn behind one agent's pipeline cards in All Pipelines
 * view. Pure backdrop: the node is not selectable or draggable and ignores the
 * pointer, so everything interactive stays on the pipeline cards above it.
 */
export const AgentClusterNode = memo(function AgentClusterNode({
	data,
}: NodeProps<AgentClusterNodeDataProps>) {
	const border = data.theme?.colors.border ?? 'rgba(255,255,255,0.18)';
	const text = data.theme?.colors.textMain ?? 'rgba(255,255,255,0.9)';
	const dim = data.theme?.colors.textDim ?? 'rgba(255,255,255,0.5)';
	const fill = data.theme?.colors.bgActivity ?? 'rgba(255,255,255,0.04)';
	return (
		<div
			style={{
				width: data.width,
				height: data.height,
				backgroundColor: `${fill}66`,
				border: `2px solid ${border}`,
				borderRadius: 18,
				position: 'relative',
			}}
		>
			<div
				style={{
					position: 'absolute',
					top: -54,
					left: 16,
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					fontSize: 26,
					fontWeight: 600,
					color: text,
					whiteSpace: 'nowrap',
				}}
			>
				<Bot size={26} style={{ color: dim }} />
				{data.agentName}
				<span style={{ color: dim, fontWeight: 400 }}>
					· {data.pipelineCount} pipeline{data.pipelineCount === 1 ? '' : 's'}
				</span>
			</div>
		</div>
	);
});
