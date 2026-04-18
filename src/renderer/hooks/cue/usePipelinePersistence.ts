/**
 * usePipelinePersistence — Save / discard / validation lifecycle for the pipeline editor.
 *
 * Owns handleSave (partition by project root, write YAML with read-back
 * verification, clear orphaned roots, refresh engine sessions, toast) and
 * handleDiscard (reload from disk, reset dirty state). saveStatus and
 * validationErrors live here too.
 *
 * Shared refs (savedStateRef, lastWrittenRootsRef) are OWNED by the composition
 * hook (usePipelineState) and passed in here — they are also read/written by
 * usePipelineLayout during initial restore, so a single owner must hold them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	CuePipelineState,
	CuePipeline,
	AgentNodeData,
} from '../../../shared/cue-pipeline-types';
import { graphSessionsToPipelines } from '../../components/CuePipelineEditor/utils/yamlToPipeline';
import { pipelinesToYaml } from '../../components/CuePipelineEditor/utils/pipelineToYaml';
import { validatePipelines } from '../../components/CuePipelineEditor/utils/pipelineValidation';
import type { CueSettings } from '../../../shared/cue';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import { notifyToast } from '../../stores/notificationStore';
import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';
import { computeCommonAncestorPath, isDescendantOrEqual } from '../../../shared/cue-path-utils';

const SAVE_SUCCESS_IDLE_DELAY_MS = 2000;
const SAVE_ERROR_IDLE_DELAY_MS = 3000;

export type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

export interface UsePipelinePersistenceParams {
	state: {
		pipelineState: CuePipelineState;
		savedStateRef: React.MutableRefObject<string>;
		lastWrittenRootsRef: React.MutableRefObject<Set<string>>;
	};
	deps: {
		sessions: SessionInfo[];
		cueSettings: CueSettings;
		/** Gates handleSave until the async settings fetch has resolved (Fix #1). */
		settingsLoaded: boolean;
	};
	actions: {
		setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
		setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
		persistLayout: () => void;
		/** Optional callback fired after a successful save — used by CueModal
		 *  to refresh graph data so the dashboard reflects post-save state. */
		onSaveSuccess?: () => void;
	};
}

export interface UsePipelinePersistenceReturn {
	saveStatus: SaveStatus;
	validationErrors: string[];
	setValidationErrors: React.Dispatch<React.SetStateAction<string[]>>;
	handleSave: () => Promise<void>;
	handleDiscard: () => Promise<void>;
}

export function usePipelinePersistence({
	state,
	deps,
	actions,
}: UsePipelinePersistenceParams): UsePipelinePersistenceReturn {
	const { pipelineState, savedStateRef, lastWrittenRootsRef } = state;
	const { sessions, cueSettings, settingsLoaded } = deps;
	const { setPipelineState, setIsDirty, persistLayout, onSaveSuccess } = actions;

	const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);

	// Fix #2: single ref for the save-status idle timer. Cleared before each
	// re-schedule and on unmount so the modal closing mid-timer never triggers
	// a setState-on-unmounted warning.
	const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scheduleIdle = useCallback((delayMs: number) => {
		if (savedStatusTimerRef.current !== null) {
			clearTimeout(savedStatusTimerRef.current);
		}
		savedStatusTimerRef.current = setTimeout(() => {
			savedStatusTimerRef.current = null;
			setSaveStatus('idle');
		}, delayMs);
	}, []);

	useEffect(() => {
		return () => {
			if (savedStatusTimerRef.current !== null) {
				clearTimeout(savedStatusTimerRef.current);
				savedStatusTimerRef.current = null;
			}
		};
	}, []);

	const handleSave = useCallback(async () => {
		// Fix #1: block save until Cue settings have loaded. Prevents writing
		// YAML with default settings in the race window between modal mount and
		// IPC resolve (~ms usually, but throttled networks or slow IPC can
		// widen it enough for a user Cmd+S to slip through).
		if (!settingsLoaded) {
			notifyToast({
				type: 'warning',
				title: 'Cue settings still loading',
				message: 'Settings have not finished loading — try again in a moment.',
			});
			return;
		}

		// Block save when any pipeline contains an unresolved-agent error node.
		// These are emitted by yamlToPipeline when `agent_id` / `source_session_ids`
		// reference deleted sessions. Persisting a pipeline in that state would
		// let the heuristic fallback silently pick a wrong agent (the "two
		// agents swapped" failure mode). Surface a toast and refuse to write.
		const pipelinesWithErrors = pipelineState.pipelines.filter((p) =>
			p.nodes.some((n) => n.type === 'error')
		);
		if (pipelinesWithErrors.length > 0) {
			// Clear any stale validation errors from a previous save attempt so
			// the banner doesn't keep showing rules the user has already fixed
			// while the unresolved-agent toast is the actionable blocker.
			setValidationErrors([]);
			notifyToast({
				type: 'warning',
				title: 'Resolve unresolved agents before saving',
				message: `Pipeline${pipelinesWithErrors.length > 1 ? 's' : ''} ${pipelinesWithErrors
					.map((p) => `"${p.name}"`)
					.join(
						', '
					)} contain${pipelinesWithErrors.length > 1 ? '' : 's'} an unresolved agent reference. Reassign or remove the affected subscription and try again.`,
			});
			return;
		}

		// Validate graph shape first
		const errors = validatePipelines(pipelineState.pipelines);

		// Build session lookup maps. Prefer sessionId since agents can be
		// renamed, but fall back to sessionName for pipelines loaded from older
		// YAML that referenced agents purely by name.
		const sessionsById = new Map<string, SessionInfo>();
		const sessionsByName = new Map<string, SessionInfo>();
		for (const s of sessions) {
			sessionsById.set(s.id, s);
			if (!sessionsByName.has(s.name)) sessionsByName.set(s.name, s);
		}

		const resolveRoot = (agent: AgentNodeData): string | null => {
			const byId = sessionsById.get(agent.sessionId);
			if (byId?.projectRoot) return byId.projectRoot;
			const byName = sessionsByName.get(agent.sessionName);
			if (byName?.projectRoot) return byName.projectRoot;
			return null;
		};

		// Partition pipelines by project root. A pipeline must live in exactly
		// one root — cross-root pipelines are rejected so each .maestro/cue.yaml
		// remains the sole owner of its pipelines (prevents the historical
		// mirroring / deleted-pipeline-reappears class of bugs).
		const pipelinesByRoot = new Map<string, CuePipeline[]>();
		const unresolvedPipelines: string[] = [];

		for (const pipeline of pipelineState.pipelines) {
			const agents = pipeline.nodes.filter((n) => n.type === 'agent');
			if (agents.length === 0) continue; // validatePipelines already flagged this

			const roots = new Set<string>();
			let missingRoot = false;
			for (const agent of agents) {
				const root = resolveRoot(agent.data as AgentNodeData);
				if (!root) {
					missingRoot = true;
					continue;
				}
				roots.add(root);
			}

			if (roots.size === 0) {
				unresolvedPipelines.push(pipeline.name);
				continue;
			}
			if (roots.size > 1) {
				// When all roots are subdirectories of a common ancestor, the
				// pipeline can live at that ancestor's .maestro/cue.yaml. This
				// enables cross-directory pipelines (e.g. project/ + project/Digest)
				// while preserving the single-owner invariant.
				const commonRoot = computeCommonAncestorPath([...roots]);
				const allDescendants =
					commonRoot !== null && [...roots].every((r) => isDescendantOrEqual(r, commonRoot));
				if (!allDescendants) {
					errors.push(
						`"${pipeline.name}": agents span unrelated project roots (${[...roots].join(', ')}) — a Cue pipeline must live in a single project.`
					);
					continue;
				}
				// Collapse to the common ancestor root for YAML output.
				roots.clear();
				roots.add(commonRoot);
			}
			if (missingRoot) {
				errors.push(
					`"${pipeline.name}": one or more agents have no resolvable project root — assign a working directory to the agent(s).`
				);
				continue;
			}

			const root = [...roots][0];
			const existing = pipelinesByRoot.get(root) ?? [];
			existing.push(pipeline);
			pipelinesByRoot.set(root, existing);
		}

		if (unresolvedPipelines.length > 0) {
			errors.push(
				`No project root found for pipeline(s): ${unresolvedPipelines.join(', ')} — agents need a working directory.`
			);
		}

		// Safety net: if the editor has pipelines but nothing will be written and
		// no previously-saved root needs clearing, the save would silently succeed
		// with no effect. Surface that rather than masking it as "Saved".
		if (pipelineState.pipelines.length > 0 && pipelinesByRoot.size === 0 && errors.length === 0) {
			errors.push(
				'Nothing to save — pipelines are empty. Add a trigger and an agent, then try again.'
			);
		}

		setValidationErrors(errors);
		if (errors.length > 0) return;

		// Use the project roots written by the previous successful save (or
		// seeded from the initial load). Re-deriving roots from savedStateRef
		// at save time fails when an agent has been renamed or removed since
		// the previous save — its sessionId/Name no longer resolves to a
		// projectRoot, so the stale YAML at that root would never be cleared.
		const previousRoots = new Set(lastWrittenRootsRef.current);

		setSaveStatus('saving');
		try {
			const currentRoots = new Set(pipelinesByRoot.keys());
			const touchedRoots = new Set<string>([...currentRoots, ...previousRoots]);
			let totalPipelinesWritten = 0;
			let rootsCleared = 0;

			// Write each root's YAML with only that root's pipelines.
			for (const root of currentRoots) {
				const rootPipelines = pipelinesByRoot.get(root)!;
				const { yaml: yamlContent, promptFiles } = pipelinesToYaml(rootPipelines, cueSettings);
				const promptFilesObj: Record<string, string> = {};
				for (const [filePath, content] of promptFiles) {
					promptFilesObj[filePath] = content;
				}
				await cueService.writeYaml(root, yamlContent, promptFilesObj);

				// Write-back verification: read the YAML we just wrote and
				// confirm our content is on disk. Guards against any silent
				// IPC failure path — if disk doesn't match memory, we throw
				// so the user sees an error instead of a fake "Saved".
				const onDisk = await cueService.readYaml(root);
				if (onDisk === null) {
					throw new Error(`writeYaml to "${root}" did not persist: no file on disk`);
				}
				if (onDisk !== yamlContent) {
					throw new Error(
						`writeYaml to "${root}" did not persist the expected content (${onDisk.length} bytes on disk vs ${yamlContent.length} expected)`
					);
				}
				totalPipelinesWritten += rootPipelines.length;
			}

			// Clear any root whose pipelines were all removed this save. Use the
			// same write-and-verify path as non-empty writes so an empty YAML
			// clear can never be a silent no-op (the user would see the deleted
			// pipeline reappear on next launch).
			for (const root of previousRoots) {
				if (currentRoots.has(root)) continue;
				const { yaml: emptyYaml } = pipelinesToYaml([], cueSettings);
				await cueService.writeYaml(root, emptyYaml, {});
				const onDisk = await cueService.readYaml(root);
				if (onDisk === null) {
					throw new Error(`writeYaml clear of "${root}" did not persist: no file on disk`);
				}
				if (onDisk !== emptyYaml) {
					throw new Error(
						`writeYaml clear of "${root}" did not persist the expected content (${onDisk.length} bytes on disk vs ${emptyYaml.length} expected)`
					);
				}
				rootsCleared++;
			}

			// Refresh every session whose project root was touched — or is a
			// descendant of a touched root — so the engine reloads the freshly
			// written YAML. Descendant sessions need refreshing because they
			// inherit their config from the ancestor root via fallback.
			for (const session of sessions) {
				if (!session.projectRoot) continue;
				const needsRefresh =
					touchedRoots.has(session.projectRoot) ||
					[...touchedRoots].some((root) => isDescendantOrEqual(session.projectRoot!, root));
				if (needsRefresh) {
					await cueService.refreshSession(session.id, session.projectRoot);
				}
			}

			// Refs MUST update before setIsDirty(false) — the dirty-tracking
			// effect compares against savedStateRef.current, so flipping dirty
			// false before the ref is fresh would immediately flip it back true.
			savedStateRef.current = JSON.stringify(pipelineState.pipelines);
			lastWrittenRootsRef.current = new Set(currentRoots);
			setIsDirty(false);
			setSaveStatus('success');
			persistLayout();
			// Fix #3: notify parent (CueModal) so graph data can refresh.
			onSaveSuccess?.();
			scheduleIdle(SAVE_SUCCESS_IDLE_DELAY_MS);

			// Explicit confirmation so the user cannot miss the brief in-button
			// status flash — "didn't save" used to happen when the 2-second
			// success indicator was blinked past without the user noticing.
			const rootLabel = currentRoots.size === 1 ? 'project' : 'projects';
			const pipelineLabel = totalPipelinesWritten === 1 ? 'pipeline' : 'pipelines';
			const clearedSuffix =
				rootsCleared > 0
					? ` (cleared ${rootsCleared} empty ${rootsCleared === 1 ? 'project' : 'projects'})`
					: '';
			notifyToast({
				type: 'success',
				title: 'Cue pipelines saved',
				message: `Saved ${totalPipelinesWritten} ${pipelineLabel} to ${currentRoots.size} ${rootLabel}${clearedSuffix}.`,
			});
		} catch (err: unknown) {
			captureException(err, { extra: { operation: 'cue.pipelineSave' } });
			setSaveStatus('error');
			scheduleIdle(SAVE_ERROR_IDLE_DELAY_MS);
			// Keep isDirty = true so the user knows their changes are still
			// unsaved (do NOT update savedStateRef on failure).
			const message = err instanceof Error ? err.message : String(err);
			notifyToast({
				type: 'error',
				title: 'Cue save failed',
				message: `Your changes were NOT saved. ${message}`,
			});
		}
	}, [
		pipelineState.pipelines,
		sessions,
		cueSettings,
		settingsLoaded,
		persistLayout,
		savedStateRef,
		lastWrittenRootsRef,
		setIsDirty,
		onSaveSuccess,
		scheduleIdle,
	]);

	const handleDiscard = useCallback(async () => {
		try {
			const data = await cueService.getGraphData();
			let restoredPipelines: CuePipeline[] = [];
			if (data && data.length > 0) {
				restoredPipelines = graphSessionsToPipelines(data, sessions);
				setPipelineState({
					pipelines: restoredPipelines,
					selectedPipelineId: restoredPipelines.length > 0 ? restoredPipelines[0].id : null,
				});
				savedStateRef.current = JSON.stringify(restoredPipelines);
			} else {
				setPipelineState({ pipelines: [], selectedPipelineId: null });
				savedStateRef.current = '[]';
			}
			// Re-derive the written-roots set from what was just loaded so the
			// next save knows which roots to clear if pipelines disappear again.
			const sessionsById = new Map(sessions.map((s) => [s.id, s]));
			const sessionsByName = new Map(sessions.map((s) => [s.name, s]));
			const restoredRoots = new Set<string>();
			for (const pipeline of restoredPipelines) {
				for (const node of pipeline.nodes) {
					if (node.type !== 'agent') continue;
					const agentData = node.data as AgentNodeData;
					const root =
						sessionsById.get(agentData.sessionId)?.projectRoot ??
						sessionsByName.get(agentData.sessionName)?.projectRoot;
					if (root) restoredRoots.add(root);
				}
			}
			lastWrittenRootsRef.current = restoredRoots;
			setIsDirty(false);
			setValidationErrors([]);
		} catch (err: unknown) {
			captureException(err, { extra: { operation: 'cue.pipelineDiscard' } });
		}
	}, [sessions, setPipelineState, setIsDirty, savedStateRef, lastWrittenRootsRef]);

	return {
		saveStatus,
		validationErrors,
		setValidationErrors,
		handleSave,
		handleDiscard,
	};
}
