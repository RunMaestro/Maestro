/**
 * usePipelineLayout — Layout persistence and restoration for the pipeline editor.
 *
 * Handles debounced layout saving (node positions + viewport) and one-time
 * layout restoration on mount by merging saved positions with live graph data.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactFlowInstance, Viewport } from 'reactflow';
import type {
	AgentNodeData,
	CuePipelineState,
	CueGraphSession,
	PipelineLayoutState,
	PipelineProjectViewState,
} from '../../../shared/cue-pipeline-types';
import { PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY } from '../../../shared/cue-pipeline-types';
import { graphSessionsToPipelines } from '../../components/CuePipelineEditor/utils/yamlToPipeline';
import { mergePipelinesWithSavedLayout } from '../../components/CuePipelineEditor/utils/pipelineLayout';
import { resolvePipelinesWriteRoots } from '../../components/CuePipelineEditor/utils/pipelineRoots';
import { captureException } from '../../utils/sentry';
import { cueService } from '../../services/cue';

import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';

/**
 * Resolve the project root of a pipeline by walking its agent nodes and
 * looking up their sessions. Returns the default key when the pipeline has
 * no agent nodes or none of them have a known projectRoot.
 */
function resolvePipelineProjectKey(
	pipelineId: string | null,
	pipelines: CuePipelineState['pipelines'],
	sessions: SessionInfo[]
): string {
	if (!pipelineId) return PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY;
	const pipeline = pipelines.find((p) => p.id === pipelineId);
	if (!pipeline) return PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY;
	const sessionsById = new Map(sessions.map((s) => [s.id, s]));
	const sessionsByName = new Map(sessions.map((s) => [s.name, s]));
	for (const node of pipeline.nodes) {
		if (node.type !== 'agent') continue;
		const data = node.data as AgentNodeData;
		const root =
			sessionsById.get(data.sessionId)?.projectRoot ??
			sessionsByName.get(data.sessionName)?.projectRoot;
		if (root) return root;
	}
	return PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY;
}

/**
 * Pick the per-project view state to apply when restoring layout. Prefers
 * an entry for the selected pipeline's project root, falls back to the
 * default key (which holds v1 legacy data after migration), and finally
 * falls back to the top-level v1 fields so fresh installs still work.
 */
function pickProjectViewState(
	layout: PipelineLayoutState,
	pipelines: CuePipelineState['pipelines'],
	sessions: SessionInfo[]
): PipelineProjectViewState | null {
	const perProject = layout.perProject ?? {};
	const projectKey = resolvePipelineProjectKey(
		layout.selectedPipelineId ?? null,
		pipelines,
		sessions
	);
	if (perProject[projectKey]) return perProject[projectKey];
	if (perProject[PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY]) {
		return perProject[PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY];
	}
	if (layout.selectedPipelineId !== undefined || layout.viewport) {
		return {
			selectedPipelineId: layout.selectedPipelineId ?? null,
			viewport: layout.viewport,
		};
	}
	return null;
}

export interface UsePipelineLayoutParams {
	reactFlowInstance: ReactFlowInstance;
	graphSessions: CueGraphSession[];
	sessions: SessionInfo[];
	pipelineState: CuePipelineState;
	setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
	savedStateRef: React.MutableRefObject<string>;
	/**
	 * Set of project roots that the current saved state corresponds to. Seeded
	 * from the initial loaded pipelines so handleSave knows which roots to
	 * clear if their last pipeline disappears, even when the agent that owned
	 * those pipelines was renamed/removed since the load.
	 */
	lastWrittenRootsRef: React.MutableRefObject<Set<string>>;
	setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UsePipelineLayoutReturn {
	persistLayout: () => void;
	/**
	 * Pending saved viewport from disk, captured during initial restore.
	 * CuePipelineEditor reads this once nodes have been measured and either
	 * applies it via `setViewport` or falls back to `fitView`. Consumed (set
	 * back to null) after the first read to prevent re-application.
	 *
	 * Owning the viewport-apply step in the component (rather than scheduling
	 * `setViewport` on a timeout here) eliminates the race against ReactFlow's
	 * node measurement — the previous implementation could set or fit the
	 * viewport before nodes were measured, leaving the canvas appearing empty
	 * on first open.
	 */
	pendingSavedViewportRef: React.MutableRefObject<Viewport | null>;
}

export function usePipelineLayout({
	reactFlowInstance,
	graphSessions,
	sessions,
	pipelineState,
	setPipelineState,
	savedStateRef,
	lastWrittenRootsRef,
	setIsDirty,
}: UsePipelineLayoutParams): UsePipelineLayoutReturn {
	const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasRestoredLayoutRef = useRef(false);
	const latestRestoreIdRef = useRef(0);
	const pendingSavedViewportRef = useRef<Viewport | null>(null);

	// Keep a ref to current pipeline state for layout persistence (avoids unstable callback)
	const pipelineStateRef = useRef(pipelineState);
	pipelineStateRef.current = pipelineState;

	// Holds the most recently loaded `perProject` map so writes can merge new
	// state for the active project without clobbering other projects. Updated
	// during initial restore and after each persist.
	const perProjectRef = useRef<Record<string, PipelineProjectViewState>>({});
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	// Synchronously assemble + write the current layout state. Shared by the
	// debounced `persistLayout` and the unmount-flush below so closing the
	// modal during the 500 ms debounce window doesn't lose updates to
	// `writtenRoots` from the most recent save (otherwise the next mount
	// reseeds from a stale on-disk layout and a subsequent "delete all +
	// save" cycle can't clear the YAML at the now-orphaned root).
	const writeLayoutNow = useCallback(() => {
		const viewport = reactFlowInstance.getViewport();
		const state = pipelineStateRef.current;
		// Normalize the selection BEFORE computing the project key or
		// writing. A `selectedPipelineId` that doesn't point at any live
		// pipeline must never be persisted — on next load it would bypass
		// the merge fallback via `pickProjectViewState` and blank the
		// canvas (`convertToReactFlowNodes` filters out every pipeline
		// whose id doesn't match the selection). This can happen when
		// ids regenerate on save-reload and a stale perProject entry
		// from a prior id scheme lingers, or when the safety-net reset
		// races against a debounced persist. Treat any unresolvable
		// selection as "All Pipelines" (null).
		const selectionIsValid =
			state.selectedPipelineId === null ||
			state.pipelines.some((p) => p.id === state.selectedPipelineId);
		const safeSelectedId = selectionIsValid ? state.selectedPipelineId : null;

		// Scope this viewport/selection under the current project (derived
		// from the selected pipeline's owning agent session). Other
		// projects' entries are preserved verbatim so switching back to
		// them later still restores their remembered view.
		const projectKey = resolvePipelineProjectKey(
			safeSelectedId,
			state.pipelines,
			sessionsRef.current
		);
		const nextPerProject: Record<string, PipelineProjectViewState> = {
			...perProjectRef.current,
			[projectKey]: {
				selectedPipelineId: safeSelectedId,
				viewport,
			},
		};
		perProjectRef.current = nextPerProject;

		const layout: PipelineLayoutState = {
			version: 2,
			pipelines: state.pipelines,
			// Keep top-level fields pointing at the current project so an
			// older build reading the file still resolves sensible state.
			selectedPipelineId: safeSelectedId,
			viewport,
			perProject: nextPerProject,
			// Persist the written-roots snapshot so the next mount can
			// reseed lastWrittenRootsRef even if the originating agent has
			// been renamed/removed (sessionId/Name lookup would miss the
			// root in that case, leaving stale YAML uncleared).
			writtenRoots: [...lastWrittenRootsRef.current],
		};
		cueService
			.savePipelineLayout(layout as unknown as Record<string, unknown>)
			.catch((err: unknown) => {
				captureException(err, { extra: { operation: 'savePipelineLayout' } });
			});
	}, [reactFlowInstance, lastWrittenRootsRef]);

	// Debounced layout persistence (positions + viewport + written roots)
	const persistLayout = useCallback(() => {
		if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
		layoutSaveTimerRef.current = setTimeout(() => {
			layoutSaveTimerRef.current = null;
			writeLayoutNow();
		}, 500);
	}, [writeLayoutNow]);

	// On unmount: if a debounced write is still pending, flush it before
	// tearing down. Cancelling the timer outright (the previous behavior)
	// dropped writes that landed during the modal-close window — most
	// painfully the post-save `writtenRoots` update, which left the next
	// mount unable to clear orphaned cue.yaml files.
	useEffect(() => {
		return () => {
			if (layoutSaveTimerRef.current) {
				clearTimeout(layoutSaveTimerRef.current);
				layoutSaveTimerRef.current = null;
				writeLayoutNow();
			}
		};
	}, [writeLayoutNow]);

	// Reseed lastWrittenRootsRef from the persisted writtenRoots set as early
	// as possible — independent of graphSessions / livePipelines availability.
	// The main load-layout effect below ALSO rebuilds the ref, but it's gated
	// on graphSessions being non-empty; without this early seed, opening the
	// editor with no live sessions (engine disabled, no registered sessions)
	// would miss orphan-root metadata for the very first save.
	useEffect(() => {
		let cancelled = false;
		const loadWrittenRoots = async () => {
			let savedLayout: PipelineLayoutState | null = null;
			try {
				savedLayout = (await cueService.loadPipelineLayout()) as PipelineLayoutState | null;
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				if (!message.includes('no saved layout') && !message.includes('ENOENT')) {
					captureException(err, { extra: { operation: 'loadPipelineLayout.writtenRoots' } });
				}
				return;
			}
			if (cancelled) return;
			if (!savedLayout?.writtenRoots || !Array.isArray(savedLayout.writtenRoots)) return;
			for (const root of savedLayout.writtenRoots) {
				if (typeof root === 'string' && root.length > 0) {
					lastWrittenRootsRef.current.add(root);
				}
			}
		};
		loadWrittenRoots();
		return () => {
			cancelled = true;
		};
	}, [lastWrittenRootsRef]);

	// Load pipelines once on mount from saved layout merged with live graph data.
	// The pipeline editor is the primary editor — we don't re-sync from disk
	// while the user is working. Save writes back to disk.
	//
	// Uses a request-id guard so that if props change during an in-flight load,
	// only the latest request applies its result.
	useEffect(() => {
		if (hasRestoredLayoutRef.current) return;
		if (!graphSessions || graphSessions.length === 0) return;

		const reqId = ++latestRestoreIdRef.current;

		const loadLayout = async () => {
			const livePipelines = graphSessionsToPipelines(graphSessions, sessions);
			if (livePipelines.length === 0) return;

			let savedLayout: PipelineLayoutState | null = null;
			try {
				savedLayout = (await cueService.loadPipelineLayout()) as PipelineLayoutState | null;
			} catch (err: unknown) {
				// loadPipelineLayout may fail if no layout has been saved yet — that's expected.
				// Report anything else to Sentry.
				const message = err instanceof Error ? err.message : String(err);
				if (!message.includes('no saved layout') && !message.includes('ENOENT')) {
					captureException(err, { extra: { operation: 'loadPipelineLayout' } });
				}
			}

			// Guard: if a newer load started or a previous one already completed, bail out
			if (reqId !== latestRestoreIdRef.current || hasRestoredLayoutRef.current) return;

			let pipelinesForRoots: CuePipelineState['pipelines'];
			if (savedLayout && savedLayout.pipelines) {
				const merged = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
				// Seed the per-project cache so future saves don't stomp on
				// sibling projects' entries.
				perProjectRef.current = { ...(savedLayout.perProject ?? {}) };

				// Pick per-project view state if the selected pipeline has an
				// entry; fall back to legacy top-level fields via the helper.
				const projectView = pickProjectViewState(savedLayout, merged.pipelines, sessions);
				if (projectView) {
					// Validate projectView.selectedPipelineId against live
					// pipelines before assigning — pickProjectViewState returns
					// the stored value verbatim and has no view onto the
					// just-loaded pipelines. A stale id (e.g. a pre-upgrade
					// timestamp id, or a perProject entry written under an
					// old scheme) would otherwise cause `convertToReactFlowNodes`
					// to skip every pipeline and render a blank canvas. When
					// the saved id is null ("All Pipelines"), honor that.
					// When the saved id is truthy but doesn't match any live
					// pipeline, fall through to merge's fallback (first
					// pipeline's id) instead of blanking.
					const saved = projectView.selectedPipelineId;
					if (saved === null) {
						merged.selectedPipelineId = null;
					} else if (merged.pipelines.some((p) => p.id === saved)) {
						merged.selectedPipelineId = saved;
					}
					// else: leave merged.selectedPipelineId as set by
					// mergePipelinesWithSavedLayout (which fell back to the
					// first pipeline's id).
				}

				setPipelineState(merged);
				savedStateRef.current = JSON.stringify(merged.pipelines);
				pipelinesForRoots = merged.pipelines;

				// Stash the saved viewport for the editor to apply once ReactFlow
				// has measured the restored nodes. Applying it here on a timeout
				// raced against `fitView` and — more importantly — against node
				// measurement, which caused the initial canvas to appear empty.
				if (projectView?.viewport) {
					pendingSavedViewportRef.current = projectView.viewport;
				} else if (savedLayout.viewport) {
					pendingSavedViewportRef.current = savedLayout.viewport;
				}
			} else {
				setPipelineState({ pipelines: livePipelines, selectedPipelineId: livePipelines[0].id });
				savedStateRef.current = JSON.stringify(livePipelines);
				pipelinesForRoots = livePipelines;
			}

			// Seed lastWrittenRootsRef from two sources, unioned:
			//   1. The persisted writtenRoots set from the previous save —
			//      authoritative even when the originating agent has since been
			//      renamed or deleted (the session lookup below would miss it
			//      in that case, leaving stale YAML at that root uncleared).
			//   2. Per-pipeline WRITE roots derived from the just-loaded pipelines
			//      via the same rules handleSave uses to partition pipelines by
			//      project root. This is the cross-directory fix for #847: when
			//      a pipeline's agents span subdirectories, its YAML lives at
			//      their common ancestor — we seed that ancestor here so the
			//      next delete+save can clear it. Seeding each individual agent
			//      root (as this loop used to) would both miss the ancestor AND
			//      create stray empty cue.yaml files at sub-paths on delete.
			const loadedRoots = new Set<string>();
			if (savedLayout?.writtenRoots && Array.isArray(savedLayout.writtenRoots)) {
				for (const root of savedLayout.writtenRoots) {
					if (typeof root === 'string' && root.length > 0) {
						loadedRoots.add(root);
					}
				}
			}
			// Build lookup maps with first-wins semantics on duplicate names, matching
			// handleSave's rule (usePipelinePersistence.ts:120-125). Last-wins via
			// `new Map(sessions.map(...))` could pick a different projectRoot than
			// handleSave will actually write to, defeating the parity invariant that
			// is the whole point of `resolvePipelinesWriteRoots`.
			const sessionsById = new Map<string, SessionInfo>();
			const sessionsByName = new Map<string, SessionInfo>();
			for (const s of sessions) {
				sessionsById.set(s.id, s);
				if (!sessionsByName.has(s.name)) sessionsByName.set(s.name, s);
			}
			const writeRoots = resolvePipelinesWriteRoots(
				pipelinesForRoots,
				sessionsById,
				sessionsByName
			);
			for (const root of writeRoots) {
				loadedRoots.add(root);
			}
			lastWrittenRootsRef.current = loadedRoots;

			hasRestoredLayoutRef.current = true;
			setIsDirty(false);
		};

		loadLayout();
	}, [graphSessions, sessions]);

	return { persistLayout, pendingSavedViewportRef };
}
