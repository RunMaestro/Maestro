/**
 * Module-level registry of "pending edit" flush callbacks used by the pipeline
 * editor to reconcile debounced local state with the shared pipelineState
 * before a save.
 *
 * Why: Config panels (AgentConfigPanel, CommandConfigPanel) debounce their
 * writes into pipelineState to avoid re-rendering the whole graph on every
 * keystroke. Clicking Save within the debounce window would otherwise read
 * stale pipelineState and persist an invalid YAML (missing prompts) that the
 * loader rejects on next open — the user-visible "pipeline vanished after
 * save" symptom. Each panel registers a flush callback; handleSave calls
 * flushAllPendingEdits() before validating/writing.
 */

const pending = new Set<() => void>();

export function registerPendingEdit(flushFn: () => void): () => void {
	pending.add(flushFn);
	return () => {
		pending.delete(flushFn);
	};
}

export function flushAllPendingEdits(): void {
	for (const fn of pending) {
		fn();
	}
}

/** Test-only: wipe the registry between test cases. */
export function __resetPendingEditsRegistryForTests(): void {
	pending.clear();
}
