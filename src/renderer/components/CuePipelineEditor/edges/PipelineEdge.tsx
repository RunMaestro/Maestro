import { memo } from 'react';
import { getBezierPath, BaseEdge, EdgeLabelRenderer, type EdgeProps } from 'reactflow';
import { MessageCircle, FileText } from 'lucide-react';
import type { EdgeMode } from '../../../../shared/cue-pipeline-types';

// Inject the pipeline dash animation once into the document head
let pipelineDashInjected = false;
function ensurePipelineDashStyle() {
	if (pipelineDashInjected) return;
	pipelineDashInjected = true;
	const style = document.createElement('style');
	style.textContent = [
		`@keyframes pipeline-dash { to { stroke-dashoffset: -9; } }`,
		`@keyframes pipeline-edge-pulse { 0%, 100% { opacity: 1; filter: drop-shadow(0 0 3px var(--edge-color)); } 50% { opacity: 0.7; filter: drop-shadow(0 0 8px var(--edge-color)); } }`,
		`@keyframes pipeline-node-pulse { 0%, 100% { box-shadow: 0 0 12px var(--node-color-40); } 50% { box-shadow: 0 0 20px var(--node-color-60), 0 0 6px var(--node-color-30); } }`,
	].join('\n');
	document.head.appendChild(style);
}

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
	ensurePipelineDashStyle();
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
			{/* Glow underlay for selected edge */}
			{selected && (
				<BaseEdge
					id={`${id}-glow`}
					path={edgePath}
					style={{
						stroke: color,
						strokeWidth: 8,
						opacity: 0.3,
						filter: `drop-shadow(0 0 4px ${color})`,
						strokeLinecap: 'round',
					}}
				/>
			)}
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					stroke: color,
					strokeWidth: selected ? 3.5 : isRunning ? 2 : 1.5,
					opacity,
					strokeDasharray: mode === 'autorun' || isRunning ? '6 3' : undefined,
					animation: selected
						? `pipeline-edge-pulse 1.5s ease-in-out infinite`
						: mode === 'autorun' || isRunning
							? 'pipeline-dash 0.8s linear infinite'
							: undefined,
					['--edge-color' as string]: color,
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
		</>
	);
});

export const edgeTypes = {
	pipeline: PipelineEdge,
};
