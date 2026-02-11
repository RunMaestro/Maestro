/**
 * useVibesData Hook
 *
 * Provides reactive access to VIBES audit metadata for the current project
 * via IPC calls to the main process. Includes auto-refresh on a 10-second
 * interval when VIBES is enabled and the panel is active.
 *
 * Data is fetched from `window.maestro.vibes.*` preload APIs which invoke
 * the vibescheck CLI under the hood.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import type { VibesAssuranceLevel, VibesAnnotation } from '../../shared/vibes-types';

// ============================================================================
// Helper Types — parsed CLI output shapes
// ============================================================================

/** Parsed coverage/stats data from `vibescheck stats --json`. */
export interface VibesStatsData {
	totalAnnotations: number;
	filesCovered: number;
	totalTrackedFiles: number;
	coveragePercent: number;
	activeSessions: number;
	contributingModels: number;
	assuranceLevel: VibesAssuranceLevel | null;
}

/** Summary info for a single VIBES session. */
export interface VibesSessionInfo {
	sessionId: string;
	startTime: string;
	endTime?: string;
	annotationCount: number;
	toolName?: string;
	modelName?: string;
}

/** Summary info for a contributing AI model. */
export interface VibesModelInfo {
	modelName: string;
	modelVersion?: string;
	toolName?: string;
	annotationCount: number;
	percentage: number;
}

// ============================================================================
// Return type
// ============================================================================

/** Return value of the useVibesData hook. */
export interface UseVibesDataReturn {
	/** Whether `.ai-audit/` exists for this project. */
	isInitialized: boolean;
	/** Parsed coverage statistics, null until loaded. */
	stats: VibesStatsData | null;
	/** Recent annotations (limited to last 100). */
	annotations: VibesAnnotation[];
	/** Session list for this project. */
	sessions: VibesSessionInfo[];
	/** Contributing model list for this project. */
	models: VibesModelInfo[];
	/** Whether data is currently being fetched. */
	isLoading: boolean;
	/** Error message if a fetch failed, null otherwise. */
	error: string | null;
	/** Manually trigger a data refresh. */
	refresh: () => void;
	/** Initialize `.ai-audit/` for the given project. */
	initialize: (projectName: string) => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

const REFRESH_INTERVAL_MS = 10_000;
const ANNOTATION_LIMIT = 100;

// ============================================================================
// Parsing helpers
// ============================================================================

function parseStats(raw: string | undefined): VibesStatsData | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw);
		return {
			totalAnnotations: data.total_annotations ?? data.totalAnnotations ?? 0,
			filesCovered: data.files_covered ?? data.filesCovered ?? 0,
			totalTrackedFiles: data.total_tracked_files ?? data.totalTrackedFiles ?? 0,
			coveragePercent: data.coverage_percent ?? data.coveragePercent ?? 0,
			activeSessions: data.active_sessions ?? data.activeSessions ?? 0,
			contributingModels: data.contributing_models ?? data.contributingModels ?? 0,
			assuranceLevel: data.assurance_level ?? data.assuranceLevel ?? null,
		};
	} catch {
		return null;
	}
}

function parseAnnotations(raw: string | undefined): VibesAnnotation[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		if (Array.isArray(data)) return data.slice(0, ANNOTATION_LIMIT);
		if (data.annotations && Array.isArray(data.annotations)) {
			return data.annotations.slice(0, ANNOTATION_LIMIT);
		}
		return [];
	} catch {
		return [];
	}
}

function parseSessions(raw: string | undefined): VibesSessionInfo[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		const list = Array.isArray(data) ? data : data.sessions ?? [];
		return list.map((s: Record<string, unknown>) => ({
			sessionId: (s.session_id ?? s.sessionId ?? '') as string,
			startTime: (s.start_time ?? s.startTime ?? s.timestamp ?? '') as string,
			endTime: (s.end_time ?? s.endTime ?? undefined) as string | undefined,
			annotationCount: (s.annotation_count ?? s.annotationCount ?? 0) as number,
			toolName: (s.tool_name ?? s.toolName ?? undefined) as string | undefined,
			modelName: (s.model_name ?? s.modelName ?? undefined) as string | undefined,
		}));
	} catch {
		return [];
	}
}

function parseModels(raw: string | undefined): VibesModelInfo[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		const list = Array.isArray(data) ? data : data.models ?? [];
		return list.map((m: Record<string, unknown>) => ({
			modelName: (m.model_name ?? m.modelName ?? 'Unknown') as string,
			modelVersion: (m.model_version ?? m.modelVersion ?? undefined) as string | undefined,
			toolName: (m.tool_name ?? m.toolName ?? undefined) as string | undefined,
			annotationCount: (m.annotation_count ?? m.annotationCount ?? 0) as number,
			percentage: (m.percentage ?? 0) as number,
		}));
	} catch {
		return [];
	}
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Provides reactive access to VIBES data for a project.
 *
 * @param projectPath - Absolute path to the project root. When undefined,
 *   the hook returns empty/default data and does not make any IPC calls.
 * @param enabled - Whether VIBES polling is active (typically tied to
 *   `vibesEnabled` from settings and the VIBES panel being visible).
 *
 * @example
 * ```tsx
 * const vibes = useVibesData(session?.cwd, vibesEnabled);
 * if (vibes.isLoading) return <Spinner />;
 * if (!vibes.isInitialized) return <InitPrompt onInit={vibes.initialize} />;
 * return <Dashboard stats={vibes.stats} />;
 * ```
 */
export function useVibesData(
	projectPath: string | undefined,
	enabled: boolean = true,
): UseVibesDataReturn {
	const [isInitialized, setIsInitialized] = useState(false);
	const [stats, setStats] = useState<VibesStatsData | null>(null);
	const [annotations, setAnnotations] = useState<VibesAnnotation[]>([]);
	const [sessions, setSessions] = useState<VibesSessionInfo[]>([]);
	const [models, setModels] = useState<VibesModelInfo[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const mountedRef = useRef(true);

	// Core data fetch — calls all VIBES IPC endpoints in parallel.
	const fetchData = useCallback(async () => {
		if (!projectPath || !enabled) return;

		setError(null);

		try {
			const [initResult, statsResult, logResult, sessionsResult, modelsResult] =
				await Promise.all([
					window.maestro.vibes.isInitialized(projectPath),
					window.maestro.vibes.getStats(projectPath),
					window.maestro.vibes.getLog(projectPath, { limit: ANNOTATION_LIMIT, json: true }),
					window.maestro.vibes.getSessions(projectPath),
					window.maestro.vibes.getModels(projectPath),
				]);

			if (!mountedRef.current) return;

			setIsInitialized(initResult);
			setStats(parseStats(statsResult.data));
			setAnnotations(parseAnnotations(logResult.data));
			setSessions(parseSessions(sessionsResult.data));
			setModels(parseModels(modelsResult.data));
		} catch (err) {
			console.error('useVibesData: fetch failed', err);
			if (mountedRef.current) {
				setError(err instanceof Error ? err.message : 'Failed to fetch VIBES data');
			}
		} finally {
			if (mountedRef.current) {
				setIsLoading(false);
			}
		}
	}, [projectPath, enabled]);

	// Manual refresh trigger.
	const refresh = useCallback(() => {
		setIsLoading(true);
		fetchData();
	}, [fetchData]);

	// Initialize `.ai-audit/` for a project.
	const initialize = useCallback(
		async (projectName: string) => {
			if (!projectPath) return;

			try {
				const result = await window.maestro.vibes.init(projectPath, {
					projectName,
					assuranceLevel: 'medium',
				});

				if (!result.success) {
					throw new Error(result.error ?? 'Initialization failed');
				}

				// Re-fetch everything after init.
				if (mountedRef.current) {
					setIsLoading(true);
					await fetchData();
				}
			} catch (err) {
				console.error('useVibesData: init failed', err);
				if (mountedRef.current) {
					setError(err instanceof Error ? err.message : 'Failed to initialize VIBES');
				}
			}
		},
		[projectPath, fetchData],
	);

	// Initial fetch and auto-refresh interval.
	useEffect(() => {
		mountedRef.current = true;

		if (!projectPath || !enabled) {
			setIsLoading(false);
			return;
		}

		// Initial fetch.
		fetchData();

		// Auto-refresh every 10 seconds.
		const intervalId = setInterval(() => {
			if (mountedRef.current) {
				fetchData();
			}
		}, REFRESH_INTERVAL_MS);

		return () => {
			mountedRef.current = false;
			clearInterval(intervalId);
		};
	}, [projectPath, enabled, fetchData]);

	// Reset state when projectPath changes.
	useEffect(() => {
		setIsInitialized(false);
		setStats(null);
		setAnnotations([]);
		setSessions([]);
		setModels([]);
		setIsLoading(true);
		setError(null);
	}, [projectPath]);

	return useMemo(
		() => ({
			isInitialized,
			stats,
			annotations,
			sessions,
			models,
			isLoading,
			error,
			refresh,
			initialize,
		}),
		[isInitialized, stats, annotations, sessions, models, isLoading, error, refresh, initialize],
	);
}
