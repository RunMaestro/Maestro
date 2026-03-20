/**
 * usePipelineLayout — Layout persistence and restoration for the pipeline editor.
 *
 * Handles debounced layout saving (node positions + viewport) and one-time
 * layout restoration on mount by merging saved positions with live graph data.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactFlowInstance } from 'reactflow';
import type {
	CuePipelineState,
	CueGraphSession,
	PipelineLayoutState,
} from '../../../shared/cue-pipeline-types';
import { graphSessionsToPipelines } from '../../components/CuePipelineEditor/utils/yamlToPipeline';
import { mergePipelinesWithSavedLayout } from '../../components/CuePipelineEditor/utils/pipelineLayout';
import { captureException } from '../../utils/sentry';

import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';

export interface UsePipelineLayoutParams {
	reactFlowInstance: ReactFlowInstance;
	graphSessions: CueGraphSession[];
	sessions: SessionInfo[];
	pipelineState: CuePipelineState;
	setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
	savedStateRef: React.MutableRefObject<string>;
	setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UsePipelineLayoutReturn {
	persistLayout: () => void;
}

export function usePipelineLayout({
	reactFlowInstance,
	graphSessions,
	sessions,
	pipelineState,
	setPipelineState,
	savedStateRef,
	setIsDirty,
}: UsePipelineLayoutParams): UsePipelineLayoutReturn {
	const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasRestoredLayoutRef = useRef(false);
	const latestRestoreIdRef = useRef(0);

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
				.catch((err: unknown) => {
					captureException(err, { extra: { operation: 'savePipelineLayout' } });
				});
		}, 500);
	}, [reactFlowInstance]);

	// Clean up debounce timer on unmount
	useEffect(() => {
		return () => {
			if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
		};
	}, []);

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
				savedLayout = (await window.maestro.cue.loadPipelineLayout()) as PipelineLayoutState | null;
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

			if (savedLayout && savedLayout.pipelines) {
				const merged = mergePipelinesWithSavedLayout(livePipelines, savedLayout);

				setPipelineState(merged);
				savedStateRef.current = JSON.stringify(merged.pipelines);

				// Restore viewport if available
				if (savedLayout.viewport) {
					const viewportToRestore = savedLayout.viewport;
					setTimeout(() => {
						if (reqId === latestRestoreIdRef.current) {
							reactFlowInstance.setViewport(viewportToRestore);
						}
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

	return { persistLayout };
}
