/**
 * usePipelineState — Pipeline CRUD, dirty tracking, save/discard, and node/edge mutations.
 *
 * Central state hook for the pipeline editor. Owns all pipeline data, validation,
 * save/discard lifecycle, and node/edge mutation callbacks. Calls usePipelineLayout
 * internally for layout persistence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactFlowInstance } from 'reactflow';
import type {
	CuePipelineState,
	CuePipeline,
	CueGraphSession,
	PipelineEdge as PipelineEdgeType,
	TriggerNodeData,
	AgentNodeData,
	CueEventType,
} from '../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from '../../components/CuePipelineEditor/pipelineColors';
import { graphSessionsToPipelines } from '../../components/CuePipelineEditor/utils/yamlToPipeline';
import { pipelinesToYaml } from '../../components/CuePipelineEditor/utils/pipelineToYaml';
import type { CueSettings } from '../../../shared/cue';
import { DEFAULT_CUE_SETTINGS } from '../../../shared/cue';
import { usePipelineLayout } from './usePipelineLayout';
import { captureException } from '../../utils/sentry';
import { getModalActions } from '../../stores/modalStore';

// ─── Shared types ────────────────────────────────────────────────────────────

export type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';
import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';

export interface ActiveRunInfo {
	subscriptionName: string;
	sessionName: string;
}

// ─── Exported constants & pure functions ─────────────────────────────────────

export const DEFAULT_TRIGGER_LABELS: Record<CueEventType, string> = {
	'app.startup': 'Startup',
	'time.heartbeat': 'Heartbeat',
	'time.scheduled': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Done',
	'github.pull_request': 'Pull Request',
	'github.issue': 'Issue',
	'task.pending': 'Pending Task',
	'cli.trigger': 'CLI Trigger',
};

/** Validates pipeline graph before save. Returns array of error messages. */
export function validatePipelines(pipelines: CuePipeline[]): string[] {
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
			} else if (!agentData.inputPrompt?.trim() && agentData.includeUpstreamOutput === false) {
				// Chain agent with upstream output disabled — must have node-level prompt
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

// ─── Hook interface ──────────────────────────────────────────────────────────

export interface UsePipelineStateParams {
	sessions: SessionInfo[];
	graphSessions: CueGraphSession[];
	activeRuns?: ActiveRunInfo[];
	onDirtyChange?: (isDirty: boolean) => void;
	reactFlowInstance: ReactFlowInstance;
	// From usePipelineSelection (wired by shell):
	selectedNodePipelineId: string | null;
	selectedEdgePipelineId: string | null;
	setSelectedNodeId: (id: string | null) => void;
	setSelectedEdgeId: (id: string | null) => void;
	// Drawer toggles (selectPipeline closes drawers on null):
	setTriggerDrawerOpen: (open: boolean) => void;
	setAgentDrawerOpen: (open: boolean) => void;
}

export interface UsePipelineStateReturn {
	pipelineState: CuePipelineState;
	setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
	isAllPipelinesView: boolean;
	isDirty: boolean;
	setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
	saveStatus: 'idle' | 'saving' | 'success' | 'error';
	validationErrors: string[];
	savedStateRef: React.MutableRefObject<string>;
	cueSettings: CueSettings;
	setCueSettings: React.Dispatch<React.SetStateAction<CueSettings>>;
	showSettings: boolean;
	setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
	runningPipelineIds: Set<string>;
	persistLayout: () => void;
	handleSave: () => Promise<void>;
	handleDiscard: () => Promise<void>;
	createPipeline: () => void;
	deletePipeline: (id: string) => void;
	renamePipeline: (id: string, name: string) => void;
	selectPipeline: (id: string | null) => void;
	changePipelineColor: (id: string, color: string) => void;
	onUpdateNode: (nodeId: string, data: Partial<TriggerNodeData | AgentNodeData>) => void;
	onUpdateEdgePrompt: (edgeId: string, prompt: string) => void;
	onDeleteNode: (nodeId: string) => void;
	onUpdateEdge: (edgeId: string, updates: Partial<PipelineEdgeType>) => void;
	onDeleteEdge: (edgeId: string) => void;
}

// ─── Hook implementation ─────────────────────────────────────────────────────

export function usePipelineState({
	sessions,
	graphSessions,
	activeRuns,
	onDirtyChange,
	reactFlowInstance,
	selectedNodePipelineId,
	selectedEdgePipelineId,
	setSelectedNodeId,
	setSelectedEdgeId,
	setTriggerDrawerOpen,
	setAgentDrawerOpen,
}: UsePipelineStateParams): UsePipelineStateReturn {
	const [pipelineState, setPipelineState] = useState<CuePipelineState>({
		pipelines: [],
		selectedPipelineId: null,
	});

	const isAllPipelinesView = pipelineState.selectedPipelineId === null;

	// Save/load state
	const [isDirty, setIsDirty] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const savedStateRef = useRef<string>('');

	// Cue global settings
	const [cueSettings, setCueSettings] = useState<CueSettings>({ ...DEFAULT_CUE_SETTINGS });
	const [showSettings, setShowSettings] = useState(false);

	// Layout persistence (composed hook)
	const { persistLayout } = usePipelineLayout({
		reactFlowInstance,
		graphSessions,
		sessions,
		pipelineState,
		setPipelineState,
		savedStateRef,
		setIsDirty,
	});

	// Load global Cue settings from engine
	useEffect(() => {
		window.maestro.cue
			.getSettings()
			.then((settings) => setCueSettings(settings))
			.catch((err: unknown) => {
				captureException(err, { extra: { operation: 'cue.getSettings' } });
			});
	}, []);

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
		} catch (err: unknown) {
			captureException(err, { extra: { operation: 'cue.pipelineSave' } });
			setSaveStatus('error');
			setTimeout(() => setSaveStatus('idle'), 3000);
		}
	}, [pipelineState.pipelines, sessions, cueSettings, persistLayout]);

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
		} catch (err: unknown) {
			captureException(err, { extra: { operation: 'cue.pipelineDiscard' } });
		}
	}, [sessions]);

	const createPipeline = useCallback(() => {
		setPipelineState((prev) => {
			// Find the highest existing pipeline number to avoid duplicates after deletions
			let maxNum = 0;
			for (const p of prev.pipelines) {
				const match = p.name.match(/^Pipeline (\d+)$/);
				if (match) {
					maxNum = Math.max(maxNum, parseInt(match[1], 10));
				}
			}
			const newPipeline: CuePipeline = {
				id: `pipeline-${Date.now()}`,
				name: `Pipeline ${maxNum + 1}`,
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

	const deletePipeline = useCallback(
		(id: string) => {
			const state = pipelineState;
			const pipeline = state.pipelines.find((p) => p.id === id);
			if (!pipeline) return;

			const doDelete = () => {
				setPipelineState((prev) => {
					const otherPipelines = prev.pipelines.filter((p) => p.id !== id);
					const newSelectedId = prev.selectedPipelineId === id ? null : prev.selectedPipelineId;
					return { pipelines: otherPipelines, selectedPipelineId: newSelectedId };
				});
			};

			if (pipeline.nodes.length > 0) {
				getModalActions().showConfirmation(
					`Delete pipeline "${pipeline.name}" and its nodes?`,
					doDelete
				);
			} else {
				doDelete();
			}
		},
		[pipelineState]
	);

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
		[persistLayout, setTriggerDrawerOpen, setAgentDrawerOpen]
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
		if (!activeRuns || activeRuns.length === 0) return ids;
		for (const run of activeRuns) {
			// Match subscription name to pipeline name (strip -chain-N, -fanin suffixes)
			const baseName = run.subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
			for (const pipeline of pipelineState.pipelines) {
				if (pipeline.name === baseName) {
					ids.add(pipeline.id);
				}
			}
		}
		return ids;
	}, [activeRuns, pipelineState.pipelines]);

	// ─── Node/edge mutation callbacks ────────────────────────────────────────

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
		[selectedNodePipelineId, setSelectedNodeId]
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
		[selectedEdgePipelineId, setSelectedEdgeId]
	);

	return {
		pipelineState,
		setPipelineState,
		isAllPipelinesView,
		isDirty,
		setIsDirty,
		saveStatus,
		validationErrors,
		savedStateRef,
		cueSettings,
		setCueSettings,
		showSettings,
		setShowSettings,
		runningPipelineIds,
		persistLayout,
		handleSave,
		handleDiscard,
		createPipeline,
		deletePipeline,
		renamePipeline,
		selectPipeline,
		changePipelineColor,
		onUpdateNode,
		onUpdateEdgePrompt,
		onDeleteNode,
		onUpdateEdge,
		onDeleteEdge,
	};
}
