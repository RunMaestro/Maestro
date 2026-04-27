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
import { flushSync } from 'react-dom';
import type {
	CuePipelineState,
	CuePipeline,
	AgentNodeData,
	PipelineNode,
} from '../../../shared/cue-pipeline-types';
import { graphSessionsToPipelines } from '../../components/CuePipelineEditor/utils/yamlToPipeline';
import { pipelinesToYaml } from '../../components/CuePipelineEditor/utils/pipelineToYaml';
import { validatePipelines } from '../../components/CuePipelineEditor/utils/pipelineValidation';
import { resolveNodeWriteRoot } from '../../components/CuePipelineEditor/utils/pipelineRoots';
import type { CueSettings } from '../../../shared/cue';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import { notifyToast } from '../../stores/notificationStore';
import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';
import { computeCommonAncestorPath, isDescendantOrEqual } from '../../../shared/cue-path-utils';
import { flushAllPendingEdits } from './pendingEditsRegistry';
import { cueDebugLog } from '../../../shared/cueDebug';

const SAVE_SUCCESS_IDLE_DELAY_MS = 2000;
const SAVE_ERROR_IDLE_DELAY_MS = 3000;

export type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

export interface UsePipelinePersistenceParams {
	state: {
		pipelineState: CuePipelineState;
		/**
		 * Live mirror of pipelineState.pipelines updated during render by the
		 * composition hook. handleSave reads through this ref AFTER yielding
		 * to the microtask queue so it observes setState writes produced by
		 * `flushAllPendingEdits()` — which are batched and invisible in a
		 * closure-captured `pipelineState.pipelines`.
		 */
		pipelinesRef: React.MutableRefObject<CuePipelineState['pipelines']>;
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
	const { pipelinesRef, savedStateRef, lastWrittenRootsRef } = state;
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

		// Flush pending debounced prompt edits from the config panels so the
		// save reads up-to-date state. Clicking Save within the 300ms debounce
		// window used to persist stale (often empty) prompts, which produced
		// YAML that failed validation on next load — the user saw their
		// pipeline "vanish" after a tab switch, plus a "make sure each agent
		// has a prompt" error on the manual Play button. Wrapping the flush
		// in `flushSync` forces React to process the setState writes produced
		// by each panel's debounced callback synchronously, so the composition
		// hook's render-time `pipelinesRef.current = …` assignment has run by
		// the time we read it on the next line.
		flushSync(() => {
			flushAllPendingEdits();
		});
		const currentPipelines = pipelinesRef.current;

		cueDebugLog('save:intent', {
			pipelineCount: currentPipelines.length,
			pipelines: currentPipelines.map((p) => ({
				name: p.name,
				nodes: p.nodes.map((n) => {
					if (n.type === 'agent') {
						const a = n.data as AgentNodeData;
						return {
							type: 'agent',
							sessionId: a.sessionId,
							sessionName: a.sessionName,
						};
					}
					return { type: n.type, id: n.id };
				}),
				edges: p.edges.map((e) => ({ from: e.source, to: e.target })),
			})),
			sessionsAvailable: sessions.map((s) => ({
				id: s.id,
				name: s.name,
				projectRoot: s.projectRoot,
			})),
		});

		// Filter out pipelines with unresolved-agent error nodes rather than
		// aborting the entire save. Error nodes are emitted by yamlToPipeline when
		// `agent_id` / `source_session_ids` reference deleted sessions; we must not
		// write them to YAML (the heuristic fallback would silently pick a wrong
		// agent). But blocking the whole save was wrong: other valid changes —
		// including deletions of unrelated pipelines — were silently discarded,
		// making it impossible to clean up a workspace without first fixing every
		// error pipeline.
		const pipelinesWithErrors = currentPipelines.filter((p) =>
			p.nodes.some((n) => n.type === 'error')
		);
		const validPipelines =
			pipelinesWithErrors.length > 0
				? currentPipelines.filter((p) => !p.nodes.some((n) => n.type === 'error'))
				: currentPipelines;

		if (pipelinesWithErrors.length > 0) {
			// Clear any stale validation errors so the banner doesn't keep showing
			// rules the user has already fixed while the skip-warning is active.
			setValidationErrors([]);
			notifyToast({
				type: 'warning',
				title: 'Some pipelines skipped',
				message: `Pipeline${pipelinesWithErrors.length > 1 ? 's' : ''} ${pipelinesWithErrors
					.map((p) => `"${p.name}"`)
					.join(
						', '
					)} contain${pipelinesWithErrors.length > 1 ? '' : 's'} unresolved agents and ${pipelinesWithErrors.length > 1 ? 'were' : 'was'} skipped. Other changes were saved.`,
			});
		}

		// Validate graph shape first
		const errors = validatePipelines(validPipelines);

		// Build session lookup maps. Prefer sessionId since agents can be
		// renamed, but fall back to sessionName for pipelines loaded from older
		// YAML that referenced agents purely by name.
		const sessionsById = new Map<string, SessionInfo>();
		const sessionsByName = new Map<string, SessionInfo>();
		for (const s of sessions) {
			sessionsById.set(s.id, s);
			if (!sessionsByName.has(s.name)) sessionsByName.set(s.name, s);
		}

		const resolveNodeRoot = (node: PipelineNode): { root: string | null; hasBinding: boolean } =>
			resolveNodeWriteRoot(node, sessionsById, sessionsByName);

		// Partition pipelines by project root. A pipeline must live in exactly
		// one root — cross-root pipelines are rejected so each .maestro/cue.yaml
		// remains the sole owner of its pipelines (prevents the historical
		// mirroring / deleted-pipeline-reappears class of bugs).
		const pipelinesByRoot = new Map<string, CuePipeline[]>();
		const unresolvedPipelines: string[] = [];

		for (const pipeline of validPipelines) {
			// Both agent and command nodes contribute a project root via their
			// bound session (commands inherit cwd + agent_id from their owning
			// session). Treat them uniformly so command-only pipelines aren't
			// silently dropped from the save — that bug made user-created
			// pipelines like "Cyber Stocks" (trigger + shell commands, no agent)
			// vanish on every save.
			const bindings = pipeline.nodes.filter((n) => n.type === 'agent' || n.type === 'command');
			if (bindings.length === 0) continue; // validatePipelines already flagged this

			const roots = new Set<string>();
			let missingRoot = false;
			let sawBinding = false;
			for (const node of bindings) {
				const { root, hasBinding } = resolveNodeRoot(node);
				if (!hasBinding) continue;
				sawBinding = true;
				if (!root) {
					missingRoot = true;
					continue;
				}
				roots.add(root);
			}

			if (!sawBinding) continue; // pipeline had only unbound nodes

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
						`"${pipeline.name}": nodes span unrelated project roots (${[...roots].join(', ')}) — a Cue pipeline must live in a single project.`
					);
					continue;
				}
				// Collapse to the common ancestor root for YAML output.
				roots.clear();
				roots.add(commonRoot);
			}
			if (missingRoot) {
				errors.push(
					`"${pipeline.name}": one or more agents/commands have no resolvable project root — assign a working directory to the bound session(s).`
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
				`No project root found for pipeline(s): ${unresolvedPipelines.join(', ')} — agents/commands need a working directory.`
			);
		}

		// Compute roots that are still referenced by error-node pipelines. These
		// roots must NOT be deleted during orphaned-root cleanup — the pipeline
		// still exists in the editor; it just can't be written until the user
		// fixes the unresolved agent references.
		const errorPipelineRoots = new Set<string>();
		for (const p of pipelinesWithErrors) {
			for (const node of p.nodes) {
				const { root, hasBinding } = resolveNodeRoot(node);
				if (hasBinding && root) errorPipelineRoots.add(root);
			}
		}

		// Safety net: if the editor has pipelines but nothing will be written and
		// no previously-saved root needs clearing, the save would silently succeed
		// with no effect. Surface that rather than masking it as "Saved".
		if (validPipelines.length > 0 && pipelinesByRoot.size === 0 && errors.length === 0) {
			errors.push(
				'Nothing to save — pipelines are empty. Add a trigger and an agent, then try again.'
			);
		}

		cueDebugLog('save:partition', {
			byRoot: Object.fromEntries(
				[...pipelinesByRoot.entries()].map(([root, pipes]) => [root, pipes.map((p) => p.name)])
			),
			unresolvedPipelines,
			errorPipelines: pipelinesWithErrors.map((p) => p.name),
			validationErrors: errors,
		});

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
			// Skip roots that are also referenced by error-node pipelines: those
			// pipelines exist on disk with valid YAML that we cannot reproduce
			// without their missing agents. Writing the root here would silently
			// strip those pipelines from disk (data loss).
			for (const root of currentRoots) {
				if (errorPipelineRoots.has(root)) continue;
				const rootPipelines = pipelinesByRoot.get(root)!;
				const { yaml: yamlContent, promptFiles } = pipelinesToYaml(rootPipelines, cueSettings);
				const promptFilesObj: Record<string, string> = {};
				for (const [filePath, content] of promptFiles) {
					promptFilesObj[filePath] = content;
				}
				cueDebugLog('save:writeYaml:request', {
					root,
					yamlBytes: yamlContent.length,
					promptFileCount: Object.keys(promptFilesObj).length,
					promptFileKeys: Object.keys(promptFilesObj),
					yaml: yamlContent,
				});
				await cueService.writeYaml(root, yamlContent, promptFilesObj);

				// Write-back verification: read the YAML we just wrote and
				// confirm our content is on disk. Guards against any silent
				// IPC failure path — if disk doesn't match memory, we throw
				// so the user sees an error instead of a fake "Saved".
				const onDisk = await cueService.readYaml(root);
				cueDebugLog('save:writeYaml:verify', {
					root,
					match: onDisk === yamlContent,
					diskBytes: onDisk?.length ?? null,
					expectedBytes: yamlContent.length,
				});
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

			// Delete cue.yaml (and clean up prompts + .maestro/) for any root
			// whose last pipeline was removed this save. Deleting the file is
			// the correct behaviour — writing an empty YAML left a stale
			// .maestro/cue.yaml on disk that confused users and the engine.
			for (const root of previousRoots) {
				if (currentRoots.has(root)) continue;
				// Don't delete roots still referenced by error-node pipelines — the
				// pipeline exists in the editor and will be writable once the user
				// fixes the unresolved agent references.
				if (errorPipelineRoots.has(root)) continue;
				await cueService.deleteYaml(root);
				// Verify the file is gone so a silent IPC failure surfaces as an
				// error instead of a ghost pipeline reappearing on next launch.
				const onDisk = await cueService.readYaml(root);
				if (onDisk !== null) {
					throw new Error(
						`deleteYaml of "${root}" did not remove the file — cue.yaml still present on disk`
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
					cueDebugLog('save:refreshSession', {
						sessionId: session.id,
						sessionName: session.name,
						projectRoot: session.projectRoot,
					});
					await cueService.refreshSession(session.id, session.projectRoot);
				}
			}

			// Refs MUST update before setIsDirty(false) — the dirty-tracking
			// effect compares against savedStateRef.current, so flipping dirty
			// false before the ref is fresh would immediately flip it back true.
			savedStateRef.current = JSON.stringify(validPipelines);
			// Preserve error-pipeline roots alongside current roots so the NEXT
			// save's previousRoots still covers them. Without this, deleting an
			// error-node pipeline after a partial save orphans its YAML: the root
			// drops out of previousRoots and the cleanup loop never deletes it.
			lastWrittenRootsRef.current = new Set([...currentRoots, ...errorPipelineRoots]);
			setIsDirty(false);

			// Nothing was written and nothing was cleared — happens when all
			// pipelines have error nodes and there are no previous roots to clean
			// up. Avoid a misleading "Saved 0 pipelines to 0 projects" toast.
			if (totalPipelinesWritten === 0 && rootsCleared === 0) {
				setSaveStatus('idle');
				return;
			}

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
			cueDebugLog('save:error', {
				message: err instanceof Error ? err.message : String(err),
			});
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
		pipelinesRef,
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
			// Both agent and command nodes contribute roots — see handleSave's
			// partitioning loop for the full rationale.
			const sessionsById = new Map(sessions.map((s) => [s.id, s]));
			const sessionsByName = new Map(sessions.map((s) => [s.name, s]));
			const restoredRoots = new Set<string>();
			for (const pipeline of restoredPipelines) {
				for (const node of pipeline.nodes) {
					const { root, hasBinding } = resolveNodeWriteRoot(node, sessionsById, sessionsByName);
					if (hasBinding && root) restoredRoots.add(root);
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
