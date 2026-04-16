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
		state: { pipelineState, savedStateRef, lastWrittenRootsRef },
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
	useEffect(() => {
		const sel = pipelineState.selectedPipelineId;
		if (sel === null) return;
		if (pipelineState.pipelines.length === 0) return;
		if (pipelineState.pipelines.some((p) => p.id === sel)) return;
		setPipelineState((prev) => ({ ...prev, selectedPipelineId: null }));
	}, [pipelineState.pipelines, pipelineState.selectedPipelineId]);

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
