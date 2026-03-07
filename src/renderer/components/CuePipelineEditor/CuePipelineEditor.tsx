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
	MarkerType,
	type Node,
	type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { Theme } from '../../types';
import type {
	CuePipelineState,
	TriggerNodeData,
	AgentNodeData,
} from '../../../shared/cue-pipeline-types';
import { TriggerNode, type TriggerNodeDataProps } from './nodes/TriggerNode';
import { AgentNode, type AgentNodeDataProps } from './nodes/AgentNode';
import { edgeTypes } from './edges/PipelineEdge';
import type { PipelineEdgeData } from './edges/PipelineEdge';

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

const nodeTypes = {
	trigger: TriggerNode,
	agent: AgentNode,
};

function getTriggerConfigSummary(data: TriggerNodeData): string {
	const { eventType, config } = data;
	switch (eventType) {
		case 'time.interval':
			return config.interval_minutes ? `every ${config.interval_minutes}min` : 'interval';
		case 'file.changed':
			return config.watch ?? '**/*';
		case 'github.pull_request':
		case 'github.issue':
			return config.repo ?? 'repo';
		case 'task.pending':
			return config.watch ?? 'tasks';
		case 'agent.completed':
			return 'agent done';
		default:
			return '';
	}
}

function convertToReactFlowNodes(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null
): Node[] {
	const nodes: Node[] = [];
	const agentPipelineMap = new Map<string, string[]>();

	// First pass: compute pipeline colors per agent (by sessionId)
	for (const pipeline of pipelines) {
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				const existing = agentPipelineMap.get(agentData.sessionId) ?? [];
				if (!existing.includes(pipeline.color)) {
					existing.push(pipeline.color);
				}
				agentPipelineMap.set(agentData.sessionId, existing);
			}
		}
	}

	// Count pipelines per agent
	const agentPipelineCount = new Map<string, number>();
	for (const pipeline of pipelines) {
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				agentPipelineCount.set(
					agentData.sessionId,
					(agentPipelineCount.get(agentData.sessionId) ?? 0) + 1
				);
			}
		}
	}

	for (const pipeline of pipelines) {
		if (selectedPipelineId !== null && pipeline.id !== selectedPipelineId) continue;

		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'trigger') {
				const triggerData = pNode.data as TriggerNodeData;
				const nodeData: TriggerNodeDataProps = {
					eventType: triggerData.eventType,
					label: triggerData.label,
					configSummary: getTriggerConfigSummary(triggerData),
				};
				nodes.push({
					id: `${pipeline.id}:${pNode.id}`,
					type: 'trigger',
					position: pNode.position,
					data: nodeData,
				});
			} else {
				const agentData = pNode.data as AgentNodeData;
				const pipelineColors = agentPipelineMap.get(agentData.sessionId) ?? [pipeline.color];
				const nodeData: AgentNodeDataProps = {
					sessionId: agentData.sessionId,
					sessionName: agentData.sessionName,
					toolType: agentData.toolType,
					hasPrompt: !!agentData.prompt,
					pipelineColor: pipeline.color,
					pipelineCount: agentPipelineCount.get(agentData.sessionId) ?? 1,
					pipelineColors,
				};
				nodes.push({
					id: `${pipeline.id}:${pNode.id}`,
					type: 'agent',
					position: pNode.position,
					data: nodeData,
				});
			}
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
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		for (const pEdge of pipeline.edges) {
			const edgeData: PipelineEdgeData = {
				pipelineColor: pipeline.color,
				mode: pEdge.mode,
				isActivePipeline: isActive,
			};
			edges.push({
				id: `${pipeline.id}:${pEdge.id}`,
				source: `${pipeline.id}:${pEdge.source}`,
				target: `${pipeline.id}:${pEdge.target}`,
				type: 'pipeline',
				data: edgeData,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					color: pipeline.color,
					width: 16,
					height: 16,
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
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
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
