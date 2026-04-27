/**
 * useCueGraphData — Loads graph-data for the Cue dashboard/pipeline view.
 *
 * Owns graphSessions, graphError, and the derived `dashboardPipelines` +
 * `subscriptionPipelineMap` memos. Re-fetches when `activeTab` changes so
 * switching between dashboard and pipeline views reflects disk state.
 *
 * Exposes `refreshGraphData()` so callers can trigger a fresh fetch after
 * a save — wired by CueModal as the `onSaveSuccess` callback on the pipeline
 * editor (Fix #3 from Phase 10).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cueService } from '../../services/cue';
import { graphSessionsToPipelines } from '../../components/CuePipelineEditor/utils/yamlToPipeline';
import { buildSubscriptionPipelineMap } from '../../components/CueModal/cueModalUtils';
import type { CueGraphSession } from '../../../shared/cue-pipeline-types';
import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';

type CueModalTab = 'dashboard' | 'pipeline';

export interface UseCueGraphDataParams {
	activeTab: CueModalTab;
	sessionInfoList: SessionInfo[];
}

export interface UseCueGraphDataReturn {
	graphSessions: CueGraphSession[];
	graphError: string | null;
	/**
	 * True until the FIRST fetch resolves (success or failure). Subsequent
	 * refetches (tab change, refreshGraphData()) do NOT flip this back to true,
	 * so the editor's loading spinner only appears on initial mount and not on
	 * every refresh.
	 */
	initialLoading: boolean;
	dashboardPipelines: ReturnType<typeof graphSessionsToPipelines>;
	subscriptionPipelineMap: ReturnType<typeof buildSubscriptionPipelineMap>;
	refreshGraphData: () => void;
}

export function useCueGraphData({
	activeTab,
	sessionInfoList,
}: UseCueGraphDataParams): UseCueGraphDataReturn {
	const [graphSessions, setGraphSessions] = useState<CueGraphSession[]>([]);
	const [graphError, setGraphError] = useState<string | null>(null);
	const [initialLoading, setInitialLoading] = useState(true);

	// Monotonic request id so older in-flight fetches cannot overwrite a newer one.
	// Each fetch captures the id at start and bails out if a newer request began
	// (or the component unmounted) before it resolved.
	const fetchIdRef = useRef(0);

	// Track unmount so the final pending fetch doesn't setState after tear-down.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const runFetch = useCallback(() => {
		const myId = ++fetchIdRef.current;
		setGraphError(null);
		cueService
			.getGraphData()
			.then((data: CueGraphSession[]) => {
				if (!mountedRef.current) return;
				if (myId !== fetchIdRef.current) return;
				setGraphSessions(data);
				setInitialLoading(false);
			})
			.catch((err: unknown) => {
				if (!mountedRef.current) return;
				if (myId !== fetchIdRef.current) return;
				setGraphError(err instanceof Error ? err.message : 'Failed to load graph data');
				setInitialLoading(false);
			});
	}, []);

	// Fetch on mount and when tab changes.
	useEffect(() => {
		runFetch();
	}, [activeTab, runFetch]);

	const dashboardPipelines = useMemo(() => {
		if (graphSessions.length === 0) return [];
		return graphSessionsToPipelines(graphSessions, sessionInfoList);
	}, [graphSessions, sessionInfoList]);

	const subscriptionPipelineMap = useMemo(
		() => buildSubscriptionPipelineMap(dashboardPipelines),
		[dashboardPipelines]
	);

	return {
		graphSessions,
		graphError,
		initialLoading,
		dashboardPipelines,
		subscriptionPipelineMap,
		refreshGraphData: runFetch,
	};
}
