/**
 * usePipelineState — Composition hook for the pipeline editor.
 *
 * Owns the pipeline data (state + shared refs), dirty tracking, cueDirtyStore
 * sync, and the safety-net effect that resets a stale selectedPipelineId.
 * Everything else is delegated to extracted single-responsibility hooks:
 *
 *   - useCueSettings        → settings fetch + settingsLoaded flag (Fix #1)
 *   - usePipelineLayout     → layout persistence (debounced writes + restore)
 *   - usePipelineCrud       → create / delete / rename / select / recolor
 *   - usePipelineMutations  → node/edge mutations scoped to selected pipeline
 *   - usePipelinePersistence → save / discard / validation
 *
 * Public return shape (`UsePipelineStateReturn`) is a load-bearing contract —
 * preserved byte-for-byte so existing consumers (CuePipelineEditor shell and
 * its tests) continue to compile without changes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactFlowInstance, Viewport } from 'reactflow';
import type {
	CuePipelineState,
	CueGraphSession,
	PipelineEdge as PipelineEdgeType,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
} from '../../../shared/cue-pipeline-types';
import type { CueSettings } from '../../../shared/cue';
import { usePipelineLayout } from './usePipelineLayout';
import { useCueSettings } from './useCueSettings';
import { usePipelineCrud } from './usePipelineCrud';
import { usePipelineMutations } from './usePipelineMutations';
import { usePipelinePersistence } from './usePipelinePersistence';
import { useCueDirtyStore } from '../../stores/cueDirtyStore';

// Re-export for backwards compatibility with existing importers (e.g. CuePipelineEditor.tsx).
export {
	validatePipelines,
	DEFAULT_TRIGGER_LABELS,
} from '../../components/CuePipelineEditor/utils/pipelineValidation';

// ─── Shared types ────────────────────────────────────────────────────────────

export type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';
import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';

export interface ActiveRunInfo {
	subscriptionName: string;
	sessionName: string;
}

// ─── Hook interface ──────────────────────────────────────────────────────────

export interface UsePipelineStateParams {
	sessions: SessionInfo[];
	graphSessions: CueGraphSession[];
	activeRuns?: ActiveRunInfo[];
	reactFlowInstance: ReactFlowInstance;
	// From usePipelineSelection (wired by shell):
	selectedNodePipelineId: string | null;
	selectedEdgePipelineId: string | null;
	setSelectedNodeId: (id: string | null) => void;
	setSelectedEdgeId: (id: string | null) => void;
	// Drawer toggles (selectPipeline closes drawers on null):
	setTriggerDrawerOpen: (open: boolean) => void;
	setAgentDrawerOpen: (open: boolean) => void;
	/** Optional callback fired after a successful save — wired by CueModal to
	 *  refresh dashboard graph data so saved state is visible immediately. */
	onSaveSuccess?: () => void;
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
	/**
	 * Per-pipeline set of `sessionName`s whose agents are currently executing a
	 * Cue run. Used to animate ONLY the edges that feed into a running agent
	 * rather than every edge in a pipeline that happens to have any run active.
	 *
	 * Key: `pipeline.id`. Value: set of agent `sessionName`s that appear in an
	 * `ActiveRunInfo` entry whose subscription belongs to this pipeline.
	 * Empty/absent when no runs are active for the pipeline.
	 */
	runningAgentsByPipeline: Map<string, Set<string>>;
	/**
	 * Per-pipeline set of exact subscription names that currently have at
	 * least one active run. Used to animate ONLY the trigger node whose
	 * subscription actually fired — rather than every trigger in a pipeline
	 * where any sub is running.
	 *
	 * Key: `pipeline.id`. Value: set of full `subscriptionName` strings
	 * (not stripped) so per-trigger matching is exact.
	 */
	runningSubscriptionsByPipeline: Map<string, Set<string>>;
	persistLayout: () => void;
	/** Saved viewport awaiting application once ReactFlow has measured nodes. */
	pendingSavedViewportRef: React.MutableRefObject<Viewport | null>;
	handleSave: () => Promise<void>;
	handleDiscard: () => Promise<void>;
	createPipeline: () => void;
	deletePipeline: (id: string) => void;
	renamePipeline: (id: string, name: string) => void;
	selectPipeline: (id: string | null) => void;
	changePipelineColor: (id: string, color: string) => void;
	onUpdateNode: (
		nodeId: string,
		data: Partial<TriggerNodeData | AgentNodeData | CommandNodeData>
	) => void;
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
	reactFlowInstance,
	selectedNodePipelineId,
	selectedEdgePipelineId,
	setSelectedNodeId,
	setSelectedEdgeId,
	setTriggerDrawerOpen,
	setAgentDrawerOpen,
	onSaveSuccess,
}: UsePipelineStateParams): UsePipelineStateReturn {
	// ── Owned state + refs (single writer) ─────────────────────────────────
	const [pipelineState, setPipelineState] = useState<CuePipelineState>({
		pipelines: [],
		selectedPipelineId: null,
	});
	// Mirror of pipelineState.pipelines updated during render so handleSave can
	// read the latest value after flushing debounced edits — React's setState
	// from a flush callback is batched and NOT visible in handleSave's closure,
	// so reading through this ref after yielding to the microtask queue is the
	// only way to observe the freshly-flushed prompt writes in the save path.
	const pipelinesRef = useRef(pipelineState.pipelines);
	pipelinesRef.current = pipelineState.pipelines;
	const [isDirty, setIsDirty] = useState(false);
	const savedStateRef = useRef<string>('');
	// Project roots that the most recent successful save (or initial load)
	// wrote to. Shared with usePipelineLayout (seeds on mount from persisted
	// writtenRoots) and usePipelinePersistence (updates on each successful
	// save, reads to determine which roots need empty-YAML clear).
	const lastWrittenRootsRef = useRef<Set<string>>(new Set());

	const isAllPipelinesView = pipelineState.selectedPipelineId === null;

	// ── Extracted single-responsibility hooks ──────────────────────────────
	const { cueSettings, setCueSettings, settingsLoaded, showSettings, setShowSettings } =
		useCueSettings();

	const { persistLayout, pendingSavedViewportRef } = usePipelineLayout({
		reactFlowInstance,
		graphSessions,
		sessions,
		pipelineState,
		setPipelineState,
		savedStateRef,
		lastWrittenRootsRef,
		setIsDirty,
	});

	const crud = usePipelineCrud({
		state: { pipelineState },
		setters: { setPipelineState },
		actions: { persistLayout },
		drawers: { setTriggerDrawerOpen, setAgentDrawerOpen },
	});

	const mutations = usePipelineMutations({
		setPipelineState,
		selection: {
			selectedNodePipelineId,
			selectedEdgePipelineId,
			setSelectedNodeId,
			setSelectedEdgeId,
		},
	});

	const persistence = usePipelinePersistence({
		state: { pipelineState, pipelinesRef, savedStateRef, lastWrittenRootsRef },
		deps: { sessions, cueSettings, settingsLoaded },
		actions: { setPipelineState, setIsDirty, persistLayout, onSaveSuccess },
	});

	// ── Composition-owned effects ─────────────────────────────────────────
	// Track dirty state when pipelines change.
	//
	// NOTE: we deliberately do NOT clear validationErrors here. `persistence`
	// returns a new object identity every render, so adding it to deps (which
	// we previously did, to reach `setValidationErrors`) caused this effect to
	// fire on every re-render. The moment `handleSave` surfaced validation
	// errors, the resulting re-render immediately wiped them — the banner
	// flashed for one frame and was gone. Errors are re-computed on the next
	// save attempt; leaving them visible until then is the intended UX.
	useEffect(() => {
		const currentSnapshot = JSON.stringify(pipelineState.pipelines);
		if (savedStateRef.current && currentSnapshot !== savedStateRef.current) {
			setIsDirty(true);
		}
	}, [pipelineState.pipelines]);

	// Push dirty state into the shared store so CueModal can read it without prop-drilling
	useEffect(() => {
		useCueDirtyStore.getState().setPipelineDirty(isDirty);
	}, [isDirty]);

	// Safety net: if `selectedPipelineId` ever points at a pipeline that no
	// longer exists in `pipelines`, reset to "All Pipelines" so the canvas
	// stays populated. This was the user-visible "pipeline vanished after
	// save" symptom — `convertToReactFlowNodes` skips every pipeline whose id
	// doesn't match the selected id, so a stale selection caused the entire
	// canvas to render empty until the editor was remounted (tab switch).
	//
	// Also clear node/edge selection when the owning pipeline disappears:
	// composite IDs like `"pipelineId:nodeId"` become unresolvable otherwise
	// and the config panel renders empty while still occupying layout space.
	useEffect(() => {
		const sel = pipelineState.selectedPipelineId;
		if (sel === null) return;
		if (pipelineState.pipelines.length === 0) return;
		if (pipelineState.pipelines.some((p) => p.id === sel)) return;
		setPipelineState((prev) => ({ ...prev, selectedPipelineId: null }));
		setSelectedNodeId(null);
		setSelectedEdgeId(null);
	}, [
		pipelineState.pipelines,
		pipelineState.selectedPipelineId,
		setSelectedNodeId,
		setSelectedEdgeId,
	]);

	// Determine which pipelines have active runs. Used for pipeline-level UI
	// affordances (trigger Play button "Running" state, badges).
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

	// Per-pipeline set of running agent session names. Used by
	// `convertToReactFlowEdges` to animate only the edges feeding into a
	// currently-running agent, instead of every edge in a pipeline that
	// happens to have any run active.
	//
	// Keyed by pipeline id (not name) so the mapping is stable against
	// rename. Values store `sessionName` because that's what `ActiveRunInfo`
	// carries; the edge-matching step compares against agent nodes' `sessionName`.
	const runningAgentsByPipeline = useMemo(() => {
		const map = new Map<string, Set<string>>();
		if (!activeRuns || activeRuns.length === 0) return map;
		for (const run of activeRuns) {
			const baseName = run.subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
			for (const pipeline of pipelineState.pipelines) {
				if (pipeline.name !== baseName) continue;
				let set = map.get(pipeline.id);
				if (!set) {
					set = new Set<string>();
					map.set(pipeline.id, set);
				}
				set.add(run.sessionName);
			}
		}
		return map;
	}, [activeRuns, pipelineState.pipelines]);

	// Per-pipeline set of exact subscription names with active runs. Used by
	// `convertToReactFlowNodes` to animate only the trigger node whose
	// subscription fired — not every trigger in a multi-trigger pipeline
	// when any sub is running. We store the FULL subscription name (e.g.
	// "Pipeline 1-chain-2") so trigger nodes can match exactly via their
	// own `subscriptionName` field (populated by yamlToPipeline on load).
	const runningSubscriptionsByPipeline = useMemo(() => {
		const map = new Map<string, Set<string>>();
		if (!activeRuns || activeRuns.length === 0) return map;
		for (const run of activeRuns) {
			const baseName = run.subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
			for (const pipeline of pipelineState.pipelines) {
				if (pipeline.name !== baseName) continue;
				let set = map.get(pipeline.id);
				if (!set) {
					set = new Set<string>();
					map.set(pipeline.id, set);
				}
				set.add(run.subscriptionName);
			}
		}
		return map;
	}, [activeRuns, pipelineState.pipelines]);

	return {
		pipelineState,
		setPipelineState,
		isAllPipelinesView,
		isDirty,
		setIsDirty,
		saveStatus: persistence.saveStatus,
		validationErrors: persistence.validationErrors,
		savedStateRef,
		cueSettings,
		setCueSettings,
		showSettings,
		setShowSettings,
		runningPipelineIds,
		runningAgentsByPipeline,
		runningSubscriptionsByPipeline,
		persistLayout,
		pendingSavedViewportRef,
		handleSave: persistence.handleSave,
		handleDiscard: persistence.handleDiscard,
		createPipeline: crud.createPipeline,
		deletePipeline: crud.deletePipeline,
		renamePipeline: crud.renamePipeline,
		selectPipeline: crud.selectPipeline,
		changePipelineColor: crud.changePipelineColor,
		onUpdateNode: mutations.onUpdateNode,
		onUpdateEdgePrompt: mutations.onUpdateEdgePrompt,
		onDeleteNode: mutations.onDeleteNode,
		onUpdateEdge: mutations.onUpdateEdge,
		onDeleteEdge: mutations.onDeleteEdge,
	};
}
