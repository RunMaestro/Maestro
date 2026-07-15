/**
 * usePipelinePersistence - Save / discard / validation lifecycle for the pipeline editor.
 *
 * Owns handleSave (partition by project root, write YAML with read-back
 * verification, clear orphaned roots, refresh engine sessions, toast) and
 * handleDiscard (reload from disk, reset dirty state). saveStatus and
 * validationErrors live here too.
 *
 * Shared refs (savedStateRef, lastWrittenRootsRef) are OWNED by the composition
 * hook (usePipelineState) and passed in here - they are also read/written by
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
import {
	pipelinesToYamlByOwnerCwd,
	readOwnerAgentIdFromYaml,
} from '../../components/CuePipelineEditor/utils/pipelineToYaml';
import { validatePipelines } from '../../components/CuePipelineEditor/utils/pipelineValidation';
import {
	resolveNodeWriteRoot,
	resolvePipelineOwnerCwds,
} from '../../components/CuePipelineEditor/utils/pipelineRoots';
import type { CueSettings } from '../../../shared/cue';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import { notifyToast } from '../../stores/notificationStore';
import type { CuePipelineSessionInfo as SessionInfo } from '../../../shared/cue-pipeline-types';
import { flushAllPendingEdits } from './pendingEditsRegistry';
import { cueDebugLog } from '../../../shared/cueDebug';
import { useCueDirtyStore } from '../../stores/cueDirtyStore';

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
		 * `flushAllPendingEdits()` - which are batched and invisible in a
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
		/** Optional callback fired after a successful save - used by CueModal
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
				message: 'Settings have not finished loading - try again in a moment.',
			});
			return;
		}

		// Flush pending debounced prompt edits from the config panels so the
		// save reads up-to-date state. Clicking Save within the 300ms debounce
		// window used to persist stale (often empty) prompts, which produced
		// YAML that failed validation on next load - the user saw their
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
		// agent). But blocking the whole save was wrong: other valid changes -
		// including deletions of unrelated pipelines - were silently discarded,
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

		// Per-agent-cwd partitioning: each pipeline writes to one yaml per
		// participating agent's project root. A pipeline that fails to
		// resolve all of its agent bindings is a per-pipeline validation
		// error rather than silently dropping subs. This replaces the
		// historical "collapse multi-root pipelines onto a common ancestor"
		// behavior, which silently produced misplaced cue.yaml files at
		// shared parent dirs (~/Projects, ~) instead of in each agent's cwd.
		const ownerCwdsByPipeline = new Map<string, Set<string>>();
		const writablePipelines: CuePipeline[] = [];

		for (const pipeline of validPipelines) {
			const result = resolvePipelineOwnerCwds(pipeline, sessionsById, sessionsByName);
			if (!result.ok) {
				if (result.reason === 'unresolved') {
					errors.push(
						`"${pipeline.name}": one or more agents/commands have no resolvable project root - assign a working directory to the bound session(s) or remove the dangling reference.`
					);
				}
				// 'no-bindings' pipelines are caught by validatePipelines elsewhere.
				continue;
			}
			ownerCwdsByPipeline.set(pipeline.name, result.cwds);
			writablePipelines.push(pipeline);
		}

		// Union of every owner cwd across every writable pipeline - the set
		// of yaml files we'll touch on this save.
		const currentRoots = new Set<string>();
		for (const cwds of ownerCwdsByPipeline.values()) {
			for (const cwd of cwds) currentRoots.add(cwd);
		}

		// Compute roots that are still referenced by error-node pipelines. These
		// roots must NOT be deleted during orphaned-root cleanup - the pipeline
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
		if (validPipelines.length > 0 && currentRoots.size === 0 && errors.length === 0) {
			errors.push(
				'Nothing to save - pipelines are empty. Add a trigger and an agent, then try again.'
			);
		}

		cueDebugLog('save:partition', {
			ownerCwdsByPipeline: Object.fromEntries(
				[...ownerCwdsByPipeline.entries()].map(([name, cwds]) => [name, [...cwds]])
			),
			currentRoots: [...currentRoots],
			errorPipelines: pipelinesWithErrors.map((p) => p.name),
			validationErrors: errors,
		});

		setValidationErrors(errors);
		if (errors.length > 0) return;

		// Use the project roots written by the previous successful save (or
		// seeded from the initial load). Re-deriving roots from savedStateRef
		// at save time fails when an agent has been renamed or removed since
		// the previous save - its sessionId/Name no longer resolves to a
		// projectRoot, so the stale YAML at that root would never be cleared.
		const previousRoots = new Set(lastWrittenRootsRef.current);

		setSaveStatus('saving');
		// Publish "saving" to the shared dirty store so the modal's close handler
		// can let the user dismiss CueModal mid-save (the save promise continues
		// in the background and toasts on completion).
		useCueDirtyStore.getState().setPipelineSaving(true);
		try {
			const touchedRoots = new Set<string>([...currentRoots, ...previousRoots]);
			let rootsCleared = 0;
			// Roots whose on-disk content actually changed this save. Only these
			// get a session refresh - a layout-only save (nodes moved, identical
			// YAML/prompts) leaves this empty, so the engine never re-arms triggers
			// and the pipeline does NOT re-execute. writeYaml reports per-root
			// `changed`; cleared (deleted) roots are added below.
			const changedRoots = new Set<string>();

			// Convert all writable pipelines to per-cwd yaml in one shot. Each
			// subscription record carries `agent_id` (set by the records
			// emitter); the splitter looks each id up in `sessionsById` and
			// groups records by the owner's projectRoot.
			const sessionsByIdForEmit = new Map<string, { projectRoot?: string }>();
			for (const [id, s] of sessionsById) {
				sessionsByIdForEmit.set(id, { projectRoot: s.projectRoot });
			}
			// Mirror resolveNodeWriteRoot's id→name fallback so a node bound by
			// name only (empty/stale sessionId on a legacy pipeline) still emits
			// a live agent_id instead of failing the save with <missing>. The
			// validation gate above already accepts these nodes by name; without
			// this the emitter would reject them - the exact asymmetry behind the
			// "Unresolvable agent_id" save failure.
			const resolveOwnerId = (
				id: string | undefined,
				name: string | undefined
			): string | undefined => {
				if (id && sessionsById.has(id)) return id;
				if (name) {
					const byName = sessionsByName.get(name);
					if (byName) return byName.id;
				}
				return id;
			};
			// Preserve each target root's existing per-root owner_agent_id. The
			// editor doesn't manage ownership (it's set via Edit YAML for shared
			// roots), and the global cueSettings intentionally no longer carries
			// owner_agent_id - so without re-reading it here a full-overwrite save
			// would drop a shared root's owner and revert it to fragile
			// "first agent wins" ownership.
			const ownerAgentIdByCwd = new Map<string, string>();
			await Promise.all(
				[...currentRoots].map(async (cwd) => {
					const existing = await cueService.readYaml(cwd);
					if (!existing) return;
					const owner = readOwnerAgentIdFromYaml(existing);
					if (owner) ownerAgentIdByCwd.set(cwd, owner);
				})
			);
			// Defensively strip owner_agent_id from the GLOBAL settings before
			// emit. owner_agent_id is per-root (preserved via ownerAgentIdByCwd
			// above); it must never ride along in the global block. An older main
			// process whose getSettings() still leaks the first session's
			// owner_agent_id would otherwise re-stamp it into every cwd on save -
			// the exact mechanism that poisoned every project's cue.yaml. This
			// keeps the renderer correct regardless of the main-process version.
			const { owner_agent_id: _droppedGlobalOwner, ...globalSettingsForEmit } = cueSettings;
			const { byCwd, unresolved } = pipelinesToYamlByOwnerCwd(
				writablePipelines,
				globalSettingsForEmit,
				sessionsByIdForEmit,
				resolveOwnerId,
				ownerAgentIdByCwd
			);
			if (unresolved.length > 0) {
				// Defense-in-depth: validation above should have caught these.
				// Surface the specific subs so the failure is debuggable.
				throw new Error(
					`Unresolvable agent_id on ${unresolved.length} subscription(s): ${unresolved
						.map((u) => `"${u.subName}" (agent_id=${u.agentId || '<missing>'})`)
						.join(', ')}`
				);
			}

			// Write each cwd's yaml in parallel. Skip cwds also referenced by
			// error-node pipelines: those pipelines exist on disk with valid YAML
			// that we cannot reproduce without their missing agents. Writing the
			// cwd here would silently strip those pipelines from disk (data loss).
			// Each entry targets a distinct root, so the writes/read-backs are
			// independent; dispatching them together removes the per-root IPC
			// round-trip latency from stacking serially.
			await Promise.all(
				[...byCwd].map(async ([cwd, { yaml: yamlContent, promptFiles }]) => {
					if (errorPipelineRoots.has(cwd)) return;
					const promptFilesObj: Record<string, string> = {};
					for (const [filePath, content] of promptFiles) {
						promptFilesObj[filePath] = content;
					}
					cueDebugLog('save:writeYaml:request', {
						root: cwd,
						yamlBytes: yamlContent.length,
						promptFileCount: Object.keys(promptFilesObj).length,
						promptFileKeys: Object.keys(promptFilesObj),
						yaml: yamlContent,
					});
					const writeResult = await cueService.writeYaml(cwd, yamlContent, promptFilesObj);
					if (writeResult?.changed) changedRoots.add(cwd);

					// Write-back verification: read the YAML we just wrote and
					// confirm our content is on disk. Guards against any silent
					// IPC failure path - if disk doesn't match memory, we throw
					// so the user sees an error instead of a fake "Saved".
					const onDisk = await cueService.readYaml(cwd);
					cueDebugLog('save:writeYaml:verify', {
						root: cwd,
						match: onDisk === yamlContent,
						diskBytes: onDisk?.length ?? null,
						expectedBytes: yamlContent.length,
					});
					if (onDisk === null) {
						throw new Error(`writeYaml to "${cwd}" did not persist: no file on disk`);
					}
					if (onDisk !== yamlContent) {
						throw new Error(
							`writeYaml to "${cwd}" did not persist the expected content (${onDisk.length} bytes on disk vs ${yamlContent.length} expected)`
						);
					}
				})
			);

			// Pipeline write count for the success toast. A pipeline counts as
			// "written" if at least one of its owner cwds wasn't skipped due to
			// an error-pipeline collision.
			const totalPipelinesWritten = writablePipelines.filter((p) => {
				const cwds = ownerCwdsByPipeline.get(p.name);
				if (!cwds) return false;
				return [...cwds].some((c) => !errorPipelineRoots.has(c));
			}).length;

			// Delete cue.yaml (and clean up prompts + .maestro/) for any root whose
			// last pipeline was removed this save, in parallel. Deleting the file is
			// the correct behaviour - writing an empty YAML left a stale
			// .maestro/cue.yaml on disk that confused users and the engine. Roots
			// still referenced by error-node pipelines are preserved: the pipeline
			// exists in the editor and becomes writable once the user fixes the
			// unresolved agent references.
			const rootsToClear = [...previousRoots].filter(
				(root) => !currentRoots.has(root) && !errorPipelineRoots.has(root)
			);
			await Promise.all(
				rootsToClear.map(async (root) => {
					await cueService.deleteYaml(root);
					// Verify the file is gone so a silent IPC failure surfaces as an
					// error instead of a ghost pipeline reappearing on next launch.
					const onDisk = await cueService.readYaml(root);
					if (onDisk !== null) {
						throw new Error(
							`deleteYaml of "${root}" did not remove the file - cue.yaml still present on disk`
						);
					}
				})
			);
			rootsCleared = rootsToClear.length;
			// A deleted cue.yaml is unambiguously a content change for that root,
			// so its session must refresh to tear down the removed subscriptions.
			for (const root of rootsToClear) changedRoots.add(root);

			// Refresh every session whose project root was touched so the engine
			// reloads the freshly written YAML, in parallel. Under the
			// per-agent-cwd model each session reads only its OWN cwd's cue.yaml,
			// so an exact-match check is sufficient - there is no longer an
			// ancestor-walk fallback that would force descendant sessions to
			// refresh too. Each refresh tears down and re-arms that session's
			// trigger sources independently, so dispatching them together avoids
			// stacking one IPC round trip per session.
			await Promise.all(
				sessions.map(async (session) => {
					if (!session.projectRoot) return;
					if (!touchedRoots.has(session.projectRoot)) return;
					// Skip the refresh when this root's content didn't change. This
					// is the layout-only guard: moving nodes around re-emits
					// byte-identical YAML, so writeYaml reported changed=false and we
					// must NOT re-arm the session's triggers (which re-executes the
					// pipeline). Real content edits still land here.
					if (!changedRoots.has(session.projectRoot)) return;
					cueDebugLog('save:refreshSession', {
						sessionId: session.id,
						sessionName: session.name,
						projectRoot: session.projectRoot,
					});
					await cueService.refreshSession(session.id, session.projectRoot);
				})
			);

			// Refs MUST update before setIsDirty(false) - the dirty-tracking
			// effect compares against savedStateRef.current, so flipping dirty
			// false before the ref is fresh would immediately flip it back true.
			savedStateRef.current = JSON.stringify(validPipelines);
			// Preserve error-pipeline roots alongside current roots so the NEXT
			// save's previousRoots still covers them. Without this, deleting an
			// error-node pipeline after a partial save orphans its YAML: the root
			// drops out of previousRoots and the cleanup loop never deletes it.
			lastWrittenRootsRef.current = new Set([...currentRoots, ...errorPipelineRoots]);
			setIsDirty(false);

			// Nothing was written and nothing was cleared - happens when all
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
			// status flash - "didn't save" used to happen when the 2-second
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
		} finally {
			useCueDirtyStore.getState().setPipelineSaving(false);
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
			// Both agent and command nodes contribute roots - see handleSave's
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
