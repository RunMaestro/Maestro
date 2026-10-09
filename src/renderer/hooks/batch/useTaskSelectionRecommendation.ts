/**
 * useTaskSelectionRecommendation Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage the Task/Document
 * fresh-context recommendation engine for Spec-Driven Auto Run.
 *
 * This hook encapsulates:
 * - Resolving the active agent's effective context window
 * - Computing the tasks-per-document threshold that scales with it
 * - Recommending Task vs Document mode based on average tasks per selected doc
 * - Auto-applying the recommendation (unless a playbook owns the mode, or the
 *   user has manually overridden it)
 * - The sticky manual-override flag and its warning copy
 *
 * Dependencies:
 * - documents / taskCounts: to compute the average tasks per selected doc
 * - activeSession: to resolve the agent's context window
 * - loadedPlaybook: a loaded playbook owns the mode, so auto-apply is skipped
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { Session, Playbook, BatchDocumentEntry, TaskSelectionMode } from '../../types';
import { resolveEffectiveContextWindow } from '../../utils/contextWindowResolver';
import { getModelContextWindowOverride } from '../../../shared/agentConstants';
import { formatTokens } from '../../../shared/formatters';

// Tasks-per-document threshold that flips the recommendation between
// Document mode (below the threshold - share context) and Task mode
// (at/above - fresh context per task). Scales linearly with the agent's
// resolved context window so wider windows can absorb more tasks before
// the recommendation tips over. Reference anchors: 256K → 5, 512K → 10,
// 1M → 20. Floors at 5 so tiny windows still get a sensible default.
function computeTasksPerDocThreshold(contextWindow: number): number {
	if (!contextWindow || contextWindow <= 0) return 5;
	return Math.max(5, Math.round((contextWindow / 256_000) * 5));
}

export interface UseTaskSelectionRecommendationDeps {
	documents: BatchDocumentEntry[];
	taskCounts: Record<string, number>;
	activeSession: Session | undefined;
	loadedPlaybook: Playbook | null;
	/**
	 * Controlled from the caller (currently BatchRunnerModal, still declared
	 * alongside `documents`/`loopEnabled` since usePlaybookManagement's config
	 * needs the current value before this hook runs). This hook only computes
	 * the recommendation and calls the setter - it does not own the state,
	 * since usePlaybookManagement needs `taskSelectionMode` and this hook needs
	 * usePlaybookManagement's `loadedPlaybook` output, so neither can own the
	 * other's dependency without a circular call-order problem.
	 */
	taskSelectionMode: TaskSelectionMode;
	setTaskSelectionMode: React.Dispatch<React.SetStateAction<TaskSelectionMode>>;
	initialTaskSelectionModeRef: React.MutableRefObject<TaskSelectionMode>;
}

export interface UseTaskSelectionRecommendationReturn {
	/** Wrapped setter for a manual user toggle - flips the sticky override flag. */
	handleTaskSelectionModeChange: (mode: TaskSelectionMode) => void;
	showRecommendationWarning: boolean;
	recommendationExplanation: string | null;
	queueItemNoun: string;
}

/**
 * Hook for managing the Task/Document fresh-context recommendation engine
 * in BatchRunnerModal.
 */
export function useTaskSelectionRecommendation({
	documents,
	taskCounts,
	activeSession,
	loadedPlaybook,
	taskSelectionMode,
	setTaskSelectionMode,
	initialTaskSelectionModeRef,
}: UseTaskSelectionRecommendationDeps): UseTaskSelectionRecommendationReturn {
	// Set true when the user explicitly clicks the toggle. Sticky: once the
	// user has expressed a preference we stop auto-applying recommendations and
	// instead surface a warning if the recommendation disagrees.
	const [userOverrodeMode, setUserOverrodeMode] = useState(false);
	// Resolved context window for the active agent. Drives the tasks/doc
	// threshold that recommendedMode uses. Null until the resolver finishes
	// (or there's no active session) - recommendations wait for it.
	const [effectiveContextWindow, setEffectiveContextWindow] = useState<number | null>(null);

	// Resolve the active agent's context window the first time the modal opens on
	// a blank config (no loaded playbook). The resolved window drives the
	// task-count recommendation's scaling threshold; the Task/Document choice
	// itself is owned by that recommendation (see the auto-apply effect below),
	// not a raw window-size cutoff.
	const autoModeAppliedRef = useRef(false);
	useEffect(() => {
		if (autoModeAppliedRef.current) return;
		// A playbook supplies its own mode - don't second-guess it.
		if (loadedPlaybook) {
			autoModeAppliedRef.current = true;
			return;
		}
		if (!activeSession) return;

		let active = true;
		(async () => {
			const configured = await resolveEffectiveContextWindow(activeSession);
			// Also honor a window the agent reported at runtime (e.g. Claude's 1M
			// beta) even when the configured value was left at the default.
			const reported = activeSession.aiTabs.reduce(
				(max, tab) => Math.max(max, tab.usageStats?.contextWindow ?? 0),
				0
			);
			// Honor a per-tab `[1m]` model selection before any usage is reported;
			// the resolver already covers session- and agent-level model overrides.
			const tabModelWindow = activeSession.aiTabs.reduce(
				(max, tab) => Math.max(max, getModelContextWindowOverride(tab.customModel) ?? 0),
				0
			);
			const contextWindow = Math.max(configured, reported, tabModelWindow);
			if (!active) return;
			// Expose the resolved window so the task-count recommendation can
			// scale its tasks/doc threshold (5 at 256K → 20 at 1M).
			setEffectiveContextWindow(contextWindow);
			autoModeAppliedRef.current = true;
		})();
		return () => {
			active = false;
		};
	}, [activeSession, loadedPlaybook]);

	// Recommend a fresh-context mode based on average tasks per selected doc,
	// using a threshold that scales with the agent's resolved context window.
	// Small docs benefit from a shared agent across tasks (less spawn overhead,
	// no repeated context priming); large docs do better with a fresh context
	// per task so tool output from earlier tasks doesn't crowd later ones.
	const tasksPerDocThreshold = useMemo(
		() =>
			effectiveContextWindow === null ? null : computeTasksPerDocThreshold(effectiveContextWindow),
		[effectiveContextWindow]
	);
	const recommendation = useMemo<{
		mode: TaskSelectionMode;
		averageTasks: number;
		docCount: number;
		threshold: number;
	} | null>(() => {
		// Wait for the context window resolver - its value drives the threshold.
		if (tasksPerDocThreshold === null) return null;
		const validDocs = documents.filter((d) => !d.isMissing);
		if (validDocs.length === 0) return null;
		// Wait until at least one selected doc has a task count loaded -
		// recommending against zeros would lock us into 'document' on first paint.
		const knownCounts = validDocs
			.map((d) => taskCounts[d.filename])
			.filter((n): n is number => typeof n === 'number');
		if (knownCounts.length === 0) return null;
		const averageTasks = knownCounts.reduce((a, b) => a + b, 0) / knownCounts.length;
		return {
			mode: averageTasks < tasksPerDocThreshold ? 'document' : 'task',
			averageTasks,
			docCount: validDocs.length,
			threshold: tasksPerDocThreshold,
		};
	}, [documents, taskCounts, tasksPerDocThreshold]);
	const recommendedMode = recommendation?.mode ?? null;

	// Auto-apply the task-count recommendation when documents/counts change.
	// Skips if a playbook is loaded (it owns the mode) or the user has
	// manually overridden - once they've picked, we respect it and warn
	// instead of fighting them.
	useEffect(() => {
		if (userOverrodeMode) return;
		if (loadedPlaybook) return;
		if (recommendedMode === null) return;
		if (recommendedMode === taskSelectionMode) return;
		setTaskSelectionMode(recommendedMode);
		// Keep the dirty check honest: an automatic mode shift shouldn't
		// mark the form as having unsaved changes.
		initialTaskSelectionModeRef.current = recommendedMode;
	}, [recommendedMode, loadedPlaybook, userOverrodeMode, taskSelectionMode]);

	// Wrapped setter for the toggle: any manual click flips the override flag
	// so future doc-selection changes don't yank the mode back.
	const handleTaskSelectionModeChange = useCallback((mode: TaskSelectionMode) => {
		setUserOverrodeMode(true);
		setTaskSelectionMode(mode);
	}, []);

	const showRecommendationWarning =
		userOverrodeMode && recommendedMode !== null && recommendedMode !== taskSelectionMode;

	// Noun for the "sent to the AI agent for each ___ in the queue" helper text.
	// `taskSelectionMode` always holds a concrete value ('task' default), but a
	// real selection only exists once the user clicks the toggle OR the
	// auto-recommendation resolves from actual doc/task counts. Until then the
	// value is just the un-vetted default, so show the combined "task/document".
	const hasSelectedMode = userOverrodeMode || recommendedMode !== null;
	const queueItemNoun = !hasSelectedMode
		? 'task/document'
		: taskSelectionMode === 'document'
			? 'document'
			: 'task';

	// Human-readable explanation of the dynamic mode choice: average task count
	// across selected docs + the resolved context window + the threshold that
	// scales with it. Drives the copy shown above the Task/Document toggle.
	const recommendationExplanation = useMemo<string | null>(() => {
		if (recommendation === null || effectiveContextWindow === null) return null;
		const { averageTasks, docCount, threshold, mode } = recommendation;
		const avgLabel = Number.isInteger(averageTasks) ? `${averageTasks}` : averageTasks.toFixed(1);
		const docLabel = docCount === 1 ? '1 document' : `${docCount} documents`;
		const taskLabel = avgLabel === '1' ? '1 task' : `${avgLabel} tasks`;
		const windowLabel = formatTokens(effectiveContextWindow);
		const recommendedLabel = mode === 'task' ? 'Task' : 'Document';
		const reason =
			mode === 'task'
				? `that's at or above the ${threshold}-task cutoff for a ${windowLabel} context window, so a clean context per task avoids crowding the window`
				: `that's under the ${threshold}-task cutoff for a ${windowLabel} context window, so one shared session can hold the whole document`;
		if (showRecommendationWarning) {
			const currentLabel = taskSelectionMode === 'task' ? 'Task' : 'Document';
			return `Heads up: your ${docLabel} average ${taskLabel} each; ${reason}, so ${recommendedLabel} is the better fit. You've chosen ${currentLabel} - if you know what you're doing, go for it.`;
		}
		return `Your ${docLabel} average ${taskLabel} each - ${reason}. Defaulted to ${recommendedLabel}.`;
	}, [recommendation, effectiveContextWindow, showRecommendationWarning, taskSelectionMode]);

	return {
		handleTaskSelectionModeChange,
		showRecommendationWarning,
		recommendationExplanation,
		queueItemNoun,
	};
}
