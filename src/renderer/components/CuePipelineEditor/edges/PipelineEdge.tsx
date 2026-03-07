import { memo } from 'react';
import { getBezierPath, BaseEdge, EdgeLabelRenderer, type EdgeProps } from 'reactflow';
import { MessageCircle, FileText } from 'lucide-react';
import type { EdgeMode } from '../../../../shared/cue-pipeline-types';

export interface PipelineEdgeData {
	pipelineColor: string;
	mode: EdgeMode;
	isActivePipeline: boolean;
	isRunning?: boolean;
}

export const PipelineEdge = memo(function PipelineEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
	selected,
	markerEnd,
}: EdgeProps<PipelineEdgeData>) {
	const color = data?.pipelineColor ?? '#06b6d4';
	const mode = data?.mode ?? 'pass';
	const isActive = data?.isActivePipeline !== false;
	const isRunning = data?.isRunning ?? false;
	const opacity = isActive ? 1 : 0.25;

	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	return (
		<>
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					stroke: color,
					strokeWidth: selected ? 2.5 : isRunning ? 2 : 1.5,
					opacity,
					strokeDasharray: mode === 'autorun' || isRunning ? '6 3' : undefined,
					animation:
						mode === 'autorun' || isRunning ? 'pipeline-dash 0.8s linear infinite' : undefined,
				}}
			/>

			{/* Mode label for non-pass modes */}
			{mode !== 'pass' && (
				<EdgeLabelRenderer>
					<div
						style={{
							position: 'absolute',
							transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
							pointerEvents: 'all',
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							backgroundColor: '#1e1e2e',
							border: `1px solid ${color}60`,
							borderRadius: 10,
							padding: '2px 8px',
							fontSize: 10,
							color,
							fontWeight: 500,
							opacity,
						}}
					>
						{mode === 'debate' && <MessageCircle size={10} />}
						{mode === 'autorun' && <FileText size={10} />}
						{mode}
					</div>
				</EdgeLabelRenderer>
			)}

			{/* CSS animation for autorun dash */}
			<style>{`
				@keyframes pipeline-dash {
					to { stroke-dashoffset: -9; }
				}
			`}</style>
		</>
	);
});

export const edgeTypes = {
	pipeline: PipelineEdge,
};
