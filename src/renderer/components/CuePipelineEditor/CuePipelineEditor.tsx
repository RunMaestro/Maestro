/**
 * CuePipelineEditor — React Flow-based visual pipeline editor for Maestro Cue.
 *
 * Replaces the canvas-based CueGraphView with a React Flow canvas that supports
 * visual pipeline construction: dragging triggers and agents onto the canvas,
 * connecting them, and managing named pipelines with distinct colors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Zap, Bot, Save, RotateCcw, Check, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	CuePipelineState,
	CuePipeline,
	PipelineNode,
	PipelineEdge as PipelineEdgeType,
	TriggerNodeData,
	AgentNodeData,
	CueEventType,
} from '../../../shared/cue-pipeline-types';
import { TriggerNode, type TriggerNodeDataProps } from './nodes/TriggerNode';
import { AgentNode, type AgentNodeDataProps } from './nodes/AgentNode';
import { edgeTypes } from './edges/PipelineEdge';
import type { PipelineEdgeData } from './edges/PipelineEdge';
import { TriggerDrawer } from './drawers/TriggerDrawer';
import { AgentDrawer } from './drawers/AgentDrawer';
import { PipelineSelector } from './PipelineSelector';
import { getNextPipelineColor } from './pipelineColors';
import { NodeConfigPanel } from './panels/NodeConfigPanel';
import { EdgeConfigPanel } from './panels/EdgeConfigPanel';
import { graphSessionsToPipelines } from './utils/yamlToPipeline';
import { pipelinesToYaml } from './utils/pipelineToYaml';

interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: Array<{
		name: string;
		event: string;
		enabled: boolean;
		prompt?: string;
		source_session?: string | string[];
		fan_out?: string[];
	}>;
}

interface SessionInfo {
	id: string;
	name: string;
	toolType: string;
	projectRoot?: string;
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

	// Track which agent sessionIds are in the selected pipeline (for shared agent dimming)
	const selectedPipelineAgentIds = new Set<string>();
	if (selectedPipelineId) {
		const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);
		if (selectedPipeline) {
			for (const pNode of selectedPipeline.nodes) {
				if (pNode.type === 'agent') {
					selectedPipelineAgentIds.add((pNode.data as AgentNodeData).sessionId);
				}
			}
		}
	}

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'trigger') {
				// Triggers from non-selected pipelines are hidden
				if (!isActive) continue;

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
				const isShared = (agentPipelineCount.get(agentData.sessionId) ?? 1) > 1;

				// Non-selected pipeline: hide non-shared agents, dim shared ones
				if (!isActive) {
					if (!isShared) continue;
					if (!selectedPipelineAgentIds.has(agentData.sessionId)) continue;
				}

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
					style: !isActive ? { opacity: 0.4 } : undefined,
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

/** Validates pipeline graph before save. Returns array of error messages. */
function validatePipelines(pipelines: CuePipeline[]): string[] {
	const errors: string[] = [];

	for (const pipeline of pipelines) {
		const triggers = pipeline.nodes.filter((n) => n.type === 'trigger');
		const agents = pipeline.nodes.filter((n) => n.type === 'agent');

		if (triggers.length === 0 && agents.length === 0) continue; // Empty pipeline, skip

		if (triggers.length === 0) {
			errors.push(`"${pipeline.name}": needs at least one trigger`);
		}
		if (agents.length === 0) {
			errors.push(`"${pipeline.name}": needs at least one agent`);
		}

		// Check for disconnected agents (no incoming edge)
		const targetsWithIncoming = new Set(pipeline.edges.map((e) => e.target));
		for (const agent of agents) {
			if (!targetsWithIncoming.has(agent.id)) {
				const name = (agent.data as AgentNodeData).sessionName;
				errors.push(`"${pipeline.name}": agent "${name}" has no incoming connection`);
			}
		}

		// Check for cycles via topological sort
		const adjList = new Map<string, string[]>();
		const inDegree = new Map<string, number>();
		for (const node of pipeline.nodes) {
			adjList.set(node.id, []);
			inDegree.set(node.id, 0);
		}
		for (const edge of pipeline.edges) {
			adjList.get(edge.source)?.push(edge.target);
			inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
		}
		const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
		let visited = 0;
		while (queue.length > 0) {
			const id = queue.shift()!;
			visited++;
			for (const neighbor of adjList.get(id) ?? []) {
				const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
				inDegree.set(neighbor, newDeg);
				if (newDeg === 0) queue.push(neighbor);
			}
		}
		if (visited < pipeline.nodes.length) {
			errors.push(`"${pipeline.name}": contains a cycle`);
		}
	}

	return errors;
}

function CuePipelineEditorInner({
	sessions,
	graphSessions,
	onSwitchToSession,
	theme,
}: CuePipelineEditorProps) {
	const reactFlowInstance = useReactFlow();

	const [pipelineState, setPipelineState] = useState<CuePipelineState>({
		pipelines: [],
		selectedPipelineId: null,
	});

	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

	// Save/load state
	const [isDirty, setIsDirty] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const savedStateRef = useRef<string>(''); // JSON snapshot for dirty tracking
	// TODO: auto-save after 5 seconds of no changes

	// Load pipelines from existing graph sessions on mount
	useEffect(() => {
		if (graphSessions && graphSessions.length > 0) {
			const pipelines = graphSessionsToPipelines(graphSessions, sessions);
			if (pipelines.length > 0) {
				setPipelineState({ pipelines, selectedPipelineId: pipelines[0].id });
				savedStateRef.current = JSON.stringify(pipelines);
				setIsDirty(false);
			}
		}
		// Only run on mount
		 
	}, []);

	// Track dirty state when pipelines change
	useEffect(() => {
		const currentSnapshot = JSON.stringify(pipelineState.pipelines);
		if (savedStateRef.current && currentSnapshot !== savedStateRef.current) {
			setIsDirty(true);
			setValidationErrors([]);
		}
	}, [pipelineState.pipelines]);

	const handleSave = useCallback(async () => {
		// Validate before save
		const errors = validatePipelines(pipelineState.pipelines);
		setValidationErrors(errors);
		if (errors.length > 0) return;

		setSaveStatus('saving');
		try {
			const yamlContent = pipelinesToYaml(pipelineState.pipelines);

			// Find unique project roots from sessions involved in pipelines
			const sessionNames = new Set<string>();
			for (const pipeline of pipelineState.pipelines) {
				for (const node of pipeline.nodes) {
					if (node.type === 'agent') {
						sessionNames.add((node.data as AgentNodeData).sessionName);
					}
				}
			}

			const projectRoots = new Set<string>();
			for (const session of sessions) {
				if (session.projectRoot && sessionNames.has(session.name)) {
					projectRoots.add(session.projectRoot);
				}
			}

			// If no specific project roots found, use first session's project root
			if (projectRoots.size === 0 && sessions.length > 0) {
				const firstWithRoot = sessions.find((s) => s.projectRoot);
				if (firstWithRoot?.projectRoot) {
					projectRoots.add(firstWithRoot.projectRoot);
				}
			}

			// Write YAML and refresh sessions
			for (const root of projectRoots) {
				await window.maestro.cue.writeYaml(root, yamlContent);
			}

			// Refresh all sessions involved
			for (const session of sessions) {
				if (
					session.projectRoot &&
					(projectRoots.has(session.projectRoot) || sessionNames.has(session.name))
				) {
					await window.maestro.cue.refreshSession(session.id, session.projectRoot);
				}
			}

			savedStateRef.current = JSON.stringify(pipelineState.pipelines);
			setIsDirty(false);
			setSaveStatus('success');
			setTimeout(() => setSaveStatus('idle'), 2000);
		} catch {
			setSaveStatus('error');
			setTimeout(() => setSaveStatus('idle'), 3000);
		}
	}, [pipelineState.pipelines, sessions]);

	const handleDiscard = useCallback(async () => {
		try {
			const data = await window.maestro.cue.getGraphData();
			if (data && data.length > 0) {
				const pipelines = graphSessionsToPipelines(data, sessions);
				setPipelineState({
					pipelines,
					selectedPipelineId: pipelines.length > 0 ? pipelines[0].id : null,
				});
				savedStateRef.current = JSON.stringify(pipelines);
			} else {
				setPipelineState({ pipelines: [], selectedPipelineId: null });
				savedStateRef.current = '[]';
			}
			setIsDirty(false);
			setValidationErrors([]);
		} catch {
			// Error reloading - keep current state
		}
	}, [sessions]);

	const createPipeline = useCallback(() => {
		setPipelineState((prev) => {
			const newPipeline: CuePipeline = {
				id: `pipeline-${Date.now()}`,
				name: `Pipeline ${prev.pipelines.length + 1}`,
				color: getNextPipelineColor(prev.pipelines),
				nodes: [],
				edges: [],
			};
			return {
				pipelines: [...prev.pipelines, newPipeline],
				selectedPipelineId: newPipeline.id,
			};
		});
	}, []);

	const deletePipeline = useCallback((id: string) => {
		setPipelineState((prev) => {
			const pipeline = prev.pipelines.find((p) => p.id === id);
			if (!pipeline) return prev;

			// Check if nodes are shared with other pipelines
			const otherPipelines = prev.pipelines.filter((p) => p.id !== id);
			const otherNodeIds = new Set<string>();
			for (const p of otherPipelines) {
				for (const n of p.nodes) {
					if (n.type === 'agent') {
						otherNodeIds.add((n.data as AgentNodeData).sessionId);
					}
				}
			}

			const hasNodes = pipeline.nodes.length > 0;
			if (hasNodes && !window.confirm(`Delete pipeline "${pipeline.name}" and its nodes?`)) {
				return prev;
			}

			const newSelectedId = prev.selectedPipelineId === id ? null : prev.selectedPipelineId;

			return {
				pipelines: otherPipelines,
				selectedPipelineId: newSelectedId,
			};
		});
	}, []);

	const renamePipeline = useCallback((id: string, name: string) => {
		setPipelineState((prev) => ({
			...prev,
			pipelines: prev.pipelines.map((p) => (p.id === id ? { ...p, name } : p)),
		}));
	}, []);

	const selectPipeline = useCallback((id: string | null) => {
		setPipelineState((prev) => ({ ...prev, selectedPipelineId: id }));
	}, []);

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

	// Resolve selected node/edge from pipeline state using the composite IDs
	const { selectedNode, selectedNodePipelineId } = useMemo(() => {
		if (!selectedNodeId) return { selectedNode: null, selectedNodePipelineId: null };
		// selectedNodeId is composite: "pipelineId:nodeId"
		const sepIdx = selectedNodeId.indexOf(':');
		if (sepIdx === -1) return { selectedNode: null, selectedNodePipelineId: null };
		const pipelineId = selectedNodeId.substring(0, sepIdx);
		const nodeId = selectedNodeId.substring(sepIdx + 1);
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId);
		const node = pipeline?.nodes.find((n) => n.id === nodeId);
		return { selectedNode: node ?? null, selectedNodePipelineId: node ? pipelineId : null };
	}, [selectedNodeId, pipelineState.pipelines]);

	const { selectedEdge, selectedEdgePipelineId, selectedEdgePipelineColor } = useMemo(() => {
		if (!selectedEdgeId)
			return {
				selectedEdge: null,
				selectedEdgePipelineId: null,
				selectedEdgePipelineColor: '#06b6d4',
			};
		const sepIdx = selectedEdgeId.indexOf(':');
		if (sepIdx === -1)
			return {
				selectedEdge: null,
				selectedEdgePipelineId: null,
				selectedEdgePipelineColor: '#06b6d4',
			};
		const pipelineId = selectedEdgeId.substring(0, sepIdx);
		const edgeLocalId = selectedEdgeId.substring(sepIdx + 1);
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId);
		const edge = pipeline?.edges.find((e) => e.id === edgeLocalId);
		return {
			selectedEdge: edge ?? null,
			selectedEdgePipelineId: edge ? pipelineId : null,
			selectedEdgePipelineColor: pipeline?.color ?? '#06b6d4',
		};
	}, [selectedEdgeId, pipelineState.pipelines]);

	// Resolve source/target nodes for the selected edge
	const { edgeSourceNode, edgeTargetNode } = useMemo(() => {
		if (!selectedEdge || !selectedEdgePipelineId)
			return { edgeSourceNode: null, edgeTargetNode: null };
		const pipeline = pipelineState.pipelines.find((p) => p.id === selectedEdgePipelineId);
		if (!pipeline) return { edgeSourceNode: null, edgeTargetNode: null };
		return {
			edgeSourceNode: pipeline.nodes.find((n) => n.id === selectedEdge.source) ?? null,
			edgeTargetNode: pipeline.nodes.find((n) => n.id === selectedEdge.target) ?? null,
		};
	}, [selectedEdge, selectedEdgePipelineId, pipelineState.pipelines]);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		setSelectedNodeId(node.id);
		setSelectedEdgeId(null);
	}, []);

	const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
		setSelectedEdgeId(edge.id);
		setSelectedNodeId(null);
	}, []);

	const onPaneClick = useCallback(() => {
		setSelectedNodeId(null);
		setSelectedEdgeId(null);
	}, []);

	const onUpdateNode = useCallback(
		(nodeId: string, data: Partial<TriggerNodeData | AgentNodeData>) => {
			if (!selectedNodePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedNodePipelineId) return p;
					return {
						...p,
						nodes: p.nodes.map((n) => {
							if (n.id !== nodeId) return n;
							return { ...n, data: { ...n.data, ...data } };
						}),
					};
				}),
			}));
		},
		[selectedNodePipelineId]
	);

	const onDeleteNode = useCallback(
		(nodeId: string) => {
			if (!selectedNodePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedNodePipelineId) return p;
					return {
						...p,
						nodes: p.nodes.filter((n) => n.id !== nodeId),
						edges: p.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
					};
				}),
			}));
			setSelectedNodeId(null);
		},
		[selectedNodePipelineId]
	);

	const onUpdateEdge = useCallback(
		(edgeId: string, updates: Partial<PipelineEdgeType>) => {
			if (!selectedEdgePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedEdgePipelineId) return p;
					return {
						...p,
						edges: p.edges.map((e) => {
							if (e.id !== edgeId) return e;
							return { ...e, ...updates };
						}),
					};
				}),
			}));
		},
		[selectedEdgePipelineId]
	);

	const onDeleteEdge = useCallback(
		(edgeId: string) => {
			if (!selectedEdgePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedEdgePipelineId) return p;
					return {
						...p,
						edges: p.edges.filter((e) => e.id !== edgeId),
					};
				}),
			}));
			setSelectedEdgeId(null);
		},
		[selectedEdgePipelineId]
	);

	// Keyboard shortcut: Delete/Backspace removes selected node or edge
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Delete' || e.key === 'Backspace') {
				// Don't intercept if user is typing in an input
				const target = e.target as HTMLElement;
				if (
					target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.tagName === 'SELECT'
				)
					return;

				if (selectedNode && selectedNodePipelineId) {
					e.preventDefault();
					onDeleteNode(selectedNode.id);
				} else if (selectedEdge && selectedEdgePipelineId) {
					e.preventDefault();
					onDeleteEdge(selectedEdge.id);
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		onDeleteNode,
		onDeleteEdge,
	]);

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
				</div>
				<div className="flex items-center gap-2">
					<PipelineSelector
						pipelines={pipelineState.pipelines}
						selectedPipelineId={pipelineState.selectedPipelineId}
						onSelect={selectPipeline}
						onCreatePipeline={createPipeline}
						onDeletePipeline={deletePipeline}
						onRenamePipeline={renamePipeline}
					/>
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

					{/* Discard Changes */}
					{isDirty && (
						<button
							onClick={handleDiscard}
							className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
							style={{
								backgroundColor: 'transparent',
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
								cursor: 'pointer',
								transition: 'all 0.15s',
							}}
							title="Discard changes and reload from YAML"
						>
							<RotateCcw size={12} />
							Discard
						</button>
					)}

					{/* Save */}
					<button
						onClick={handleSave}
						disabled={saveStatus === 'saving'}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor:
								saveStatus === 'success'
									? '#22c55e20'
									: saveStatus === 'error'
										? '#ef444420'
										: isDirty
											? `${theme.colors.accent}20`
											: 'transparent',
							color:
								saveStatus === 'success'
									? '#22c55e'
									: saveStatus === 'error'
										? '#ef4444'
										: isDirty
											? theme.colors.accent
											: theme.colors.textDim,
							border: `1px solid ${
								saveStatus === 'success'
									? '#22c55e'
									: saveStatus === 'error'
										? '#ef4444'
										: isDirty
											? theme.colors.accent
											: theme.colors.border
							}`,
							cursor: saveStatus === 'saving' ? 'wait' : 'pointer',
							transition: 'all 0.15s',
							position: 'relative',
						}}
						title={isDirty ? 'Save pipeline to YAML' : 'No unsaved changes'}
					>
						{saveStatus === 'success' ? (
							<Check size={12} />
						) : saveStatus === 'error' ? (
							<AlertTriangle size={12} />
						) : (
							<Save size={12} />
						)}
						{saveStatus === 'saving'
							? 'Saving...'
							: saveStatus === 'success'
								? 'Saved'
								: saveStatus === 'error'
									? 'Error'
									: 'Save'}
						{isDirty && saveStatus === 'idle' && (
							<span
								style={{
									width: 6,
									height: 6,
									borderRadius: '50%',
									backgroundColor: theme.colors.accent,
									position: 'absolute',
									top: 2,
									right: 2,
								}}
							/>
						)}
					</button>
				</div>
			</div>

			{/* Validation errors */}
			{validationErrors.length > 0 && (
				<div
					className="px-4 py-2 text-xs flex items-center gap-2 flex-wrap"
					style={{ backgroundColor: '#ef444415', borderBottom: `1px solid #ef4444` }}
				>
					<AlertTriangle size={12} style={{ color: '#ef4444', flexShrink: 0 }} />
					{validationErrors.map((err, i) => (
						<span key={i} style={{ color: '#ef4444' }}>
							{err}
							{i < validationErrors.length - 1 ? ';' : ''}
						</span>
					))}
				</div>
			)}

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
					onNodeClick={onNodeClick}
					onEdgeClick={onEdgeClick}
					onPaneClick={onPaneClick}
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

				{/* Config panels */}
				{selectedNode && !selectedEdge && (
					<NodeConfigPanel
						selectedNode={selectedNode}
						pipelines={pipelineState.pipelines}
						onUpdateNode={onUpdateNode}
						onDeleteNode={onDeleteNode}
						onSwitchToAgent={onSwitchToSession}
					/>
				)}
				{selectedEdge && !selectedNode && (
					<EdgeConfigPanel
						selectedEdge={selectedEdge}
						sourceNode={edgeSourceNode}
						targetNode={edgeTargetNode}
						pipelineColor={selectedEdgePipelineColor}
						onUpdateEdge={onUpdateEdge}
						onDeleteEdge={onDeleteEdge}
					/>
				)}
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
