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
	ConnectionMode,
	Controls,
	MiniMap,
	ReactFlowProvider,
	MarkerType,
	useReactFlow,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Zap, Bot, Save, RotateCcw, Check, AlertTriangle, Settings, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	CuePipelineState,
	CuePipeline,
	PipelineNode,
	PipelineEdge as PipelineEdgeType,
	PipelineLayoutState,
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
import { NodeConfigPanel, type IncomingTriggerEdgeInfo } from './panels/NodeConfigPanel';
import { EdgeConfigPanel } from './panels/EdgeConfigPanel';
import { graphSessionsToPipelines } from './utils/yamlToPipeline';
import { pipelinesToYaml } from './utils/pipelineToYaml';
import { mergePipelinesWithSavedLayout } from './utils/pipelineLayout';
import { CueSettingsPanel } from './panels/CueSettingsPanel';
import type { CueSettings } from '../../../main/cue/cue-types';
import { DEFAULT_CUE_SETTINGS } from '../../../main/cue/cue-types';

interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: Array<{
		name: string;
		event: string;
		enabled: boolean;
		prompt?: string;
		output_prompt?: string;
		interval_minutes?: number;
		schedule_times?: string[];
		schedule_days?: string[];
		watch?: string;
		source_session?: string | string[];
		fan_out?: string[];
		filter?: Record<string, string | number | boolean>;
		repo?: string;
		poll_minutes?: number;
		agent_id?: string;
		label?: string;
	}>;
}

interface SessionInfo {
	id: string;
	groupId?: string;
	name: string;
	toolType: string;
	projectRoot?: string;
}

interface ActiveRunInfo {
	subscriptionName: string;
	sessionName: string;
}

export interface CuePipelineEditorProps {
	sessions: SessionInfo[];
	groups?: { id: string; name: string; emoji: string }[];
	graphSessions: CueGraphSession[];
	onSwitchToSession: (id: string) => void;
	onClose: () => void;
	onDirtyChange?: (isDirty: boolean) => void;
	theme: Theme;
	activeRuns?: ActiveRunInfo[];
}

const nodeTypes = {
	trigger: TriggerNode,
	agent: AgentNode,
};

const DEFAULT_TRIGGER_LABELS: Record<CueEventType, string> = {
	'time.heartbeat': 'Heartbeat',
	'time.scheduled': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Done',
	'github.pull_request': 'Pull Request',
	'github.issue': 'Issue',
	'task.pending': 'Pending Task',
};

function getTriggerConfigSummary(data: TriggerNodeData): string {
	const { eventType, config } = data;
	switch (eventType) {
		case 'time.heartbeat':
			return config.interval_minutes ? `every ${config.interval_minutes}min` : 'heartbeat';
		case 'time.scheduled': {
			const times = config.schedule_times ?? [];
			const days = config.schedule_days ?? [];
			if (times.length === 0) return 'scheduled';
			const timeStr = times.length <= 2 ? times.join(', ') : `${times.length} times`;
			const dayStr = days.length > 0 && days.length < 7 ? ` (${days.join(', ')})` : '';
			return `${timeStr}${dayStr}`;
		}
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
	selectedPipelineId: string | null,
	onConfigureNode?: (compositeId: string) => void
): Node[] {
	const nodes: Node[] = [];
	const agentPipelineMap = new Map<string, string[]>();

	// When showing all pipelines, compute vertical offsets to prevent overlap
	const pipelineYOffsets = new Map<string, number>();
	if (selectedPipelineId === null && pipelines.length > 1) {
		const PIPELINE_GAP = 100; // px between pipeline groups
		const NODE_HEIGHT = 100; // approximate node height
		let currentY = 0;
		for (const pipeline of pipelines) {
			if (pipeline.nodes.length === 0) continue;
			let minY = Infinity;
			let maxY = -Infinity;
			for (const node of pipeline.nodes) {
				minY = Math.min(minY, node.position.y);
				maxY = Math.max(maxY, node.position.y);
			}
			// Offset so this pipeline's top starts at currentY
			pipelineYOffsets.set(pipeline.id, currentY - minY);
			currentY += maxY - minY + NODE_HEIGHT + PIPELINE_GAP;
		}
	}

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
				const compositeId = `${pipeline.id}:${pNode.id}`;
				const yOffset = pipelineYOffsets.get(pipeline.id) ?? 0;
				const nodeData: TriggerNodeDataProps = {
					compositeId,
					eventType: triggerData.eventType,
					label: triggerData.customLabel || triggerData.label,
					configSummary: getTriggerConfigSummary(triggerData),
					onConfigure: onConfigureNode,
				};
				nodes.push({
					id: compositeId,
					type: 'trigger',
					position: { x: pNode.position.x, y: pNode.position.y + yOffset },
					data: nodeData,
					dragHandle: '.drag-handle',
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
				const compositeId = `${pipeline.id}:${pNode.id}`;
				const yOffset = pipelineYOffsets.get(pipeline.id) ?? 0;
				const hasOutgoingEdge = pipeline.edges.some((e) => e.source === pNode.id);
				const hasEdgePrompt = pipeline.edges.some((e) => e.target === pNode.id && !!e.prompt);
				const nodeData: AgentNodeDataProps = {
					compositeId,
					sessionId: agentData.sessionId,
					sessionName: agentData.sessionName,
					toolType: agentData.toolType,
					hasPrompt: !!(agentData.inputPrompt || agentData.outputPrompt || hasEdgePrompt),
					hasOutgoingEdge,
					pipelineColor: pipeline.color,
					pipelineCount: agentPipelineCount.get(agentData.sessionId) ?? 1,
					pipelineColors,
					onConfigure: onConfigureNode,
				};
				nodes.push({
					id: compositeId,
					type: 'agent',
					position: { x: pNode.position.x, y: pNode.position.y + yOffset },
					data: nodeData,
					dragHandle: '.drag-handle',
					style: !isActive ? { opacity: 0.4 } : undefined,
				});
			}
		}
	}

	return nodes;
}

function convertToReactFlowEdges(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null,
	runningPipelineIds?: Set<string>,
	selectedEdgeId?: string | null
): Edge[] {
	const edges: Edge[] = [];

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;
		const isRunning = runningPipelineIds?.has(pipeline.id) ?? false;

		for (const pEdge of pipeline.edges) {
			const compositeId = `${pipeline.id}:${pEdge.id}`;
			const edgeData: PipelineEdgeData = {
				pipelineColor: pipeline.color,
				mode: pEdge.mode,
				isActivePipeline: isActive,
				isRunning,
			};
			edges.push({
				id: compositeId,
				source: `${pipeline.id}:${pEdge.source}`,
				target: `${pipeline.id}:${pEdge.target}`,
				type: 'pipeline',
				data: edgeData,
				selected: compositeId === selectedEdgeId,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					color: pipeline.color,
					width: selectedEdgeId === compositeId ? 18 : 16,
					height: selectedEdgeId === compositeId ? 18 : 16,
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

		// Check agents have prompts configured.
		// An agent's prompt can live on the node (single trigger) or on incoming edges (multi-trigger).
		for (const agent of agents) {
			const agentData = agent.data as AgentNodeData;
			const incomingEdges = pipeline.edges.filter((e) => e.target === agent.id);
			const hasTriggerEdges = incomingEdges.some((e) => {
				const src = pipeline.nodes.find((n) => n.id === e.source);
				return src?.type === 'trigger';
			});

			if (hasTriggerEdges) {
				// Check: either the agent has a node-level prompt, or ALL incoming trigger edges have prompts
				const triggerEdges = incomingEdges.filter((e) => {
					const src = pipeline.nodes.find((n) => n.id === e.source);
					return src?.type === 'trigger';
				});
				const hasNodePrompt = !!agentData.inputPrompt?.trim();
				const allEdgesHavePrompts = triggerEdges.every((e) => e.prompt?.trim());
				if (!hasNodePrompt && !allEdgesHavePrompts) {
					const name = agentData.sessionName;
					errors.push(`"${pipeline.name}": agent "${name}" is missing a prompt`);
				}
			} else if (!agentData.inputPrompt?.trim()) {
				// Chain agent (incoming from other agents) — must have node-level prompt
				const name = agentData.sessionName;
				errors.push(`"${pipeline.name}": agent "${name}" is missing a prompt`);
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
	groups,
	graphSessions,
	onSwitchToSession,
	onDirtyChange,
	theme,
	activeRuns: activeRunsProp,
}: CuePipelineEditorProps) {
	const reactFlowInstance = useReactFlow();

	const [pipelineState, setPipelineState] = useState<CuePipelineState>({
		pipelines: [],
		selectedPipelineId: null,
	});

	const isAllPipelinesView = pipelineState.selectedPipelineId === null;

	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		nodeId: string;
		pipelineId: string;
		nodeType: 'trigger' | 'agent';
	} | null>(null);

	// Save/load state
	const [isDirty, setIsDirty] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const savedStateRef = useRef<string>(''); // JSON snapshot for dirty tracking
	const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cue global settings
	const [cueSettings, setCueSettings] = useState<CueSettings>({ ...DEFAULT_CUE_SETTINGS });
	const [showSettings, setShowSettings] = useState(false);

	// Keep a ref to current pipeline state for layout persistence (avoids unstable callback)
	const pipelineStateRef = useRef(pipelineState);
	pipelineStateRef.current = pipelineState;

	// Debounced layout persistence (positions + viewport)
	const persistLayout = useCallback(() => {
		if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
		layoutSaveTimerRef.current = setTimeout(() => {
			const viewport = reactFlowInstance.getViewport();
			const state = pipelineStateRef.current;
			const layout: PipelineLayoutState = {
				pipelines: state.pipelines,
				selectedPipelineId: state.selectedPipelineId,
				viewport,
			};
			window.maestro.cue
				.savePipelineLayout(layout as unknown as Record<string, unknown>)
				.catch(() => {});
		}, 500);
	}, [reactFlowInstance]);

	// Clean up debounce timer on unmount
	useEffect(() => {
		return () => {
			if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
		};
	}, []);

	// Load global Cue settings from engine
	useEffect(() => {
		window.maestro.cue
			.getSettings()
			.then((settings) => setCueSettings(settings))
			.catch(() => {});
	}, []);

	// Track whether we've applied saved layout positions yet
	const hasRestoredLayoutRef = useRef(false);

	// Load pipelines once on mount from saved layout merged with live graph data.
	// The pipeline editor is the primary editor — we don't re-sync from disk
	// while the user is working. Save writes back to disk.
	useEffect(() => {
		if (hasRestoredLayoutRef.current) return;
		if (!graphSessions || graphSessions.length === 0) return;

		const loadLayout = async () => {
			const livePipelines = graphSessionsToPipelines(graphSessions, sessions);
			if (livePipelines.length === 0) return;

			let savedLayout: PipelineLayoutState | null = null;
			try {
				savedLayout = (await window.maestro.cue.loadPipelineLayout()) as PipelineLayoutState | null;
			} catch {
				// No saved layout
			}

			if (savedLayout && savedLayout.pipelines) {
				const merged = mergePipelinesWithSavedLayout(livePipelines, savedLayout);

				setPipelineState(merged);
				savedStateRef.current = JSON.stringify(merged.pipelines);

				// Restore viewport if available
				if (savedLayout.viewport) {
					setTimeout(() => {
						reactFlowInstance.setViewport(savedLayout!.viewport!);
					}, 100);
				}
			} else {
				setPipelineState({ pipelines: livePipelines, selectedPipelineId: livePipelines[0].id });
				savedStateRef.current = JSON.stringify(livePipelines);
			}

			hasRestoredLayoutRef.current = true;
			setIsDirty(false);
		};

		loadLayout();
	}, [graphSessions, sessions]);

	// Track dirty state when pipelines change
	useEffect(() => {
		const currentSnapshot = JSON.stringify(pipelineState.pipelines);
		if (savedStateRef.current && currentSnapshot !== savedStateRef.current) {
			setIsDirty(true);
			setValidationErrors([]);
		}
	}, [pipelineState.pipelines]);

	// Notify parent of dirty state changes
	useEffect(() => {
		onDirtyChange?.(isDirty);
	}, [isDirty, onDirtyChange]);

	const handleSave = useCallback(async () => {
		// Validate before save
		const errors = validatePipelines(pipelineState.pipelines);

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

		// No project root means we can't write YAML
		if (projectRoots.size === 0) {
			errors.push('No project root found — agents must have a working directory to save YAML');
		}

		setValidationErrors(errors);
		if (errors.length > 0) return;

		setSaveStatus('saving');
		try {
			const { yaml: yamlContent, promptFiles } = pipelinesToYaml(
				pipelineState.pipelines,
				cueSettings
			);

			// Convert prompt files Map to plain object for IPC
			const promptFilesObj: Record<string, string> = {};
			for (const [filePath, content] of promptFiles) {
				promptFilesObj[filePath] = content;
			}

			// Write YAML + prompt files and refresh sessions
			for (const root of projectRoots) {
				await window.maestro.cue.writeYaml(root, yamlContent, promptFilesObj);
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
			persistLayout();
			setTimeout(() => setSaveStatus('idle'), 2000);
		} catch {
			setSaveStatus('error');
			setTimeout(() => setSaveStatus('idle'), 3000);
		}
	}, [pipelineState.pipelines, sessions, cueSettings]);

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

	const selectPipeline = useCallback(
		(id: string | null) => {
			setPipelineState((prev) => ({ ...prev, selectedPipelineId: id }));
			if (id === null) {
				setTriggerDrawerOpen(false);
				setAgentDrawerOpen(false);
			}
			persistLayout();
		},
		[persistLayout]
	);

	const changePipelineColor = useCallback((id: string, color: string) => {
		setPipelineState((prev) => ({
			...prev,
			pipelines: prev.pipelines.map((p) => (p.id === id ? { ...p, color } : p)),
		}));
	}, []);

	// Determine which pipelines have active runs
	const runningPipelineIds = useMemo(() => {
		const ids = new Set<string>();
		if (!activeRunsProp || activeRunsProp.length === 0) return ids;
		for (const run of activeRunsProp) {
			// Match subscription name to pipeline name (strip -chain-N, -fanin suffixes)
			const baseName = run.subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
			for (const pipeline of pipelineState.pipelines) {
				if (pipeline.name === baseName) {
					ids.add(pipeline.id);
				}
			}
		}
		return ids;
	}, [activeRunsProp, pipelineState.pipelines]);

	const handleConfigureNode = useCallback((compositeId: string) => {
		setSelectedNodeId((prev) => (prev === compositeId ? null : compositeId));
		setSelectedEdgeId(null);
	}, []);

	const nodes = useMemo(
		() =>
			convertToReactFlowNodes(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				handleConfigureNode
			),
		[pipelineState.pipelines, pipelineState.selectedPipelineId, handleConfigureNode]
	);

	const edges = useMemo(
		() =>
			convertToReactFlowEdges(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				runningPipelineIds,
				selectedEdgeId
			),
		[pipelineState.pipelines, pipelineState.selectedPipelineId, runningPipelineIds, selectedEdgeId]
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
	const {
		selectedNode,
		selectedNodePipelineId,
		selectedNodeHasOutgoingEdge,
		incomingTriggerEdges,
	} = useMemo(() => {
		const empty = {
			selectedNode: null as PipelineNode | null,
			selectedNodePipelineId: null as string | null,
			selectedNodeHasOutgoingEdge: false,
			incomingTriggerEdges: [] as IncomingTriggerEdgeInfo[],
		};
		if (!selectedNodeId) return empty;
		// selectedNodeId is composite: "pipelineId:nodeId"
		const sepIdx = selectedNodeId.indexOf(':');
		if (sepIdx === -1) return empty;
		const pipelineId = selectedNodeId.substring(0, sepIdx);
		const nodeId = selectedNodeId.substring(sepIdx + 1);
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId);
		const node = pipeline?.nodes.find((n) => n.id === nodeId);
		const hasOutgoing = pipeline?.edges.some((e) => e.source === nodeId) ?? false;

		// Compute incoming trigger edges for agent nodes
		const triggerEdges: IncomingTriggerEdgeInfo[] = [];
		if (node?.type === 'agent' && pipeline) {
			const incomingEdges = pipeline.edges.filter((e) => e.target === nodeId);
			for (const edge of incomingEdges) {
				const sourceNode = pipeline.nodes.find((n) => n.id === edge.source);
				if (sourceNode?.type === 'trigger') {
					const triggerData = sourceNode.data as TriggerNodeData;
					triggerEdges.push({
						edgeId: edge.id,
						triggerLabel: triggerData.customLabel || triggerData.label,
						configSummary: getTriggerConfigSummary(triggerData),
						prompt: edge.prompt ?? (node.data as AgentNodeData).inputPrompt ?? '',
					});
				}
			}
		}

		return {
			selectedNode: node ?? null,
			selectedNodePipelineId: node ? pipelineId : null,
			selectedNodeHasOutgoingEdge: hasOutgoing,
			incomingTriggerEdges: triggerEdges,
		};
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
		setContextMenu(null);
	}, []);

	const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
		setSelectedEdgeId(edge.id);
		setSelectedNodeId(null);
		setContextMenu(null);
	}, []);

	const onPaneClick = useCallback(() => {
		setSelectedNodeId(null);
		setSelectedEdgeId(null);
		setContextMenu(null);
	}, []);

	const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
		event.preventDefault();
		const sepIdx = node.id.indexOf(':');
		if (sepIdx === -1) return;
		const pipelineId = node.id.substring(0, sepIdx);
		const nodeId = node.id.substring(sepIdx + 1);
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			nodeId,
			pipelineId,
			nodeType: node.type as 'trigger' | 'agent',
		});
	}, []);

	const handleContextMenuConfigure = useCallback(() => {
		if (!contextMenu) return;
		setSelectedNodeId(`${contextMenu.pipelineId}:${contextMenu.nodeId}`);
		setSelectedEdgeId(null);
		setContextMenu(null);
	}, [contextMenu]);

	const handleContextMenuDelete = useCallback(() => {
		if (!contextMenu) return;
		setPipelineState((prev) => ({
			...prev,
			pipelines: prev.pipelines.map((p) => {
				if (p.id !== contextMenu.pipelineId) return p;
				return {
					...p,
					nodes: p.nodes.filter((n) => n.id !== contextMenu.nodeId),
					edges: p.edges.filter(
						(e) => e.source !== contextMenu.nodeId && e.target !== contextMenu.nodeId
					),
				};
			}),
		}));
		setSelectedNodeId(null);
		setContextMenu(null);
	}, [contextMenu]);

	const handleContextMenuDuplicate = useCallback(() => {
		if (!contextMenu || contextMenu.nodeType !== 'trigger') return;
		setPipelineState((prev) => {
			const pipeline = prev.pipelines.find((p) => p.id === contextMenu.pipelineId);
			if (!pipeline) return prev;
			const original = pipeline.nodes.find((n) => n.id === contextMenu.nodeId);
			if (!original || original.type !== 'trigger') return prev;
			const newNode: PipelineNode = {
				id: `trigger-${Date.now()}`,
				type: 'trigger',
				position: { x: original.position.x + 50, y: original.position.y + 50 },
				data: { ...(original.data as TriggerNodeData) },
			};
			return {
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== contextMenu.pipelineId) return p;
					return { ...p, nodes: [...p.nodes, newNode] };
				}),
			};
		});
		setContextMenu(null);
	}, [contextMenu]);

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

	const onUpdateEdgePrompt = useCallback(
		(edgeId: string, prompt: string) => {
			if (!selectedNodePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedNodePipelineId) return p;
					return {
						...p,
						edges: p.edges.map((e) => {
							if (e.id !== edgeId) return e;
							return { ...e, prompt };
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

	// Keyboard shortcuts: Delete/Backspace, Escape, Cmd+S, Cmd+Z
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't intercept if user is typing in an input
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (isInput) return;

				if (selectedNode && selectedNodePipelineId) {
					e.preventDefault();
					onDeleteNode(selectedNode.id);
				} else if (selectedEdge && selectedEdgePipelineId) {
					e.preventDefault();
					onDeleteEdge(selectedEdge.id);
				}
			} else if (e.key === 'Escape') {
				if (triggerDrawerOpen) {
					setTriggerDrawerOpen(false);
				} else if (agentDrawerOpen) {
					setAgentDrawerOpen(false);
				} else if (selectedNodeId || selectedEdgeId) {
					setSelectedNodeId(null);
					setSelectedEdgeId(null);
				}
			} else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSave();
			}
			// TODO: Cmd+Z / Ctrl+Z undo support
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		selectedNodeId,
		selectedEdgeId,
		onDeleteNode,
		onDeleteEdge,
		triggerDrawerOpen,
		agentDrawerOpen,
		handleSave,
	]);

	const onNodesChange: OnNodesChange = useCallback(
		(changes) => {
			// Extract position updates directly from changes to avoid depending on derived `nodes`
			const positionUpdates = new Map<string, { x: number; y: number }>();
			let hasPositionChange = false;
			for (const change of changes) {
				if (change.type === 'position' && change.position) {
					positionUpdates.set(change.id, change.position);
					if (!change.dragging) {
						hasPositionChange = true;
					}
				}
			}

			if (positionUpdates.size > 0) {
				setPipelineState((prev) => {
					const newPipelines = prev.pipelines.map((pipeline) => ({
						...pipeline,
						nodes: pipeline.nodes.map((pNode) => {
							const newPos = positionUpdates.get(`${pipeline.id}:${pNode.id}`);
							if (newPos) {
								return { ...pNode, position: newPos };
							}
							return pNode;
						}),
					}));
					return { ...prev, pipelines: newPipelines };
				});
			}

			// Debounce-save layout when a drag ends
			if (hasPositionChange) {
				persistLayout();
			}
		},
		[persistLayout]
	);

	// Edge changes (selection, removal) — no-op since we manage edges via pipelineState
	const onEdgesChange: OnEdgesChange = useCallback(() => {}, []);

	const onConnect = useCallback((connection: Connection) => {
		if (!connection.source || !connection.target) return;

		const sourcePipelineId = connection.source.split(':')[0];
		const targetPipelineId = connection.target.split(':')[0];
		if (sourcePipelineId !== targetPipelineId) return; // Cross-pipeline connections not supported

		const sourceNodeId = connection.source.split(':').slice(1).join(':');
		const targetNodeId = connection.target.split(':').slice(1).join(':');

		setPipelineState((prev) => {
			const pipeline = prev.pipelines.find((p) => p.id === sourcePipelineId);
			if (!pipeline) return prev;

			// Validate: can't connect into a trigger
			const targetNode = pipeline.nodes.find((n) => n.id === targetNodeId);
			if (!targetNode || targetNode.type === 'trigger') return prev;

			const newEdge = {
				id: `edge-${Date.now()}`,
				source: sourceNodeId,
				target: targetNodeId,
				mode: 'pass' as const,
			};

			return {
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== sourcePipelineId) return p;
					return { ...p, edges: [...p.edges, newEdge] };
				}),
			};
		});
	}, []);

	// Connection validation: prevent invalid edges
	const isValidConnection = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return false;
			// Prevent self-connections
			if (connection.source === connection.target) return false;

			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			if (!sourceNode || !targetNode) return false;

			// Prevent trigger-to-trigger connections
			if (sourceNode.type === 'trigger' && targetNode.type === 'trigger') return false;

			// Prevent connecting into a trigger
			if (targetNode.type === 'trigger') return false;

			// Prevent duplicate edges
			const exists = edges.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) return false;

			return true;
		},
		[nodes, edges]
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = 'move';
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();

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

				// Auto-select the dropped node to open config panel
				const compositeId = `${targetPipeline.id}:${newNode.id}`;
				setTimeout(() => {
					setSelectedNodeId(compositeId);
					setSelectedEdgeId(null);
				}, 50);

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
						onClick={() => !isAllPipelinesView && setTriggerDrawerOpen((v) => !v)}
						disabled={isAllPipelinesView}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: triggerDrawerOpen ? `${theme.colors.accent}20` : 'transparent',
							color: triggerDrawerOpen ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${triggerDrawerOpen ? theme.colors.accent : theme.colors.border}`,
							cursor: isAllPipelinesView ? 'not-allowed' : 'pointer',
							opacity: isAllPipelinesView ? 0.4 : 1,
							transition: 'all 0.15s',
						}}
						title={isAllPipelinesView ? 'Select a pipeline to add triggers' : undefined}
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
						onChangePipelineColor={changePipelineColor}
						textColor={theme.colors.textMain}
						borderColor={theme.colors.border}
					/>
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={() => !isAllPipelinesView && setAgentDrawerOpen((v) => !v)}
						disabled={isAllPipelinesView}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: agentDrawerOpen ? `${theme.colors.accent}20` : 'transparent',
							color: agentDrawerOpen ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${agentDrawerOpen ? theme.colors.accent : theme.colors.border}`,
							cursor: isAllPipelinesView ? 'not-allowed' : 'pointer',
							opacity: isAllPipelinesView ? 0.4 : 1,
							transition: 'all 0.15s',
						}}
						title={isAllPipelinesView ? 'Select a pipeline to add agents' : undefined}
					>
						<Bot size={12} />
						Agents
					</button>

					{/* Settings toggle */}
					<button
						onClick={() => setShowSettings((v) => !v)}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: showSettings ? `${theme.colors.accent}20` : 'transparent',
							color: showSettings ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${showSettings ? theme.colors.accent : theme.colors.border}`,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
						title="Global Cue settings"
					>
						<Settings size={12} />
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
				<TriggerDrawer
					isOpen={triggerDrawerOpen}
					onClose={() => setTriggerDrawerOpen(false)}
					theme={theme}
				/>

				{/* Empty state overlay */}
				{nodes.length === 0 && (
					<div
						className="absolute inset-0 flex items-center justify-center"
						style={{
							zIndex: 5,
							pointerEvents: pipelineState.pipelines.length === 0 ? 'auto' : 'none',
						}}
					>
						{pipelineState.pipelines.length === 0 ? (
							<div className="flex flex-col items-center gap-4 text-center px-8">
								<Zap size={28} style={{ color: theme.colors.textDim, opacity: 0.5 }} />
								<span className="text-sm" style={{ color: theme.colors.textDim }}>
									Build event-driven automations by connecting triggers to agents
								</span>
								<button
									onClick={() => {
										createPipeline();
										setTimeout(() => {
											setTriggerDrawerOpen(true);
											setAgentDrawerOpen(true);
										}, 50);
									}}
									className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.bgMain,
										cursor: 'pointer',
										transition: 'opacity 0.15s',
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.opacity = '0.85';
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.opacity = '1';
									}}
								>
									<Plus size={14} />
									Create your first pipeline
								</button>
							</div>
						) : (
							<div className="flex flex-col items-center gap-3 text-center px-8">
								<div className="flex items-center gap-6" style={{ color: theme.colors.textDim }}>
									<div className="flex flex-col items-center gap-1">
										<span style={{ fontSize: 20 }}>←</span>
										<span className="text-xs">Triggers</span>
									</div>
									<div className="flex flex-col items-center gap-2 max-w-xs">
										<Zap size={24} style={{ color: theme.colors.textDim, opacity: 0.5 }} />
										<span className="text-sm" style={{ color: theme.colors.textDim }}>
											Drag a trigger from the left drawer and an agent from the right drawer
										</span>
									</div>
									<div className="flex flex-col items-center gap-1">
										<span style={{ fontSize: 20 }}>→</span>
										<span className="text-xs">Agents</span>
									</div>
								</div>
							</div>
						)}
					</div>
				)}

				{/* React Flow Canvas */}
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					isValidConnection={isValidConnection}
					onNodeClick={onNodeClick}
					onEdgeClick={onEdgeClick}
					onPaneClick={onPaneClick}
					onNodeContextMenu={onNodeContextMenu}
					onDragOver={onDragOver}
					onDrop={onDrop}
					connectionMode={ConnectionMode.Loose}
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
						nodeColor={(node) => {
							// Extract pipeline color from node data
							if (node.type === 'trigger') {
								const data = node.data as TriggerNodeDataProps;
								// Use event type color palette
								const eventColors: Record<string, string> = {
									'time.heartbeat': '#f59e0b',
									'time.scheduled': '#8b5cf6',
									'file.changed': '#3b82f6',
									'agent.completed': '#22c55e',
									'github.pull_request': '#a855f7',
									'github.issue': '#f97316',
									'task.pending': '#06b6d4',
								};
								return eventColors[data.eventType] ?? theme.colors.accent;
							}
							if (node.type === 'agent') {
								const data = node.data as AgentNodeDataProps;
								return data.pipelineColor ?? theme.colors.accent;
							}
							return theme.colors.accent;
						}}
					/>
				</ReactFlow>

				{/* Agent drawer (right) */}
				<AgentDrawer
					isOpen={agentDrawerOpen}
					onClose={() => setAgentDrawerOpen(false)}
					sessions={sessions}
					groups={groups}
					onCanvasSessionIds={onCanvasSessionIds}
					theme={theme}
				/>

				{/* Pipeline legend (shown in All Pipelines view) */}
				{pipelineState.selectedPipelineId === null && pipelineState.pipelines.length > 0 && (
					<div
						style={{
							position: 'absolute',
							top: 8,
							left: '50%',
							transform: 'translateX(-50%)',
							zIndex: 10,
							display: 'flex',
							alignItems: 'center',
							gap: 12,
							padding: '6px 14px',
							backgroundColor: `${theme.colors.bgActivity}ee`,
							border: `1px solid ${theme.colors.border}`,
							borderRadius: 6,
							backdropFilter: 'blur(8px)',
						}}
					>
						{pipelineState.pipelines.map((p) => (
							<button
								key={p.id}
								onClick={() => selectPipeline(p.id)}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 6,
									fontSize: 11,
									color: theme.colors.textMain,
									backgroundColor: 'transparent',
									border: 'none',
									cursor: 'pointer',
									padding: '2px 4px',
									borderRadius: 4,
									transition: 'background-color 0.15s',
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.backgroundColor = 'transparent';
								}}
								title={`Switch to ${p.name}`}
							>
								<span
									style={{
										width: 10,
										height: 10,
										borderRadius: '50%',
										backgroundColor: p.color,
										flexShrink: 0,
										border: '1px solid rgba(255,255,255,0.15)',
									}}
								/>
								<span style={{ fontWeight: 500 }}>{p.name}</span>
								<span style={{ color: theme.colors.textDim, fontSize: 10 }}>
									({p.nodes.length})
								</span>
							</button>
						))}
					</div>
				)}

				{/* Cue settings panel */}
				{showSettings && (
					<CueSettingsPanel
						settings={cueSettings}
						onChange={(s) => {
							setCueSettings(s);
							setIsDirty(true);
						}}
						onClose={() => setShowSettings(false)}
					/>
				)}

				{/* Config panels */}
				{selectedNode && !selectedEdge && (
					<NodeConfigPanel
						selectedNode={selectedNode}
						pipelines={pipelineState.pipelines}
						hasOutgoingEdge={selectedNodeHasOutgoingEdge}
						incomingTriggerEdges={incomingTriggerEdges}
						onUpdateNode={onUpdateNode}
						onUpdateEdgePrompt={onUpdateEdgePrompt}
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

				{/* Node context menu */}
				{contextMenu && (
					<div
						className="fixed"
						style={{
							left: contextMenu.x,
							top: contextMenu.y,
							zIndex: 50,
						}}
					>
						<div
							style={{
								backgroundColor: '#1e1e2e',
								border: '1px solid #444',
								borderRadius: 6,
								boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
								padding: '4px 0',
								minWidth: 140,
							}}
						>
							<button
								onClick={handleContextMenuConfigure}
								style={{
									display: 'block',
									width: '100%',
									textAlign: 'left',
									padding: '6px 12px',
									fontSize: 12,
									color: '#e4e4e7',
									backgroundColor: 'transparent',
									border: 'none',
									cursor: 'pointer',
								}}
								onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2a2a3e')}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							>
								Configure
							</button>
							{contextMenu.nodeType === 'trigger' && (
								<button
									onClick={handleContextMenuDuplicate}
									style={{
										display: 'block',
										width: '100%',
										textAlign: 'left',
										padding: '6px 12px',
										fontSize: 12,
										color: '#e4e4e7',
										backgroundColor: 'transparent',
										border: 'none',
										cursor: 'pointer',
									}}
									onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2a2a3e')}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
								>
									Duplicate
								</button>
							)}
							<div
								style={{
									height: 1,
									backgroundColor: '#333',
									margin: '4px 0',
								}}
							/>
							<button
								onClick={handleContextMenuDelete}
								style={{
									display: 'block',
									width: '100%',
									textAlign: 'left',
									padding: '6px 12px',
									fontSize: 12,
									color: '#ef4444',
									backgroundColor: 'transparent',
									border: 'none',
									cursor: 'pointer',
								}}
								onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2a2a3e')}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							>
								Delete
							</button>
						</div>
					</div>
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
