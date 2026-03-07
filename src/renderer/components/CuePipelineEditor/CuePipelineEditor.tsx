/**
 * CuePipelineEditor — React Flow-based visual pipeline editor for Maestro Cue.
 *
 * Replaces the canvas-based CueGraphView with a React Flow canvas that supports
 * visual pipeline construction: dragging triggers and agents onto the canvas,
 * connecting them, and managing named pipelines with distinct colors.
 */

import { useCallback, useMemo, useState } from 'react';
import ReactFlow, {
	Background,
	Controls,
	MiniMap,
	ReactFlowProvider,
	type Node,
	type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { Theme } from '../../types';
import type { CuePipelineState, PipelineNode } from '../../../shared/cue-pipeline-types';

interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: Array<{
		name: string;
		event: string;
		enabled: boolean;
		source_session?: string | string[];
		fan_out?: string[];
	}>;
}

interface SessionInfo {
	id: string;
	name: string;
	toolType: string;
}

export interface CuePipelineEditorProps {
	sessions: SessionInfo[];
	graphSessions: CueGraphSession[];
	onSwitchToSession: (id: string) => void;
	onClose: () => void;
	theme: Theme;
}

function convertToReactFlowNodes(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null
): Node[] {
	const nodes: Node[] = [];

	for (const pipeline of pipelines) {
		if (selectedPipelineId !== null && pipeline.id !== selectedPipelineId) continue;

		for (const pNode of pipeline.nodes) {
			nodes.push({
				id: `${pipeline.id}:${pNode.id}`,
				type: pNode.type === 'trigger' ? 'default' : 'default',
				position: pNode.position,
				data: {
					label:
						pNode.type === 'trigger'
							? (pNode.data as PipelineNode['data'] & { label: string }).label
							: (pNode.data as PipelineNode['data'] & { sessionName: string }).sessionName,
				},
				style: {
					borderColor: pipeline.color,
					borderWidth: 2,
				},
			});
		}
	}

	return nodes;
}

function convertToReactFlowEdges(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null
): Edge[] {
	const edges: Edge[] = [];

	for (const pipeline of pipelines) {
		if (selectedPipelineId !== null && pipeline.id !== selectedPipelineId) continue;

		for (const pEdge of pipeline.edges) {
			edges.push({
				id: `${pipeline.id}:${pEdge.id}`,
				source: `${pipeline.id}:${pEdge.source}`,
				target: `${pipeline.id}:${pEdge.target}`,
				label: pEdge.mode,
				animated: pEdge.mode === 'autorun',
				style: {
					stroke: pipeline.color,
				},
			});
		}
	}

	return edges;
}

function CuePipelineEditorInner({ theme }: CuePipelineEditorProps) {
	const [pipelineState] = useState<CuePipelineState>({
		pipelines: [],
		selectedPipelineId: null,
	});

	const nodes = useMemo(
		() => convertToReactFlowNodes(pipelineState.pipelines, pipelineState.selectedPipelineId),
		[pipelineState.pipelines, pipelineState.selectedPipelineId]
	);

	const edges = useMemo(
		() => convertToReactFlowEdges(pipelineState.pipelines, pipelineState.selectedPipelineId),
		[pipelineState.pipelines, pipelineState.selectedPipelineId]
	);

	const onNodesChange = useCallback(() => {
		// Will be implemented in future phases
	}, []);

	const onEdgesChange = useCallback(() => {
		// Will be implemented in future phases
	}, []);

	return (
		<div className="flex-1 flex flex-col" style={{ width: '100%', height: '100%' }}>
			{/* Toolbar placeholder — pipeline selector */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Pipelines
					</span>
				</div>
			</div>

			{/* Canvas area with drawer placeholders */}
			<div className="flex-1 relative overflow-hidden">
				{/* Left drawer placeholder — triggers */}
				<div className="absolute left-0 top-0 bottom-0 z-10" style={{ width: 0 }} />

				{/* React Flow Canvas */}
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					fitView
					style={{
						backgroundColor: theme.colors.bgMain,
					}}
				>
					<Background color={theme.colors.border} gap={20} />
					<Controls
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					/>
					<MiniMap
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
						}}
						maskColor={`${theme.colors.bgMain}cc`}
						nodeColor={theme.colors.accent}
					/>
				</ReactFlow>

				{/* Right drawer placeholder — agents */}
				<div className="absolute right-0 top-0 bottom-0 z-10" style={{ width: 0 }} />
			</div>
		</div>
	);
}

export function CuePipelineEditor(props: CuePipelineEditorProps) {
	return (
		<ReactFlowProvider>
			<CuePipelineEditorInner {...props} />
		</ReactFlowProvider>
	);
}
