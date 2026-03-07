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
	useReactFlow,
	applyNodeChanges,
	applyEdgeChanges,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Zap, Bot } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	CuePipelineState,
	CuePipeline,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
	CueEventType,
} from '../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from '../../../shared/cue-pipeline-types';
import { TriggerNode, type TriggerNodeDataProps } from './nodes/TriggerNode';
import { AgentNode, type AgentNodeDataProps } from './nodes/AgentNode';
import { edgeTypes } from './edges/PipelineEdge';
import type { PipelineEdgeData } from './edges/PipelineEdge';
import { TriggerDrawer } from './drawers/TriggerDrawer';
import { AgentDrawer } from './drawers/AgentDrawer';

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

const DEFAULT_TRIGGER_LABELS: Record<CueEventType, string> = {
	'time.interval': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Done',
	'github.pull_request': 'Pull Request',
	'github.issue': 'Issue',
	'task.pending': 'Pending Task',
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

function CuePipelineEditorInner({ sessions, theme }: CuePipelineEditorProps) {
	const reactFlowInstance = useReactFlow();

	const [pipelineState, setPipelineState] = useState<CuePipelineState>({
		pipelines: [],
		selectedPipelineId: null,
	});

	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);

	const nodes = useMemo(
		() => convertToReactFlowNodes(pipelineState.pipelines, pipelineState.selectedPipelineId),
		[pipelineState.pipelines, pipelineState.selectedPipelineId]
	);

	const edges = useMemo(
		() => convertToReactFlowEdges(pipelineState.pipelines, pipelineState.selectedPipelineId),
		[pipelineState.pipelines, pipelineState.selectedPipelineId]
	);

	// Collect session IDs currently on canvas for the agent drawer indicator
	const onCanvasSessionIds = useMemo(() => {
		const ids = new Set<string>();
		for (const pipeline of pipelineState.pipelines) {
			for (const pNode of pipeline.nodes) {
				if (pNode.type === 'agent') {
					ids.add((pNode.data as AgentNodeData).sessionId);
				}
			}
		}
		return ids;
	}, [pipelineState.pipelines]);

	const onNodesChange: OnNodesChange = useCallback(
		(changes) => {
			// Apply position/selection changes from React Flow back to pipeline state
			const updatedRFNodes = applyNodeChanges(changes, nodes);
			setPipelineState((prev) => {
				const newPipelines = prev.pipelines.map((pipeline) => ({
					...pipeline,
					nodes: pipeline.nodes.map((pNode) => {
						const rfNode = updatedRFNodes.find((n) => n.id === `${pipeline.id}:${pNode.id}`);
						if (rfNode) {
							return { ...pNode, position: rfNode.position };
						}
						return pNode;
					}),
				}));
				return { ...prev, pipelines: newPipelines };
			});
		},
		[nodes]
	);

	const onEdgesChange: OnEdgesChange = useCallback(
		(changes) => {
			applyEdgeChanges(changes, edges);
		},
		[edges]
	);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;

			// Validate: trigger nodes (source-only) should not be targets
			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			if (!sourceNode || !targetNode) return;
			if (targetNode.type === 'trigger') return; // Can't connect into a trigger

			setPipelineState((prev) => {
				// Find the pipeline that contains the source node
				const sourcePipelineId = connection.source!.split(':')[0];
				const targetPipelineId = connection.target!.split(':')[0];
				if (sourcePipelineId !== targetPipelineId) return prev; // Cross-pipeline connections not supported

				const newPipelines = prev.pipelines.map((pipeline) => {
					if (pipeline.id !== sourcePipelineId) return pipeline;

					const sourceNodeId = connection.source!.split(':').slice(1).join(':');
					const targetNodeId = connection.target!.split(':').slice(1).join(':');

					const newEdge = {
						id: `edge-${Date.now()}`,
						source: sourceNodeId,
						target: targetNodeId,
						mode: 'pass' as const,
					};

					return { ...pipeline, edges: [...pipeline.edges, newEdge] };
				});

				return { ...prev, pipelines: newPipelines };
			});
		},
		[nodes]
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();

			const raw = event.dataTransfer.getData('application/cue-pipeline');
			if (!raw) return;

			let dropData: {
				type: string;
				eventType?: CueEventType;
				label?: string;
				sessionId?: string;
				sessionName?: string;
				toolType?: string;
			};
			try {
				dropData = JSON.parse(raw);
			} catch {
				return;
			}

			const position = reactFlowInstance.screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});

			setPipelineState((prev) => {
				let targetPipeline: CuePipeline;
				let pipelines = prev.pipelines;
				const selectedId = prev.selectedPipelineId;

				if (selectedId) {
					const found = pipelines.find((p) => p.id === selectedId);
					if (found) {
						targetPipeline = found;
					} else {
						return prev;
					}
				} else if (pipelines.length > 0) {
					targetPipeline = pipelines[0];
				} else {
					// Create a new pipeline
					targetPipeline = {
						id: `pipeline-${Date.now()}`,
						name: 'Pipeline 1',
						color: getNextPipelineColor([]),
						nodes: [],
						edges: [],
					};
					pipelines = [targetPipeline];
				}

				let newNode: PipelineNode;

				if (dropData.type === 'trigger' && dropData.eventType) {
					const triggerData: TriggerNodeData = {
						eventType: dropData.eventType,
						label:
							dropData.label ?? DEFAULT_TRIGGER_LABELS[dropData.eventType] ?? dropData.eventType,
						config: {},
					};
					newNode = {
						id: `trigger-${Date.now()}`,
						type: 'trigger',
						position,
						data: triggerData,
					};
				} else if (dropData.type === 'agent' && dropData.sessionId) {
					const agentData: AgentNodeData = {
						sessionId: dropData.sessionId,
						sessionName: dropData.sessionName ?? 'Agent',
						toolType: dropData.toolType ?? 'unknown',
					};
					newNode = {
						id: `agent-${dropData.sessionId}-${Date.now()}`,
						type: 'agent',
						position,
						data: agentData,
					};
				} else {
					return prev;
				}

				const updatedPipelines = pipelines.map((p) => {
					if (p.id === targetPipeline.id) {
						return { ...p, nodes: [...p.nodes, newNode] };
					}
					return p;
				});

				// If targetPipeline was newly created, it won't be in the map yet
				if (!pipelines.some((p) => p.id === targetPipeline.id)) {
					targetPipeline.nodes.push(newNode);
					updatedPipelines.push(targetPipeline);
				}

				return {
					pipelines: updatedPipelines,
					selectedPipelineId: prev.selectedPipelineId ?? targetPipeline.id,
				};
			});
		},
		[reactFlowInstance]
	);

	return (
		<div className="flex-1 flex flex-col" style={{ width: '100%', height: '100%' }}>
			{/* Toolbar */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<button
						onClick={() => setTriggerDrawerOpen((v) => !v)}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: triggerDrawerOpen ? `${theme.colors.accent}20` : 'transparent',
							color: triggerDrawerOpen ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${triggerDrawerOpen ? theme.colors.accent : theme.colors.border}`,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
					>
						<Zap size={12} />
						Triggers
					</button>
					<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Pipelines
					</span>
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={() => setAgentDrawerOpen((v) => !v)}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: agentDrawerOpen ? `${theme.colors.accent}20` : 'transparent',
							color: agentDrawerOpen ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${agentDrawerOpen ? theme.colors.accent : theme.colors.border}`,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
					>
						<Bot size={12} />
						Agents
					</button>
				</div>
			</div>

			{/* Canvas area with drawers */}
			<div className="flex-1 relative overflow-hidden">
				{/* Trigger drawer (left) */}
				<TriggerDrawer isOpen={triggerDrawerOpen} onClose={() => setTriggerDrawerOpen(false)} />

				{/* React Flow Canvas */}
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onDragOver={onDragOver}
					onDrop={onDrop}
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

				{/* Agent drawer (right) */}
				<AgentDrawer
					isOpen={agentDrawerOpen}
					onClose={() => setAgentDrawerOpen(false)}
					sessions={sessions}
					onCanvasSessionIds={onCanvasSessionIds}
				/>
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
